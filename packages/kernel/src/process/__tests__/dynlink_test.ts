import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  DEFAULT_SEARCH_PATH,
  DylinkParseError,
  findDylink0Section,
  HandleTable,
  type LoadedSideModule,
  loadSideModule,
  lookupSymbol,
  type MainModuleAccess,
  parseDylink0,
  resolveSearchPath,
  RTLD_GLOBAL,
  RTLD_NOW,
  sonameFromPath,
} from "../dynlink.ts";

// ── dylink.0 byte-stream helpers (mirror the Rust tests in
// abi/toolchain/yurt-wasi-postlink/src/side_module.rs so the two
// implementations stay byte-compatible). ─────────────────────────────

function writeVaruint32(buf: number[], v: number): void {
  while (true) {
    let b = v & 0x7f;
    v >>>= 7;
    if (v === 0) {
      buf.push(b);
      return;
    }
    b |= 0x80;
    buf.push(b);
  }
}

function writeStr(buf: number[], s: string): void {
  const bytes = new TextEncoder().encode(s);
  writeVaruint32(buf, bytes.length);
  for (const b of bytes) buf.push(b);
}

function makeSubsection(kind: number, payload: number[]): number[] {
  const out: number[] = [kind];
  writeVaruint32(out, payload.length);
  out.push(...payload);
  return out;
}

function makeMemInfo(
  memSize: number,
  memAlign: number,
  tableSize: number,
  tableAlign: number,
): number[] {
  const payload: number[] = [];
  writeVaruint32(payload, memSize);
  writeVaruint32(payload, memAlign);
  writeVaruint32(payload, tableSize);
  writeVaruint32(payload, tableAlign);
  return makeSubsection(1, payload);
}

function makeNeeded(deps: string[]): number[] {
  const payload: number[] = [];
  writeVaruint32(payload, deps.length);
  for (const d of deps) writeStr(payload, d);
  return makeSubsection(2, payload);
}

describe("parseDylink0", () => {
  it("parses mem_info and needed", () => {
    const bytes = new Uint8Array([
      ...makeMemInfo(1024, 4, 8, 0),
      ...makeNeeded(["libc.wasm", "libm.wasm"]),
    ]);
    const info = parseDylink0(bytes);
    expect(info.memSize).toBe(1024);
    expect(info.memAlign).toBe(4);
    expect(info.tableSize).toBe(8);
    expect(info.tableAlign).toBe(0);
    expect(info.needed).toEqual(["libc.wasm", "libm.wasm"]);
  });

  it("skips unknown subsections but honours their declared length", () => {
    const bytes = new Uint8Array([
      ...makeSubsection(99, [0xde, 0xad, 0xbe]),
      ...makeMemInfo(16, 0, 0, 0),
    ]);
    const info = parseDylink0(bytes);
    expect(info.memSize).toBe(16);
  });

  it("rejects truncated subsections", () => {
    const bytes = new Uint8Array([1, 10, 0x01, 0x02]);
    expect(() => parseDylink0(bytes)).toThrow(DylinkParseError);
  });

  it("rejects trailing bytes inside mem_info", () => {
    const payload: number[] = [];
    writeVaruint32(payload, 1);
    writeVaruint32(payload, 2);
    writeVaruint32(payload, 3);
    writeVaruint32(payload, 4);
    payload.push(0xff);
    const bytes = new Uint8Array(makeSubsection(1, payload));
    expect(() => parseDylink0(bytes)).toThrow(/trailing/);
  });

  it("rejects truncated LEB128", () => {
    // 0xff has the continuation bit set; the buffer ends.
    const bytes = new Uint8Array([1, 1, 0xff]);
    expect(() => parseDylink0(bytes)).toThrow(/LEB128|truncated/);
  });
});

describe("findDylink0Section", () => {
  function makeWasmHeader(): number[] {
    return [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  }

  function makeCustomSection(name: string, body: number[]): number[] {
    const nameBytes = new TextEncoder().encode(name);
    const inner: number[] = [];
    writeVaruint32(inner, nameBytes.length);
    for (const b of nameBytes) inner.push(b);
    inner.push(...body);
    const out: number[] = [0]; // section id 0 = custom
    writeVaruint32(out, inner.length);
    out.push(...inner);
    return out;
  }

  it("returns the dylink.0 payload when present", () => {
    const dylink = makeMemInfo(64, 4, 0, 0);
    const wasm = new Uint8Array([
      ...makeWasmHeader(),
      ...makeCustomSection("dylink.0", dylink),
    ]);
    const found = findDylink0Section(wasm);
    expect(found).not.toBeNull();
    expect(Array.from(found!)).toEqual(dylink);
  });

  it("skips other custom sections", () => {
    const wasm = new Uint8Array([
      ...makeWasmHeader(),
      ...makeCustomSection("name", [0x00]),
      ...makeCustomSection("dylink.0", makeMemInfo(8, 0, 0, 0)),
    ]);
    expect(findDylink0Section(wasm)).not.toBeNull();
  });

  it("returns null when no dylink.0 section is present", () => {
    const wasm = new Uint8Array(makeWasmHeader());
    expect(findDylink0Section(wasm)).toBeNull();
  });

  it("rejects non-wasm input", () => {
    const wasm = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0]);
    expect(() => findDylink0Section(wasm)).toThrow(/wasm/);
  });
});

describe("sonameFromPath", () => {
  it("strips lib prefix and .wasm suffix", () => {
    expect(sonameFromPath("/lib/libfoo.wasm")).toBe("foo");
    expect(sonameFromPath("libyurt_sched.wasm")).toBe("yurt_sched");
    expect(sonameFromPath("bar.wasm")).toBe("bar");
    expect(sonameFromPath("plain")).toBe("plain");
  });
});

describe("HandleTable", () => {
  function makeLoaded(canonicalPath: string, soname = "x"): LoadedSideModule {
    return {
      soname,
      canonicalPath,
      instance: { exports: {} } as unknown as WebAssembly.Instance,
      global: false,
      tableBase: 0,
      memoryBase: 0,
      funcTableIndex: new Map(),
    };
  }

  it("issues distinct handles for distinct paths", () => {
    const t = new HandleTable();
    const h1 = t.insert(makeLoaded("/lib/a.wasm"));
    const h2 = t.insert(makeLoaded("/lib/b.wasm"));
    expect(h1).not.toBe(h2);
    expect(h1).toBeGreaterThan(0);
    expect(h2).toBeGreaterThan(0);
  });

  it("acquireExisting returns the same handle and bumps refcount", () => {
    const t = new HandleTable();
    const h = t.insert(makeLoaded("/lib/a.wasm"));
    const again = t.acquireExisting("/lib/a.wasm");
    expect(again).toBe(h);
  });

  it("release decrements refcount and only drops on zero", () => {
    const t = new HandleTable();
    const h = t.insert(makeLoaded("/lib/a.wasm"));
    // After insert: refcount = 1.
    t.acquireExisting("/lib/a.wasm"); // refcount = 2.
    expect(t.release(h)).toBe(0);
    // Still alive.
    expect(t.get(h)).toBeDefined();
    expect(t.release(h)).toBe(0);
    // Now dropped.
    expect(t.get(h)).toBeUndefined();
  });

  it("release of an unknown handle returns -1", () => {
    const t = new HandleTable();
    expect(t.release(999)).toBe(-1);
  });

  it("resolveGlobal walks only RTLD_GLOBAL handles", () => {
    const t = new HandleTable();
    const localOnly = makeLoaded("/lib/local.wasm");
    localOnly.instance = {
      exports: { sym_local: () => 1 },
    } as unknown as WebAssembly.Instance;
    const global = makeLoaded("/lib/global.wasm");
    global.global = true;
    global.instance = {
      exports: { sym_global: () => 2 },
    } as unknown as WebAssembly.Instance;
    void RTLD_GLOBAL;
    t.insert(localOnly);
    t.insert(global);
    expect(t.resolveGlobal("sym_global")).toBeDefined();
    expect(t.resolveGlobal("sym_local")).toBeUndefined();
  });
});

describe("resolveSearchPath", () => {
  function vfsWith(files: Record<string, Uint8Array>) {
    return {
      readFile(path: string) {
        const bytes = files[path];
        if (!bytes) return undefined;
        return { bytes, canonicalPath: path };
      },
    };
  }

  it("returns absolute paths directly without searching", () => {
    const vfs = vfsWith({ "/lib/a.wasm": new Uint8Array([1, 2]) });
    const got = resolveSearchPath("/lib/a.wasm", vfs);
    expect(got?.bytes).toEqual(new Uint8Array([1, 2]));
  });

  it("returns undefined for an absolute path that does not exist", () => {
    const vfs = vfsWith({});
    expect(resolveSearchPath("/lib/missing.wasm", vfs)).toBeUndefined();
  });

  it("walks the default search path for relative names", () => {
    const vfs = vfsWith({ "/usr/lib/foo.wasm": new Uint8Array([7]) });
    const got = resolveSearchPath("foo.wasm", vfs);
    expect(got?.bytes).toEqual(new Uint8Array([7]));
    expect(got?.canonicalPath).toBe("/usr/lib/foo.wasm");
  });

  it("respects a custom search-path override", () => {
    const vfs = vfsWith({ "/opt/libs/bar.wasm": new Uint8Array([9]) });
    expect(resolveSearchPath("bar.wasm", vfs)).toBeUndefined();
    expect(resolveSearchPath("bar.wasm", vfs, ["/opt/libs"])).toBeDefined();
  });

  it("default search path is /usr/local/lib, /lib, /usr/lib in order", () => {
    expect([...DEFAULT_SEARCH_PATH]).toEqual([
      "/usr/local/lib",
      "/lib",
      "/usr/lib",
    ]);
  });
});

// End-to-end loader test using the real `libyurt_dlcanary.wasm` fixture
// produced by `make -C abi all copy-fixtures`. Validates the three
// behaviors that broke the Phase 1 happy path before being fixed:
//   - env.* imports the side module declares (e.g. __wasi_init_tp,
//     normally backed by libc.so) are satisfied from the main module's
//     exports rather than failing instantiation.
//   - Function exports get a slot in __indirect_function_table even
//     when wasm-ld --shared did not place them there (the common case
//     for non-address-taken exports).
//   - dlopen of an unresolvable NEEDED dep (like libc.so on a system
//     where it's statically linked into the main module) does not throw.
const FIXTURE_PATH = resolvePath(
  import.meta.dirname!,
  "../../platform/__tests__/fixtures/libyurt_dlcanary.wasm",
);
const HAS_FIXTURE = existsSync(FIXTURE_PATH);
const fixtureIt = HAS_FIXTURE ? it : it.skip;

describe("loadSideModule (real wasm-ld --shared fixture)", () => {
  fixtureIt(
    "loads libyurt_dlcanary.wasm and dlsym resolves yurt_dlcanary_double",
    () => {
      const sideBytes = readFileSync(FIXTURE_PATH);

      // Build a minimal main-module surrogate that exports the wasi-libc
      // internals the side module imports as `env.*`. In the real loader
      // these come from the main module's instance.exports.
      const mainMemory = new WebAssembly.Memory({ initial: 2 });
      const mainTable = new WebAssembly.Table({
        element: "anyfunc",
        initial: 0,
      });
      const mainStackPointer = new WebAssembly.Global(
        { value: "i32", mutable: true },
        65536,
      );
      const fakeMainExports: Record<string, WebAssembly.ExportValue> = {
        memory: mainMemory,
        __indirect_function_table: mainTable,
        __wasi_init_tp: (() => {}) as unknown as Function,
        __stack_pointer: mainStackPointer,
        __alloc: ((_n: number) => 0) as unknown as Function,
      };
      const main: MainModuleAccess = {
        memory: mainMemory,
        table: mainTable,
        alloc: (_n: number) => 0,
        instance: {
          exports: fakeMainExports,
        } as unknown as WebAssembly.Instance,
      };

      const handles = new HandleTable();
      const handle = loadSideModule(
        "/lib/libyurt_dlcanary.wasm",
        handles,
        {
          flags: RTLD_NOW,
          vfs: {
            readFile(p) {
              if (p === "/lib/libyurt_dlcanary.wasm") {
                return { bytes: sideBytes, canonicalPath: p };
              }
              return undefined;
            },
          },
          yurtImports: {},
          mainAccess: () => main,
        },
      );
      expect(handle).toBeGreaterThan(0);

      const loaded = handles.get(handle);
      expect(loaded).toBeDefined();

      const idx = lookupSymbol(loaded!, "yurt_dlcanary_double");
      expect(idx).toBeGreaterThanOrEqual(0);

      const fn = mainTable.get(idx) as ((x: number) => number) | null;
      expect(typeof fn).toBe("function");
      expect(fn!(21)).toBe(42);
    },
  );

  fixtureIt(
    "double-dlopen returns same handle and refcount keeps it alive",
    () => {
      const sideBytes = readFileSync(FIXTURE_PATH);
      const mainMemory = new WebAssembly.Memory({ initial: 2 });
      const mainTable = new WebAssembly.Table({
        element: "anyfunc",
        initial: 0,
      });
      const main: MainModuleAccess = {
        memory: mainMemory,
        table: mainTable,
        alloc: (_n: number) => 0,
        instance: {
          exports: {
            memory: mainMemory,
            __indirect_function_table: mainTable,
            __wasi_init_tp: (() => {}) as unknown as Function,
            __stack_pointer: new WebAssembly.Global(
              { value: "i32", mutable: true },
              65536,
            ),
          },
        } as unknown as WebAssembly.Instance,
      };
      const handles = new HandleTable();
      const opts = {
        flags: RTLD_NOW,
        vfs: {
          readFile(p: string) {
            return p === "/lib/libyurt_dlcanary.wasm"
              ? { bytes: sideBytes, canonicalPath: p }
              : undefined;
          },
        },
        yurtImports: {},
        mainAccess: () => main,
      };
      const h1 = loadSideModule("/lib/libyurt_dlcanary.wasm", handles, opts);
      const h2 = loadSideModule("/lib/libyurt_dlcanary.wasm", handles, opts);
      expect(h2).toBe(h1);
      expect(handles.release(h1)).toBe(0);
      // Still alive (refcount went 2 → 1).
      expect(handles.get(h1)).toBeDefined();
      expect(handles.release(h1)).toBe(0);
      expect(handles.get(h1)).toBeUndefined();
    },
  );
});
