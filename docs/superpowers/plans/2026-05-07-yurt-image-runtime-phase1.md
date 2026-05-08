# Yurt Image Runtime Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first runnable image-runtime slice: zstd-compressed `.yurtimg` tar images as read-only sandbox bases, ancestor directory whiteouts, argv-native execution, and `yurt <image> [command...]` CLI support.

**Architecture:** Add a focused image loader plus tar index/root provider beside the existing VFS providers. The loader decompresses `.yurtimg` zstd payloads to tar bytes, optionally reuses a decompressed tar cache, then wires `Sandbox.create({ image })` through the same `OverlayVFS` path used by `baseRoot`. Tighten `OverlayVFS` whiteout lookup before layer export work depends on directory deletion semantics. Use the existing `Sandbox.spawn(argv)` process path for argv-native execution and expose a small result-oriented wrapper for CLI use.

**Tech Stack:** TypeScript, Deno tests, Node-compatible filesystem APIs, existing `RootProvider`, `OverlayVFS`, `VFS`, `Sandbox`, and `ProcessManager`.

---

## Scope

This plan intentionally implements only `.yurtimg` zstd load and CLI decompressed-tar cache support. It does not implement `.yurtlayer` export, merged snapshot export, layer merge, signing manifests, OPFS-backed range reads, or browser storage. Those need separate plans after this vertical slice is passing.

## File Structure

- Create `packages/kernel/src/vfs/tar-image-root-provider.ts`: parse tar bytes, build `TarImageIndex`, and implement `RootProvider`.
- Create `packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts`: provider unit tests and tar fixture helpers.
- Modify `packages/kernel/src/vfs/overlay-vfs.ts`: add ancestor-whiteout lookup semantics while preserving upper-layer recreation behavior.
- Modify `packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts`: regression tests for whiteouted lower directories and recreated upper children.
- Create `packages/kernel/src/image-loader.ts`: decompress zstd `.yurtimg` payloads, optionally cache path images as tar, and build the tar index.
- Modify `packages/kernel/src/sandbox.ts`: add `image?: string | Uint8Array`, load `.yurtimg` through `loadYurtImage`, build `TarImageRootProvider`, register image tools, and skip fixture installation for image-backed roots.
- Create `packages/kernel/src/__tests__/sandbox-image_test.ts`: sandbox integration tests for image-backed reads/writes and command execution.
- Modify `packages/kernel/src/cli.ts`: parse `yurt <image> [command...]`, use image-backed sandbox, default to `/bin/sh`, and run argv without shell joining.
- Create `packages/kernel/src/__tests__/cli-image_test.ts`: CLI behavior tests using a small generated image.
- Modify `packages/kernel/src/index.ts`: export the tar image provider and index types.

---

### Task 1: Tar Image Root Provider

**Files:**
- Create: `packages/kernel/src/vfs/tar-image-root-provider.ts`
- Create: `packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write the failing provider tests**

Create `packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts` with:

```ts
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.19";
import {
  buildTarImageIndex,
  TarImageRootProvider,
} from "../tar-image-root-provider.ts";

const text = new TextEncoder();
const dec = new TextDecoder();

function octal(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(text.encode(value.toString(8).padStart(width - 1, "0") + "\0").subarray(0, width));
  return out;
}

function stringField(value: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(text.encode(value).subarray(0, width));
  return out;
}

function tarEntry(opts: {
  name: string;
  type?: "0" | "2" | "5" | "1";
  mode?: number;
  uid?: number;
  gid?: number;
  mtime?: number;
  data?: Uint8Array;
  linkname?: string;
}): Uint8Array {
  const type = opts.type ?? "0";
  const data = opts.data ?? new Uint8Array();
  const header = new Uint8Array(512);
  header.set(stringField(opts.name, 100), 0);
  header.set(octal(opts.mode ?? (type === "5" ? 0o755 : 0o644), 8), 100);
  header.set(octal(opts.uid ?? 0, 8), 108);
  header.set(octal(opts.gid ?? 0, 8), 116);
  header.set(octal(type === "0" ? data.byteLength : 0, 12), 124);
  header.set(octal(opts.mtime ?? 0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(stringField(opts.linkname ?? "", 100), 157);
  header.set(stringField("ustar", 6), 257);
  header.set(stringField("00", 2), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(octal(checksum, 8), 148);
  const paddedSize = Math.ceil(data.byteLength / 512) * 512;
  const out = new Uint8Array(512 + paddedSize);
  out.set(header, 0);
  out.set(data, 512);
  return out;
}

function tar(entries: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024);
  const out = new Uint8Array(entries.reduce((sum, entry) => sum + entry.byteLength, 0) + end.byteLength);
  let offset = 0;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.byteLength;
  }
  out.set(end, offset);
  return out;
}

Deno.test("TarImageRootProvider serves files, directories, symlinks, hardlinks, and metadata", async () => {
  const archive = tar([
    tarEntry({ name: "usr/", type: "5", mode: 0o755, uid: 0, gid: 0 }),
    tarEntry({ name: "usr/bin/", type: "5", mode: 0o755, uid: 0, gid: 0 }),
    tarEntry({ name: "usr/bin/hello", mode: 0o555, uid: 10, gid: 20, data: text.encode("hello\n") }),
    tarEntry({ name: "usr/bin/hello-hard", type: "1", mode: 0o755, uid: 30, gid: 40, linkname: "usr/bin/hello" }),
    tarEntry({ name: "bin/", type: "5", mode: 0o755 }),
    tarEntry({ name: "bin/hello", type: "2", mode: 0o777, linkname: "/usr/bin/hello" }),
    tarEntry({ name: "usr-link", type: "2", mode: 0o777, linkname: "/usr" }),
  ]);
  const index = await buildTarImageIndex(archive);
  const provider = new TarImageRootProvider({ id: "test", image: archive, index });

  assertEquals(dec.decode(provider.readFile("/usr/bin/hello")), "hello\n");
  assertEquals(dec.decode(provider.readFile("/usr/bin/hello-hard")), "hello\n");
  assertEquals(provider.lstat("/usr/bin/hello-hard").type, "file");
  assertEquals(provider.lstat("/usr/bin/hello-hard").uid, 30);
  assertEquals(provider.lstat("/usr/bin/hello-hard").gid, 40);
  assertEquals(provider.lstat("/usr/bin/hello-hard").size, 6);
  assertEquals(provider.readlink("/bin/hello"), "/usr/bin/hello");
  assertEquals(provider.stat("/bin/hello").type, "file");
  assertEquals(provider.stat("/usr-link").type, "dir");
  assertEquals(provider.readdir("/usr/bin").map((entry) => entry.name).sort(), ["hello", "hello-hard"]);
});

Deno.test("TarImageRootProvider rejects unsafe, duplicate, and unsupported entries", async () => {
  await assertRejects(() => buildTarImageIndex(tar([tarEntry({ name: "../escape", data: text.encode("x") })])));
  await assertRejects(() => buildTarImageIndex(tar([
    tarEntry({ name: "dup", data: text.encode("a") }),
    tarEntry({ name: "dup", data: text.encode("b") }),
  ])));
  const unsupported = tar([tarEntry({ name: "fifo", type: "0", data: text.encode("x") })]);
  unsupported[156] = "6".charCodeAt(0);
  await assertRejects(() => buildTarImageIndex(unsupported));
});

Deno.test("TarImageRootProvider rejects hardlinks that do not resolve to regular files", async () => {
  await assertRejects(() => buildTarImageIndex(tar([
    tarEntry({ name: "dir/", type: "5" }),
    tarEntry({ name: "bad", type: "1", linkname: "dir" }),
  ])));
  await assertRejects(() => buildTarImageIndex(tar([
    tarEntry({ name: "missing", type: "1", linkname: "nope" }),
  ])));
});

Deno.test("TarImageRootProvider throws VFS-shaped errors for missing paths and type mismatches", async () => {
  const archive = tar([
    tarEntry({ name: "dir/", type: "5" }),
    tarEntry({ name: "dir/file", data: text.encode("x") }),
  ]);
  const provider = new TarImageRootProvider({ id: "test", image: archive });

  assertThrows(() => provider.readFile("/missing"), Error, "ENOENT");
  assertThrows(() => provider.readFile("/dir"), Error, "EISDIR");
  assertThrows(() => provider.readdir("/dir/file"), Error, "ENOTDIR");
  assertThrows(() => provider.readlink("/dir/file"), Error, "ENOENT");
});
```

- [ ] **Step 2: Run the provider tests to verify they fail**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts
```

Expected: FAIL because `../tar-image-root-provider.ts` does not exist.

- [ ] **Step 3: Implement the provider**

Create `packages/kernel/src/vfs/tar-image-root-provider.ts` with these public shapes and implementation:

```ts
import { VfsError, type DirEntry } from "./inode.ts";
import { sha256Hex } from "../process/module-cache.ts";
import type { RootProvider, RootProviderStat } from "./root-provider.ts";

const BLOCK_SIZE = 512;
const decoder = new TextDecoder();

export interface TarImageRootProviderOptions {
  id: string;
  image: Uint8Array;
  index?: TarImageIndex;
}

export interface TarImageIndex {
  imageSha256: string;
  entries: Record<string, TarImageEntry>;
}

export type TarImageEntry =
  | { type: "dir"; mode: number; uid: number; gid: number; mtime: number }
  | { type: "file"; mode: number; uid: number; gid: number; mtime: number; offset: number; size: number }
  | { type: "symlink"; mode: number; uid: number; gid: number; mtime: number; target: string }
  | { type: "hardlink"; mode: number; uid: number; gid: number; mtime: number; target: string };

interface RawTarHeader {
  path: string;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  size: number;
  linkname: string;
}

export class TarImageRootProvider implements RootProvider {
  readonly id: string;
  private readonly image: Uint8Array;
  private readonly index: TarImageIndex;

  constructor(options: TarImageRootProviderOptions) {
    this.id = options.id;
    this.image = options.image;
    this.index = options.index ?? buildTarImageIndexSync(options.image);
  }

  readFile(path: string): Uint8Array {
    const entry = this.resolveFileEntry(path);
    return this.image.slice(entry.offset, entry.offset + entry.size);
  }

  stat(path: string): RootProviderStat {
    const resolved = this.resolveSymlinkWithPath(normalizeImagePath(path));
    return this.toStat(resolved.entry, resolved.path);
  }

  lstat(path: string): RootProviderStat {
    const normalized = normalizeImagePath(path);
    const entry = this.lookup(normalized);
    return this.toStat(entry, normalized);
  }

  readdir(path: string): DirEntry[] {
    const normalized = normalizeImagePath(path);
    const entry = this.lookup(normalized);
    if (entry.type !== "dir") throw new VfsError("ENOTDIR", `not a directory: ${path}`);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries = new Map<string, DirEntry>();
    for (const candidate of Object.keys(this.index.entries)) {
      if (candidate === normalized || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      const child = this.index.entries[candidate];
      entries.set(rest, { name: rest, type: child.type === "dir" ? "dir" : child.type === "symlink" ? "symlink" : "file" });
    }
    return Array.from(entries.values());
  }

  readlink(path: string): string {
    const entry = this.lookup(normalizeImagePath(path));
    if (entry.type !== "symlink") throw new VfsError("ENOENT", `not a symlink: ${path}`);
    return entry.target;
  }

  private lookup(path: string): TarImageEntry {
    const entry = this.index.entries[path];
    if (!entry) throw new VfsError("ENOENT", `no such path: ${path}`);
    return entry;
  }

  private resolveFileEntry(path: string): Extract<TarImageEntry, { type: "file" }> {
    const entry = this.resolveSymlink(normalizeImagePath(path));
    if (entry.type === "file") return entry;
    if (entry.type === "hardlink") return this.resolveHardlink(entry);
    if (entry.type === "dir") throw new VfsError("EISDIR", `is a directory: ${path}`);
    throw new VfsError("EACCES", `unresolved symlink: ${path}`);
  }

  private resolveSymlink(path: string, seen = new Set<string>()): TarImageEntry {
    return this.resolveSymlinkWithPath(path, seen).entry;
  }

  private resolveSymlinkWithPath(path: string, seen = new Set<string>()): { path: string; entry: TarImageEntry } {
    const entry = this.lookup(path);
    if (entry.type !== "symlink") return { path, entry };
    if (seen.has(path)) throw new VfsError("EACCES", `symlink loop: ${path}`);
    seen.add(path);
    return this.resolveSymlinkWithPath(resolveLinkTarget(path, entry.target), seen);
  }

  private resolveHardlink(entry: Extract<TarImageEntry, { type: "hardlink" }>): Extract<TarImageEntry, { type: "file" }> {
    const target = this.lookup(normalizeImagePath(entry.target));
    if (target.type !== "file") throw new VfsError("ENOENT", `hardlink target is not a file: ${entry.target}`);
    return target;
  }

  private toStat(entry: TarImageEntry, path: string): RootProviderStat {
    const fileEntry = entry.type === "hardlink" ? this.resolveHardlink(entry) : undefined;
    const size = entry.type === "dir" ? this.childCount(path) : entry.type === "file" ? entry.size : entry.type === "hardlink" ? fileEntry!.size : entry.target.length;
    const date = new Date(entry.mtime * 1000);
    return {
      type: entry.type === "dir" ? "dir" : entry.type === "symlink" ? "symlink" : "file",
      size,
      permissions: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: date,
      ctime: date,
      atime: date,
    };
  }

  private childCount(path: string): number {
    const prefix = path === "/" ? "/" : `${path}/`;
    let count = 0;
    for (const candidate of Object.keys(this.index.entries)) {
      if (candidate === path || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest && !rest.includes("/")) count++;
    }
    return count;
  }
}
```

Add the parser helpers below the class:

```ts
export async function buildTarImageIndex(image: Uint8Array): Promise<TarImageIndex> {
  const index = buildTarImageIndexSync(image);
  return { ...index, imageSha256: await sha256Hex(image) };
}

function buildTarImageIndexSync(image: Uint8Array): TarImageIndex {
  const entries: Record<string, TarImageEntry> = { "/": { type: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0 } };
  let offset = 0;
  while (offset + BLOCK_SIZE <= image.byteLength) {
    const block = image.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(block)) break;
    const header = readHeader(block);
    const path = normalizeTarEntryPath(header.path);
    const dataOffset = offset;
    offset += Math.ceil(header.size / BLOCK_SIZE) * BLOCK_SIZE;
    const common = { mode: header.mode, uid: header.uid, gid: header.gid, mtime: header.mtime };
    const entry = toEntry(header, dataOffset, common);
    addEntry(entries, path, entry);
  }
  validateHardlinks(entries);
  return { imageSha256: "unhashed", entries };
}

function toEntry(header: RawTarHeader, offset: number, common: { mode: number; uid: number; gid: number; mtime: number }): TarImageEntry {
  switch (header.type) {
    case "":
    case "0":
      return { type: "file", ...common, offset, size: header.size };
    case "5":
      return { type: "dir", ...common };
    case "2":
      return { type: "symlink", ...common, target: header.linkname };
    case "1":
      return { type: "hardlink", ...common, target: normalizeTarEntryPath(header.linkname) };
    default:
      throw new VfsError("EACCES", `unsupported tar entry type ${header.type}`);
  }
}
```

Implement `readHeader`, `readString`, `readOctal`, `normalizeImagePath`, `normalizeTarEntryPath`, `resolveLinkTarget`, `addEntry`, `validateHardlinks`, and `isZeroBlock` following the existing style in `packages/kernel/src/vfs/tar-install.ts`.

- [ ] **Step 4: Export provider types**

Modify `packages/kernel/src/index.ts` to export:

```ts
export {
  buildTarImageIndex,
  TarImageRootProvider,
  type TarImageEntry,
  type TarImageIndex,
  type TarImageRootProviderOptions,
} from "./vfs/tar-image-root-provider.ts";
```

- [ ] **Step 5: Run provider tests to verify they pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/vfs/tar-image-root-provider.ts packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts packages/kernel/src/index.ts
git commit -m "feat: add tar image root provider"
```

---

### Task 2: Ancestor Whiteout Semantics

**Files:**
- Modify: `packages/kernel/src/vfs/overlay-vfs.ts`
- Modify: `packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts`

- [ ] **Step 1: Write failing ancestor-whiteout tests**

Append tests to `packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts` near the other whiteout tests:

```ts
it("keeps runtime rmdir POSIX and rejects non-empty lower directories", () => {
  const base = new MemoryRoot();
  base.addDir("/lower", { uid: 1000, gid: 1000, permissions: 0o755 });
  base.addFile("/lower/file.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
  const vfs = new OverlayVFS({ base, upper: new VFS() });

  expect(() => vfs.rmdir("/lower")).toThrow(/ENOTEMPTY/);
  expect(dec.decode(vfs.readFile("/lower/file.txt"))).toBe("base");
});

it("imported directory whiteouts hide lower descendants", () => {
  const base = new MemoryRoot();
  base.addDir("/lower", { uid: 1000, gid: 1000, permissions: 0o755 });
  base.addFile("/lower/file.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
  const vfs = new OverlayVFS({ base, upper: new VFS() });

  vfs.importOverlayState({ baseId: base.id, whiteouts: ["/lower"] });

  expect(() => vfs.stat("/lower")).toThrow(/ENOENT|whiteout/);
  expect(() => vfs.readFile("/lower/file.txt")).toThrow(/ENOENT|whiteout/);
});

it("treats upper directories recreated below imported directory whiteouts as opaque", () => {
  const base = new MemoryRoot();
  base.addDir("/lower", { uid: 1000, gid: 1000, permissions: 0o777 });
  base.addFile("/lower/file.txt", "base", { uid: 1000, gid: 1000, permissions: 0o644 });
  const vfs = new OverlayVFS({ base, upper: new VFS() });

  vfs.importOverlayState({ baseId: base.id, whiteouts: ["/lower"] });
  vfs.mkdirp("/lower");
  vfs.writeFile("/lower/new.txt", enc.encode("upper"));

  expect(dec.decode(vfs.readFile("/lower/new.txt"))).toBe("upper");
  expect(() => vfs.readFile("/lower/file.txt")).toThrow(/ENOENT|whiteout/);
  expect(vfs.readdir("/lower").map((entry) => entry.name)).toEqual(["new.txt"]);
});
```

- [ ] **Step 2: Run overlay tests to verify they fail**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts
```

Expected: FAIL because imported parent whiteouts do not yet hide lower descendants, or recreated upper directories expose lower children.

- [ ] **Step 3: Implement ancestor-whiteout checks**

Modify `packages/kernel/src/vfs/overlay-vfs.ts`:

```ts
private nearestWhiteoutedAncestor(path: string): string | null {
  path = normalizeOverlayPath(path);
  for (const ancestor of ancestorPaths(path).slice(0, -1).reverse()) {
    if (this.whiteouts.has(ancestor)) return ancestor;
  }
  return null;
}

private hasWhiteoutedSelfOrAncestor(path: string): boolean {
  path = normalizeOverlayPath(path);
  return this.whiteouts.has(path) || this.nearestWhiteoutedAncestor(path) !== null;
}

private hasUpperEntryAtOrAbove(path: string): boolean {
  path = normalizeOverlayPath(path);
  for (const candidate of ancestorPaths(path)) {
    try {
      this.options.upper.lstat(candidate);
      return true;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }
  return false;
}
```

Use `hasWhiteoutedSelfOrAncestor(path)` before falling back to `base` in `readFile`, `stat`, `lstat`, `lookupMerged`, and base-side mutation checks. Keep runtime `rmdir(path)` POSIX: it must continue to call merged `readdir(path)` and reject non-empty directories. Directory-subtree deletion for image layers enters through `importOverlayState()` or future layer-application code, not through normal runtime `rmdir`.

In `readdir`, only include base entries when the directory is not hidden by an exact or ancestor whiteout. If an upper directory exists at the requested path, return upper entries even when an exact whiteout exists for the same path; this makes recreated upper directories opaque over the lower subtree. Creating an upper directory at a whiteouted path must not delete the whiteout until layer-application/export semantics have a separate opaque marker.

Adjust `ensureUpperParentDirectory(path)` so an exact or ancestor whiteout does not prevent creating the upper parent. When parent creation crosses a whiteouted base ancestor, create missing upper directories with default `0o755` user metadata rather than copying metadata from hidden lower directories.

- [ ] **Step 4: Run overlay tests to verify they pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/vfs/overlay-vfs.ts packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts
git commit -m "feat: add ancestor whiteouts to overlay vfs"
```

---

### Task 3: Sandbox Image Root Integration

**Files:**
- Modify: `packages/kernel/src/sandbox.ts`
- Create: `packages/kernel/src/__tests__/sandbox-image_test.ts`

- [ ] **Step 1: Write failing sandbox image tests**

Create `packages/kernel/src/__tests__/sandbox-image_test.ts` with a small tar helper copied from Task 1 and tests:

```ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";

const WASM_DIR = resolve(decodeURIComponent(new URL("../platform/__tests__/fixtures", import.meta.url).pathname));
const enc = new TextEncoder();
const dec = new TextDecoder();

// Include octal, stringField, tarEntry, and tar helpers from tar-image-root-provider_test.ts.

describe("Sandbox image root", { sanitizeResources: false, sanitizeOps: false }, () => {
  it("boots from a zstd .yurtimg and writes only to the upper layer", async () => {
    const image = tar([
      tarEntry({ name: "bin/", type: "5", mode: 0o755 }),
      tarEntry({ name: "bin/true", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")) }),
      tarEntry({ name: "etc/", type: "5", mode: 0o755 }),
      tarEntry({ name: "etc/base-marker.txt", mode: 0o666, uid: 1000, gid: 1000, data: enc.encode("base") }),
      tarEntry({ name: "etc/yurt/", type: "5", mode: 0o755 }),
      tarEntry({
        name: "etc/yurt/base-image.json",
        mode: 0o444,
        data: enc.encode(JSON.stringify({ version: 1, id: "test-image", tools: [{ name: "true", path: "/bin/true" }] })),
      }),
    ]);
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      image,
      bootArgv: ["/bin/true"],
    });

    try {
      expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe("base");
      sandbox.writeFile("/etc/base-marker.txt", enc.encode("upper"));
      expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe("upper");
      expect(dec.decode(image)).toContain("base");
    } finally {
      sandbox.destroy();
    }
  });

  it("accepts an image file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yurt-image-"));
    const imagePath = join(dir, "test.yurtimg");
    await writeFile(imagePath, tar([
      tarEntry({ name: "bin/", type: "5" }),
      tarEntry({ name: "bin/true", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")) }),
      tarEntry({ name: "etc/yurt/", type: "5" }),
      tarEntry({
        name: "etc/yurt/base-image.json",
        data: enc.encode(JSON.stringify({ version: 1, id: "path-image", tools: [{ name: "true", path: "/bin/true" }] })),
      }),
    ]));

    const sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), image: imagePath, bootArgv: ["/bin/true"] });
    try {
      expect(sandbox.stat("/bin/true").type).toBe("file");
    } finally {
      sandbox.destroy();
    }
  });
});
```

- [ ] **Step 2: Run sandbox image tests to verify they fail**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/sandbox-image_test.ts
```

Expected: FAIL because `SandboxOptions.image` is not defined.

- [ ] **Step 3: Add image option and root creation**

Modify `SandboxOptions` in `packages/kernel/src/sandbox.ts`:

```ts
/** Zstd-compressed .yurtimg tar image used as the read-only base root. */
image?: string | Uint8Array;
/** Directory for decompressed image tar cache entries. Node/Deno path loads only. */
imageCacheDir?: string;
```

Import the provider helpers:

```ts
import { loadYurtImage } from "./image-loader.ts";
import { TarImageRootProvider } from "./vfs/tar-image-root-provider.ts";
```

In `Sandbox.create`, reject combined roots:

```ts
if (options.baseRoot && options.image) {
  throw new Error("Sandbox.create accepts either baseRoot or image, not both");
}
```

Load image bytes and construct `vfs`:

```ts
const image = options.image
  ? await loadYurtImage(options.image, { cacheDir: options.imageCacheDir })
  : undefined;
const metadata = Object.fromEntries((baseManifest?.files ?? []).map((f) => [
  f.path,
  { uid: f.uid, gid: f.gid, mode: f.mode },
]));
const baseProvider = options.baseRoot
  ? new NodeDirectoryRootProvider(options.baseRoot, { id: baseManifest?.id ?? `dir:${options.baseRoot}`, metadata })
  : image
    ? new TarImageRootProvider({ id: image.baseId, image: image.tarBytes, index: image.index })
    : undefined;
const vfs: VfsLike = baseProvider ? new OverlayVFS({ base: baseProvider, upper }) : upper;
const hasBaseRoot = !!baseProvider;
```

Replace `options.baseRoot` root decisions with `hasBaseRoot` where the code should apply to both `baseRoot` and image roots:

```ts
const tools = hasBaseRoot
  ? Sandbox.registerBaseRootTools(mgr, vfs)
  : await Sandbox.registerTools(mgr, adapter, options.wasmDir, upper);
if (!hasBaseRoot) await Sandbox.installCpythonStdlib(...);
if (!hasBaseRoot) await Sandbox.installBootProgram(...);
```

- [ ] **Step 4: Run sandbox image tests to verify they pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/sandbox-image_test.ts
```

Expected: PASS.

- [ ] **Step 5: Run baseRoot regression tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/sandbox-base-root_test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/sandbox.ts packages/kernel/src/__tests__/sandbox-image_test.ts
git commit -m "feat: boot sandbox from yurt image"
```

---

### Task 4: Argv-Native Command Result API

**Files:**
- Modify: `packages/kernel/src/sandbox.ts`
- Modify: `packages/kernel/src/run-result.ts` only if the existing `RunResult` type needs a shared helper.
- Create or modify: `packages/kernel/src/__tests__/sandbox-image_test.ts`

- [ ] **Step 1: Write failing argv execution test**

Append to `packages/kernel/src/__tests__/sandbox-image_test.ts`:

```ts
it("runs image commands with argv without shell joining", async () => {
  const image = tar([
    tarEntry({ name: "bin/", type: "5" }),
    tarEntry({ name: "bin/echo-args", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "echo-args.wasm")) }),
    tarEntry({ name: "bin/true", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")) }),
    tarEntry({ name: "etc/yurt/", type: "5" }),
    tarEntry({
      name: "etc/yurt/base-image.json",
      data: enc.encode(JSON.stringify({
        version: 1,
        id: "argv-image",
        tools: [
          { name: "true", path: "/bin/true" },
          { name: "echo-args", path: "/bin/echo-args" },
        ],
      })),
    }),
  ]);
  const sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), image, bootArgv: ["/bin/true"] });
  try {
    const result = await sandbox.runArgv(["/bin/echo-args", "a b", "$HOME"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("argv[1]=a b");
    expect(result.stdout).toContain("argv[2]=$HOME");
  } finally {
    sandbox.destroy();
  }
});
```

- [ ] **Step 2: Run the argv test to verify it fails**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/sandbox-image_test.ts
```

Expected: FAIL because `sandbox.runArgv` does not exist.

- [ ] **Step 3: Implement `Sandbox.runArgv`**

Add to `Sandbox` near `spawn(argv, ...)`:

```ts
async runArgv(
  argv: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<RunResult> {
  this.assertAlive();
  if (argv.length === 0 || !argv[0]) {
    return { exitCode: 127, stdout: "", stderr: "empty argv\n", executionTimeMs: 0 };
  }
  const startTime = performance.now();
  const proc = await this.spawn(argv, {
    mode: "cli",
    env: options.env ?? Object.fromEntries(this.env),
    cwd: options.cwd ?? this.env.get("PWD") ?? "/",
  });
  const stdout = proc.fdReadAndClear(1);
  const stderr = proc.fdReadAndClear(2);
  return {
    exitCode: proc.exitCode ?? 0,
    stdout: stdout.data,
    stderr: stderr.data,
    executionTimeMs: performance.now() - startTime,
    truncated: stdout.truncated || stderr.truncated ? { stdout: stdout.truncated, stderr: stderr.truncated } : undefined,
  };
}
```

`Process.exitCode` is already exposed by `packages/kernel/src/process/handle.ts`; do not add a process-handle change for this phase.

- [ ] **Step 4: Run sandbox image tests to verify they pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/sandbox-image_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/sandbox.ts packages/kernel/src/__tests__/sandbox-image_test.ts
git commit -m "feat: add argv-native sandbox execution"
```

---

### Task 5: `yurt <image> [command...]` CLI

**Files:**
- Modify: `packages/kernel/src/cli.ts`
- Create: `packages/kernel/src/__tests__/cli-image_test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `packages/kernel/src/__tests__/cli-image_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WASM_DIR = resolve(decodeURIComponent(new URL("../platform/__tests__/fixtures", import.meta.url).pathname));
const CLI = resolve(decodeURIComponent(new URL("../cli.ts", import.meta.url).pathname));
const deno = Deno.execPath();
const enc = new TextEncoder();

// Include octal, stringField, tarEntry, and tar helpers from tar-image-root-provider_test.ts.

Deno.test("yurt CLI runs an argv command from an image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yurt-cli-image-"));
  const imagePath = join(dir, "test.yurtimg");
  await writeFile(imagePath, tar([
    tarEntry({ name: "bin/", type: "5" }),
    tarEntry({ name: "bin/true", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")) }),
    tarEntry({ name: "bin/echo-args", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "echo-args.wasm")) }),
    tarEntry({ name: "etc/yurt/", type: "5" }),
    tarEntry({
      name: "etc/yurt/base-image.json",
      data: enc.encode(JSON.stringify({
        version: 1,
        id: "cli-image",
        tools: [
          { name: "true", path: "/bin/true" },
          { name: "echo-args", path: "/bin/echo-args" },
        ],
      })),
    }),
  ]));

  const command = new Deno.Command(deno, {
    args: ["run", "--allow-read", CLI, imagePath, "/bin/echo-args", "a b", "$HOME"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(result.code, 0, stderr);
  assertStringIncludes(stdout, "argv[1]=a b");
  assertStringIncludes(stdout, "argv[2]=$HOME");
});

Deno.test("yurt CLI fails clearly when no command and /bin/sh is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yurt-cli-image-"));
  const imagePath = join(dir, "test.yurtimg");
  await writeFile(imagePath, tar([
    tarEntry({ name: "bin/", type: "5" }),
    tarEntry({ name: "bin/true", mode: 0o555, data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")) }),
    tarEntry({ name: "etc/yurt/", type: "5" }),
    tarEntry({ name: "etc/yurt/base-image.json", data: enc.encode(JSON.stringify({ version: 1, id: "cli-image", tools: [{ name: "true", path: "/bin/true" }] })) }),
  ]));

  const command = new Deno.Command(deno, {
    args: ["run", "--allow-read", CLI, imagePath],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(result.code, 127);
  assertStringIncludes(stderr, "no command provided and /bin/sh is not present in image");
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run packages/kernel/src/__tests__/cli-image_test.ts
```

Expected: FAIL because `cli.ts` still starts the fixture-backed REPL.

- [ ] **Step 3: Implement image CLI path**

Modify `packages/kernel/src/cli.ts` so `main()` does:

```ts
const [, , imageArg, ...commandArgv] = process.argv;
if (imageArg && imageArg.endsWith(".yurtimg")) {
  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    image: imageArg,
    imageCacheDir: process.env.YURT_IMAGE_CACHE_DIR ?? join(tmpdir(), "yurt-image-cache"),
    bootArgv: ["/bin/true"],
  });
  sandbox.setEnv("HOME", "/home/user");
  sandbox.setEnv("PWD", "/home/user");
  sandbox.setEnv("USER", "user");
  sandbox.setEnv("PATH", "/bin:/usr/bin");
  try {
    const argv = commandArgv.length > 0 ? commandArgv : ["/bin/sh"];
    if (commandArgv.length === 0) {
      try {
        sandbox.stat("/bin/sh");
      } catch {
        process.stderr.write("no command provided and /bin/sh is not present in image\n");
        process.exitCode = 127;
        return;
      }
    }
    const result = await sandbox.runArgv(argv);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    return;
  } finally {
    sandbox.destroy();
  }
}
```

Keep the existing `-c` and REPL behavior for non-image invocations in this task to avoid breaking local fixture workflows.

- [ ] **Step 4: Run CLI tests to verify they pass**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run packages/kernel/src/__tests__/cli-image_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/cli.ts packages/kernel/src/__tests__/cli-image_test.ts
git commit -m "feat: run yurt images from cli"
```

---

### Task 6: Final Verification

**Files:**
- All files changed in Tasks 1-5.

- [ ] **Step 1: Run focused Deno tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts packages/kernel/src/vfs/__tests__/overlay-vfs_test.ts packages/kernel/src/__tests__/sandbox-image_test.ts packages/kernel/src/__tests__/sandbox-base-root_test.ts packages/kernel/src/__tests__/cli-image_test.ts
```

Expected: PASS.

- [ ] **Step 2: Run type check**

Run:

```bash
/Users/sunny/.deno/bin/deno check packages/kernel/src/index.ts packages/kernel/src/cli.ts
```

Expected: PASS.

- [ ] **Step 3: Check formatting-sensitive diff issues**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit any final cleanup**

If final verification required cleanup, commit it:

```bash
git add packages/kernel/src docs/superpowers/plans/2026-05-07-yurt-image-runtime-phase1.md
git commit -m "chore: verify yurt image runtime phase 1"
```

If no cleanup was needed, do not create an empty commit.

---

## Self-Review

- Spec coverage: This plan covers `loadYurtImage`, `TarImageRootProvider`, `Sandbox.create({ image })`, ancestor-whiteout semantics, argv-native command execution, and zstd-compressed `yurt <image> [command...]` CLI behavior. It intentionally defers layer export, snapshot export, layer merge, browser storage, and signing.
- Placeholder scan: No placeholder markers or unspecified test commands remain.
- Type consistency: The provider exposes hardlinks as `file` through `RootProviderStat`, sandbox image input is `string | Uint8Array`, and CLI command execution uses `Sandbox.runArgv(argv)`.
