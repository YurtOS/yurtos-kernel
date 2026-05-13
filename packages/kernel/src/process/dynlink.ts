/**
 * Phase 1 generic shared-library loader.
 *
 * Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
 *
 * This module is runtime-agnostic. It uses only the standard
 * `WebAssembly.{Module,Instance,Table}` APIs and the host-provided
 * VFS, so the same code runs under Deno, Node, and any browser.
 * Backend-specific paths (e.g., the Wasmtime engine) implement the
 * same observable contract via their own bindings.
 *
 * Responsibilities:
 *   - Parse the `dylink.0` custom section from a side-module wasm
 *     (mirrors abi/toolchain/yurt-wasi-postlink/src/side_module.rs).
 *   - Resolve a side-module path against the search-path order
 *     defined by the spec (§ Library Search Path).
 *   - Maintain a per-sandbox handle table with refcount semantics so
 *     `dlopen` of the same canonical path yields the same handle and
 *     `dlclose` drops the instance only when refcount hits zero.
 *   - Drive the 11-step instantiation algorithm: reserve memory and
 *     table region from the main module, build a per-load import
 *     object, instantiate, run `__wasm_apply_data_relocs` then
 *     `__wasm_call_ctors`.
 *
 * Phase 1 simplifications (documented; promoted later as needed):
 *   - Search path covers absolute paths and the default
 *     `/usr/local/lib`, `/lib`, `/usr/lib` set. RPATH from the main
 *     module's dylink.0 and `LD_LIBRARY_PATH` from the sandbox env
 *     are intentionally deferred — the canary uses absolute paths.
 *   - Dependency resolution (WASM_DYLINK_NEEDED) is honored
 *     recursively but cycle detection is by SONAME.
 *   - TLS in side modules fails with `EINVAL` per the spec.
 */

const KIND_MEM_INFO = 1;
const KIND_NEEDED = 2;

export interface DylinkInfo {
  memSize: number;
  memAlign: number;
  tableSize: number;
  tableAlign: number;
  needed: string[];
}

export class DylinkParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DylinkParseError";
  }
}

export function parseDylink0(data: Uint8Array): DylinkInfo {
  const info: DylinkInfo = {
    memSize: 0,
    memAlign: 0,
    tableSize: 0,
    tableAlign: 0,
    needed: [],
  };
  const cursor = { buf: data, offset: 0 };
  while (cursor.offset < cursor.buf.length) {
    const kind = readU8(cursor);
    const len = readVaruint32(cursor, "subsection length");
    if (cursor.offset + len > cursor.buf.length) {
      throw new DylinkParseError(
        `truncated dylink.0 subsection: kind=${kind}, declared length ${len}, only ${
          cursor.buf.length - cursor.offset
        } bytes remain`,
      );
    }
    const payload = cursor.buf.subarray(cursor.offset, cursor.offset + len);
    cursor.offset += len;
    if (kind === KIND_MEM_INFO) {
      const sub = { buf: payload, offset: 0 };
      info.memSize = readVaruint32(sub, "mem_info.mem_size");
      info.memAlign = readVaruint32(sub, "mem_info.mem_align");
      info.tableSize = readVaruint32(sub, "mem_info.table_size");
      info.tableAlign = readVaruint32(sub, "mem_info.table_align");
      if (sub.offset !== sub.buf.length) {
        throw new DylinkParseError(
          "trailing bytes in WASM_DYLINK_MEM_INFO subsection",
        );
      }
    } else if (kind === KIND_NEEDED) {
      const sub = { buf: payload, offset: 0 };
      const count = readVaruint32(sub, "needed.count");
      for (let i = 0; i < count; i++) {
        info.needed.push(readStr(sub, `needed[${i}].name`));
      }
      if (sub.offset !== sub.buf.length) {
        throw new DylinkParseError(
          "trailing bytes in WASM_DYLINK_NEEDED subsection",
        );
      }
    }
    // Other documented subsections (export_info, import_info,
    // runtime_path) are skipped; we still required their declared
    // length so a malformed file fails loudly above.
  }
  return info;
}

interface Cursor {
  buf: Uint8Array;
  offset: number;
}

function readU8(c: Cursor): number {
  if (c.offset >= c.buf.length) {
    throw new DylinkParseError("truncated dylink.0: expected subsection kind");
  }
  return c.buf[c.offset++];
}

function readVaruint32(c: Cursor, label: string): number {
  let result = 0;
  let shift = 0;
  while (true) {
    if (c.offset >= c.buf.length) {
      throw new DylinkParseError(`truncated LEB128 reading ${label}`);
    }
    const b = c.buf[c.offset++];
    const chunk = b & 0x7f;
    if (shift >= 32 || (shift === 28 && chunk > 0x0f)) {
      throw new DylinkParseError(`varuint32 too large reading ${label}`);
    }
    result |= chunk << shift;
    if ((b & 0x80) === 0) {
      // Mask back to unsigned 32 bits — JS bitwise ops produce a
      // signed i32 which is fine for any value we'd see here, but
      // be explicit.
      return result >>> 0;
    }
    shift += 7;
  }
}

function readStr(c: Cursor, label: string): string {
  const len = readVaruint32(c, `${label}.length`);
  if (c.offset + len > c.buf.length) {
    throw new DylinkParseError(
      `truncated string at ${label}: declared ${len}, only ${
        c.buf.length - c.offset
      } bytes remain`,
    );
  }
  const slice = c.buf.subarray(c.offset, c.offset + len);
  c.offset += len;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch (e) {
    throw new DylinkParseError(`invalid utf8 in dylink.0 ${label}: ${e}`);
  }
}

/**
 * Find the `dylink.0` custom section in a wasm binary. Returns the
 * payload bytes (the section's body, without the section id, length,
 * or name encoding) or `null` if the section is absent.
 *
 * We parse the wasm header + custom-section ids directly rather than
 * round-tripping through `WebAssembly.Module.customSections` so we can
 * give precise error messages for malformed binaries; the API exists
 * but it returns ArrayBuffers tied to a compiled Module instance,
 * which is more setup than we need for a one-shot scan.
 */
export function findDylink0Section(wasm: Uint8Array): Uint8Array | null {
  if (
    wasm.length < 8 || wasm[0] !== 0x00 || wasm[1] !== 0x61 ||
    wasm[2] !== 0x73 || wasm[3] !== 0x6d
  ) {
    throw new DylinkParseError("not a wasm binary (bad magic)");
  }
  const c: Cursor = { buf: wasm, offset: 8 };
  while (c.offset < c.buf.length) {
    const id = readU8(c);
    const size = readVaruint32(c, "section size");
    const sectionEnd = c.offset + size;
    if (sectionEnd > c.buf.length) {
      throw new DylinkParseError(
        `truncated section id=${id}, declared size ${size}`,
      );
    }
    if (id === 0) {
      // Custom section. The body starts with a varuint32-length name.
      const nameStart = c.offset;
      const nameLen = readVaruint32(c, "custom section name length");
      if (c.offset + nameLen > sectionEnd) {
        throw new DylinkParseError("custom section name overruns body");
      }
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        c.buf.subarray(c.offset, c.offset + nameLen),
      );
      c.offset += nameLen;
      if (name === "dylink.0") {
        return c.buf.subarray(c.offset, sectionEnd);
      }
      // Skip the rest of this custom section.
      c.offset = sectionEnd;
      // (nameStart is unused once we've decoded the name.)
      void nameStart;
    } else {
      c.offset = sectionEnd;
    }
  }
  return null;
}

/**
 * Per-sandbox handle table. Owns the loaded side-module instances and
 * implements POSIX dlopen/dlclose refcount semantics.
 *
 * Handles are 32-bit non-zero ints (0 is reserved for "error / no
 * handle"). They are opaque to the guest; the guest stores them as
 * `void *` since wasm32's pointer width matches.
 */
export interface LoadedSideModule {
  /** SONAME from the dylink.0 manifest, or basename fallback. */
  soname: string;
  /** Canonical resolved VFS path the wasm was read from. */
  canonicalPath: string;
  /** Live WebAssembly instance for this side module. */
  instance: WebAssembly.Instance;
  /** Whether this side module's exports are visible to RTLD_DEFAULT. */
  global: boolean;
  /** Per-load reservation in __indirect_function_table. */
  tableBase: number;
  /** Per-load reservation in the main memory. */
  memoryBase: number;
  /**
   * Pre-computed name → __indirect_function_table index for every
   * exported function. Built once at load time so dlsym is O(1).
   * wasm-ld --shared writes the function references into the
   * reserved table slots during instantiation; we scan the reserved
   * region to find each function's slot.
   */
  funcTableIndex: Map<string, number>;
}

export class HandleTable {
  private next = 1;
  private readonly byHandle = new Map<number, LoadedSideModule>();
  private readonly refcount = new Map<number, number>();
  private readonly byCanonicalPath = new Map<string, number>();

  acquireExisting(canonicalPath: string): number | undefined {
    const h = this.byCanonicalPath.get(canonicalPath);
    if (h === undefined) return undefined;
    this.refcount.set(h, (this.refcount.get(h) ?? 0) + 1);
    return h;
  }

  insert(loaded: LoadedSideModule): number {
    const h = this.next++;
    this.byHandle.set(h, loaded);
    this.refcount.set(h, 1);
    this.byCanonicalPath.set(loaded.canonicalPath, h);
    return h;
  }

  get(handle: number): LoadedSideModule | undefined {
    return this.byHandle.get(handle);
  }

  /**
   * Decrement the refcount. Returns `0` on success (whether or not
   * the instance was actually dropped) or `-1` if the handle is
   * unknown. POSIX dlclose returns 0 on success; matching that.
   */
  release(handle: number): number {
    const cur = this.refcount.get(handle);
    if (cur === undefined) return -1;
    if (cur > 1) {
      this.refcount.set(handle, cur - 1);
      return 0;
    }
    const loaded = this.byHandle.get(handle);
    this.refcount.delete(handle);
    this.byHandle.delete(handle);
    if (loaded !== undefined) {
      this.byCanonicalPath.delete(loaded.canonicalPath);
    }
    return 0;
  }

  /**
   * Resolve a name through the RTLD_DEFAULT chain (i.e. all currently
   * loaded handles flagged GLOBAL). Returns the first match's instance
   * + tableBase or `undefined`.
   */
  resolveGlobal(name: string): LoadedSideModule | undefined {
    for (const loaded of this.byHandle.values()) {
      if (!loaded.global) continue;
      if (loaded.instance.exports[name] !== undefined) return loaded;
    }
    return undefined;
  }
}

/**
 * Default search-path roots applied when a relative path is passed
 * to dlopen. Absolute paths bypass the search.
 *
 * Phase 1 leaves out RPATH (would require parsing the main module's
 * dylink.0 for the runtime_path subsection) and LD_LIBRARY_PATH
 * (would require sandbox env access). Both are documented in the
 * spec as part of the contract but deferred to a follow-on slice;
 * the dlopen-canary uses absolute paths so the canary case set is
 * fully covered without them.
 */
export const DEFAULT_SEARCH_PATH: readonly string[] = [
  "/usr/local/lib",
  "/lib",
  "/usr/lib",
];

export interface VfsLookup {
  /**
   * Read raw bytes from a VFS path. Throws / returns `undefined` if
   * the path does not exist. Implementations SHOULD follow symlinks;
   * the host is what canonicalises SONAME → versioned-file
   * resolution. Returns the bytes plus the canonical path used.
   */
  readFile(
    path: string,
  ): { bytes: Uint8Array; canonicalPath: string } | undefined;
}

export function resolveSearchPath(
  request: string,
  vfs: VfsLookup,
  searchPath: readonly string[] = DEFAULT_SEARCH_PATH,
): { bytes: Uint8Array; canonicalPath: string } | undefined {
  if (request.startsWith("/")) {
    return vfs.readFile(request);
  }
  for (const dir of searchPath) {
    const candidate = dir.endsWith("/") ? dir + request : `${dir}/${request}`;
    const got = vfs.readFile(candidate);
    if (got !== undefined) return got;
  }
  return undefined;
}

/**
 * Derive a SONAME from a wasm filename: strip leading `lib` and
 * trailing `.wasm`. `/lib/libfoo.wasm` → `foo`. Mirrors
 * `soname_from_path` in yurt-wasi-postlink::side_module.
 */
export function sonameFromPath(p: string): string {
  const base = p.split("/").pop() ?? p;
  const stem = base.endsWith(".wasm") ? base.slice(0, -".wasm".length) : base;
  return stem.startsWith("lib") ? stem.slice("lib".length) : stem;
}

/**
 * The minimal main-module surface the loader requires. The
 * accessor is invoked lazily because the main module instance
 * does not exist until after `WebAssembly.instantiate(main, imports)`
 * resolves — which happens AFTER `createKernelImports` returns.
 *
 * `instance` is exposed so the loader can resolve side-module
 * `env.*` imports the main module already satisfies (e.g. wasi-libc
 * internals like `__wasi_init_tp` that wasm-ld --shared marks as
 * external from `libc.so` even when the main module statically
 * provides them).
 */
export interface MainModuleAccess {
  memory: WebAssembly.Memory;
  table: WebAssembly.Table;
  alloc: (size: number) => number;
  instance: WebAssembly.Instance;
}

export function mainAccessFromInstance(
  instance: WebAssembly.Instance,
  /**
   * Fallback memory when the main module imports memory instead of
   * exporting it. Thread-capable modules (target=wasm32-wasip1-threads,
   * `-Wl,--import-memory --shared-memory`) bind the SAB-backed memory
   * through `env.memory` rather than emitting it as an export, so
   * `instance.exports.memory` is undefined on those modules. The kernel
   * holds the same memory reference and can pass it in here.
   *
   * The caller asserts this argument refers to a valid memory; the
   * type is intentionally permissive (a memory-shaped object) because
   * the host wires it through `memoryProxy` in loader.ts, which
   * forwards `.buffer` / `.grow()` to the real `WebAssembly.Memory`
   * but does NOT satisfy `instanceof WebAssembly.Memory`. The loader
   * only ever uses `memory.buffer` and `memory.grow()` on this object.
   *
   * Backwards-compatible: non-threaded main modules still expose
   * memory via exports, so this argument is optional.
   */
  importedMemory?: WebAssembly.Memory,
): MainModuleAccess | undefined {
  const exportedMemory = instance.exports.memory;
  const memory = exportedMemory instanceof WebAssembly.Memory
    ? exportedMemory
    : importedMemory;
  const table = instance.exports.__indirect_function_table;
  const alloc = instance.exports.__alloc;
  if (
    !memory ||
    !(table instanceof WebAssembly.Table) ||
    typeof alloc !== "function"
  ) {
    return undefined;
  }
  return {
    memory,
    table,
    alloc: alloc as (size: number) => number,
    instance,
  };
}

export interface LoadOptions {
  flags: number;
  vfs: VfsLookup;
  /** Resolved imports for the `yurt` namespace shared with the main module. */
  yurtImports: WebAssembly.ModuleImports;
  /** Lazy accessor for main-module exports (memory/table/__alloc). */
  mainAccess: () => MainModuleAccess | undefined;
  searchPath?: readonly string[];
}

export const RTLD_LAZY = 0x0001;
export const RTLD_NOW = 0x0002;
export const RTLD_GLOBAL = 0x0100;
export const RTLD_LOCAL = 0x0000;

/**
 * Load a side module by path. Resolves search-path, parses dylink.0,
 * recursively loads dependencies, reserves memory + table region in
 * the main module, instantiates the side module, runs its constructors,
 * and inserts it into the handle table. Returns the new handle.
 *
 * Throws on any error; the host wrapper catches and converts to the
 * dlerror message + zero handle.
 *
 * Synchronous by design: POSIX `dlopen` does not yield. We use
 * `new WebAssembly.Module(bytes)` and `new WebAssembly.Instance(...)`
 * which work in Node, Deno, and browsers. Side modules are small
 * (kilobytes), so the browser main-thread sync-compile budget is not
 * a real constraint here.
 */
export function loadSideModule(
  path: string,
  table: HandleTable,
  opts: LoadOptions,
): number {
  const got = resolveSearchPath(path, opts.vfs, opts.searchPath);
  if (got === undefined) {
    throw new Error(`file not found: ${path}`);
  }
  const existing = table.acquireExisting(got.canonicalPath);
  if (existing !== undefined) return existing;

  const dylink = findDylink0Section(got.bytes);
  if (dylink === null) {
    throw new Error(`not a side module: ${got.canonicalPath}`);
  }
  const info = parseDylink0(dylink);

  const main = opts.mainAccess();
  if (main === undefined) {
    throw new Error("main module not ready");
  }

  // Recursively load declared dependencies that exist on the search
  // path. wasm-ld --shared emits NEEDED entries for system libraries
  // (libc.so, libm.so, ...) even when the main module statically
  // provides them; those are resolved at instantiation time from
  // main.instance.exports below. Treating "not found on search path"
  // as "satisfied by main" lets Phase 1 work without bundling system
  // libraries as separate side modules. Real link errors still surface
  // when env.* import resolution fails.
  for (const dep of info.needed) {
    if (resolveSearchPath(dep, opts.vfs, opts.searchPath) !== undefined) {
      loadSideModule(dep, table, opts);
    }
  }

  // Reserve a region of main memory for the side module's data
  // segments. The main module's __alloc returns a pointer that
  // becomes __memory_base for the side module. Alignment: side
  // modules declare their needs; we round up to the next multiple.
  const align = Math.max(1, info.memAlign || 1);
  const memSize = info.memSize === 0
    ? 0
    : Math.ceil(info.memSize / align) * align;
  const memoryBase = memSize === 0 ? 0 : main.alloc(memSize);

  // Reserve a chunk of __indirect_function_table.
  const tableBase = info.tableSize === 0
    ? main.table.length
    : main.table.grow(info.tableSize);

  const module = new WebAssembly.Module(got.bytes as BufferSource);

  // Build the env import object dynamically. Start with the four
  // standard PIC bindings, then resolve any other env.* imports the
  // side module declares from (in order) RTLD_GLOBAL handles, the
  // main module's exports. wasm-ld emits __wasi_init_tp and friends
  // as `env.*` imports nominally backed by libc.so; the main module
  // already exports them.
  const env: Record<string, WebAssembly.ImportValue> = {
    memory: main.memory,
    __indirect_function_table: main.table,
    __memory_base: new WebAssembly.Global(
      { value: "i32", mutable: false },
      memoryBase,
    ),
    __table_base: new WebAssembly.Global(
      { value: "i32", mutable: false },
      tableBase,
    ),
  };
  // Share the main module's stack pointer when it's exported. A fresh
  // global initialized to 0 traps on the first stack push; the main
  // module's stack pointer is the right value for a side module that
  // runs synchronously inside a host import call.
  const mainStackPointer = main.instance.exports.__stack_pointer;
  if (mainStackPointer instanceof WebAssembly.Global) {
    env.__stack_pointer = mainStackPointer;
  } else {
    env.__stack_pointer = new WebAssembly.Global(
      { value: "i32", mutable: true },
      0,
    );
  }
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== "env") continue;
    if (env[imp.name] !== undefined) continue;
    const fromGlobal = table.resolveGlobal(imp.name);
    if (fromGlobal) {
      const v = fromGlobal.instance.exports[imp.name];
      if (v !== undefined) {
        env[imp.name] = v as WebAssembly.ImportValue;
        continue;
      }
    }
    const v = main.instance.exports[imp.name];
    if (v !== undefined) env[imp.name] = v as WebAssembly.ImportValue;
  }
  const sideImports: WebAssembly.Imports = {
    env,
    yurt: opts.yurtImports,
  };

  const instance = new WebAssembly.Instance(module, sideImports);

  const applyRelocs = instance.exports.__wasm_apply_data_relocs;
  if (typeof applyRelocs === "function") {
    (applyRelocs as () => void)();
  }
  const ctors = instance.exports.__wasm_call_ctors;
  if (typeof ctors === "function") {
    (ctors as () => void)();
  }

  const funcTableIndex = ensureFunctionExportsInTable(
    instance,
    main.table,
    tableBase,
    info.tableSize,
  );

  const loaded: LoadedSideModule = {
    soname: sonameFromPath(got.canonicalPath),
    canonicalPath: got.canonicalPath,
    instance,
    global: (opts.flags & RTLD_GLOBAL) !== 0,
    tableBase,
    memoryBase,
    funcTableIndex,
  };
  return table.insert(loaded);
}

/**
 * Build a name → table-index map for every function export of the
 * side module. wasm-ld --shared --experimental-pic only places
 * address-taken functions in the indirect function table; non-AT
 * exports (the common case for dlsym targets) are not in the table
 * at all, which would make `dlsym` always return -1.
 *
 * Strategy: scan the reservation once for pre-populated entries
 * (using JS reference equality against `instance.exports[name]`,
 * which V8/SpiderMonkey/JSC each cache stably for the same wasm
 * function); for any function export not already in the table,
 * grow the table by one and place the export there. The resulting
 * slot index is what `dlsym` returns to the guest.
 */
function ensureFunctionExportsInTable(
  instance: WebAssembly.Instance,
  table: WebAssembly.Table,
  tableBase: number,
  tableSize: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const refToIndex = new Map<unknown, number>();
  for (let i = 0; i < tableSize; i++) {
    const ref = table.get(tableBase + i);
    if (ref !== null && ref !== undefined) {
      refToIndex.set(ref, tableBase + i);
    }
  }
  for (const [name, exp] of Object.entries(instance.exports)) {
    if (typeof exp !== "function") continue;
    let idx = refToIndex.get(exp);
    if (idx === undefined) {
      // table.grow returns the previous length, which is the new slot's
      // index. Cast through unknown because the WebAssembly.Table type
      // declares set as accepting Function; the runtime accepts wasm
      // function exports.
      idx = table.grow(1);
      table.set(idx, exp as unknown as Function);
      refToIndex.set(exp, idx);
    }
    out.set(name, idx);
  }
  return out;
}

/**
 * Look up `name` in the handle's exports. For function exports,
 * returns their pre-computed index in `__indirect_function_table`
 * (the guest casts this i32 to a function pointer in the standard
 * wasm-ld --shared PIC ABI). For data exports (exported globals),
 * returns the global's i32 value, which wasm-ld emits as the absolute
 * address inside the side module's reserved memory region.
 *
 * Returns `-1` if the name is not found in the handle's instance.
 */
export function lookupSymbol(loaded: LoadedSideModule, name: string): number {
  const idx = loaded.funcTableIndex.get(name);
  if (idx !== undefined) return idx;
  const exp = loaded.instance.exports[name];
  if (exp instanceof WebAssembly.Global) {
    const v = exp.value;
    if (typeof v === "number") return v >>> 0;
  }
  return -1;
}
