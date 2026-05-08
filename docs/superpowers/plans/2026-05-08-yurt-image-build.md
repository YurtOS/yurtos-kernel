# Yurt Image Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Docker-like kernel image construction: start from an existing `.yurtimg` or an empty stored disk, copy and mutate files, optionally run argv-native commands, and export the merged VFS as a new zstd-compressed `.yurtimg`.

**Architecture:** First make `.yurtimg` mean zstd-compressed tar everywhere by adding a reusable image loader and routing Sandbox/CLI image boot through it. Then add an empty-disk VFS mode for image builds, a deterministic merged-VFS tar exporter that zstd-compresses to canonical `.yurtimg`, `YurtImageBuilder` as a small orchestration API over VFS/OverlayVFS plus a build command runtime, and a thin `yurt image build` CLI.

**Tech Stack:** TypeScript, Deno tests, Node-compatible dynamic imports for host file and zstd operations, existing `VFS`, `OverlayVFS`, `TarImageRootProvider`, `loadYurtImage`, `ProcessKernel`, `ProcessManager`, and `loadProcess`.

---

## File Structure

- Create `packages/kernel/src/image-loader.ts`: load zstd-compressed `.yurtimg`, cache decompressed tar for path inputs, and build `TarImageIndex`.
- Create `packages/kernel/src/__tests__/image-loader_test.ts`: prove zstd load, raw tar rejection, and cache reuse.
- Modify `packages/kernel/src/sandbox.ts`: route `Sandbox.create({ image })` through `loadYurtImage`.
- Modify `packages/kernel/src/cli.ts`: accept only `.yurtimg` for image boot and use a decompressed tar cache.
- Modify `packages/kernel/src/__tests__/sandbox-image_test.ts` and `packages/kernel/src/__tests__/cli-image_test.ts`: switch image fixtures from raw tar to zstd `.yurtimg`.
- Modify `packages/kernel/src/vfs/vfs.ts`: add empty stored-disk construction mode and keep `/dev`/`/proc` as reserved virtual provider mounts.
- Modify `packages/kernel/src/vfs/__tests__/vfs_test.ts`: verify empty-disk mode and provider reservation.
- Create `packages/kernel/src/image-exporter.ts`: walk a merged `VfsLike`, write deterministic tar bytes, zstd-compress to `.yurtimg`.
- Create `packages/kernel/src/__tests__/image-exporter_test.ts`: verify export reloads through `loadYurtImage`, skips virtual providers, preserves metadata, and is deterministic.
- Create `packages/kernel/src/image-builder.ts`: `YurtImageBuilder` API for base/empty builds, copy/mkdir/symlink/chmod/chown/delete/run/export.
- Create `packages/kernel/src/__tests__/image-builder_test.ts`: builder API coverage for empty builds, base builds, deletion, metadata, and command run.
- Modify `packages/kernel/src/sandbox.ts`: expose or factor the loader-context/runtime helper needed by the builder to run argv without a resident shell.
- Modify `packages/kernel/src/cli.ts`: add minimal `yurt image build` parser.
- Create `packages/kernel/src/__tests__/cli-image-build_test.ts`: CLI happy paths.
- Modify `packages/kernel/src/index.ts`: export `YurtImageBuilder`, exporter helpers, and public types.
- Update `docs/superpowers/specs/2026-05-08-yurt-image-build-design.md` only if implementation uncovers a needed contract correction.

---

### Task 0: Compressed `.yurtimg` Runtime Loader

**Files:**
- Create: `packages/kernel/src/image-loader.ts`
- Create: `packages/kernel/src/__tests__/image-loader_test.ts`
- Modify: `packages/kernel/src/sandbox.ts`
- Modify: `packages/kernel/src/cli.ts`
- Modify: `packages/kernel/src/index.ts`
- Modify: `packages/kernel/src/__tests__/sandbox-image_test.ts`
- Modify: `packages/kernel/src/__tests__/cli-image_test.ts`
- Modify: `docs/superpowers/specs/2026-05-07-yurt-image-runtime-design.md`
- Modify: `docs/superpowers/plans/2026-05-07-yurt-image-runtime-phase1.md`

- [ ] **Step 1: Write failing image loader tests**

Create `packages/kernel/src/__tests__/image-loader_test.ts`:

```ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompress } from "node:zlib";
import { loadYurtImage } from "../image-loader.ts";

const enc = new TextEncoder();

function zstd(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zstdCompress(data, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(result));
    });
  });
}

function octal(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(enc.encode(value.toString(8).padStart(width - 1, "0") + "\0").subarray(0, width));
  return out;
}

function stringField(value: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(enc.encode(value).subarray(0, width));
  return out;
}

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(stringField(name, 100), 0);
  header.set(octal(0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(data.byteLength, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
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

describe("loadYurtImage", () => {
  it("decompresses .yurtimg zstd bytes into indexed tar bytes", async () => {
    const tarBytes = tar([tarEntry("hello.txt", enc.encode("hello"))]);
    const loaded = await loadYurtImage(await zstd(tarBytes));

    expect(loaded.tarBytes).toEqual(tarBytes);
    expect(loaded.index.entries["/hello.txt"]?.type).toBe("file");
    expect(loaded.baseId).toBe(`sha256:${loaded.tarSha256}`);
  });

  it("rejects raw tar bytes because .yurtimg is compressed", async () => {
    const tarBytes = tar([tarEntry("raw.txt", enc.encode("raw"))]);
    await expect(loadYurtImage(tarBytes)).rejects.toThrow();
  });

  it("caches path images as decompressed tar bytes for reuse", async () => {
    const dir = await mkdtemp("/tmp/yurt-image-loader-");
    const cacheDir = join(dir, "cache");
    await mkdir(cacheDir);
    const imagePath = join(dir, "image.yurtimg");
    const tarBytes = tar([tarEntry("cached.txt", enc.encode("cached"))]);
    await writeFile(imagePath, await zstd(tarBytes));

    const first = await loadYurtImage(imagePath, { cacheDir });
    expect(first.cachePath).toBeDefined();
    expect(new Uint8Array(await readFile(first.cachePath!))).toEqual(tarBytes);

    const second = await loadYurtImage(imagePath, { cacheDir });
    expect(second.cacheHit).toBe(true);
    expect(second.tarBytes).toEqual(tarBytes);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-loader_test.ts
```

Expected: FAIL because `packages/kernel/src/image-loader.ts` does not exist.

- [ ] **Step 3: Implement `loadYurtImage`**

Create `packages/kernel/src/image-loader.ts`:

```ts
import { sha256Hex } from "./process/module-cache.js";
import {
  buildTarImageIndex,
  type TarImageIndex,
} from "./vfs/tar-image-root-provider.js";

export interface LoadYurtImageOptions {
  cacheDir?: string;
}

export interface LoadedYurtImage {
  compressedBytes: Uint8Array;
  compressedSha256: string;
  tarBytes: Uint8Array;
  tarSha256: string;
  baseId: string;
  index: TarImageIndex;
  cachePath?: string;
  cacheHit: boolean;
}

export async function loadYurtImage(
  image: string | Uint8Array,
  options: LoadYurtImageOptions = {},
): Promise<LoadedYurtImage> {
  const compressedBytes = typeof image === "string"
    ? new Uint8Array(await (await import("node:fs/promises")).readFile(image))
    : image;
  const compressedSha256 = await sha256Hex(compressedBytes);
  const cachePath = typeof image === "string" && options.cacheDir
    ? await buildCachePath(options.cacheDir, compressedSha256)
    : undefined;

  let cacheHit = false;
  let tarBytes: Uint8Array;
  if (cachePath) {
    const cached = await readOptional(cachePath);
    if (cached) {
      tarBytes = cached;
      cacheHit = true;
    } else {
      tarBytes = await decompressZstd(compressedBytes);
      await (await import("node:fs/promises")).writeFile(cachePath, tarBytes);
    }
  } else {
    tarBytes = await decompressZstd(compressedBytes);
  }

  const index = await buildTarImageIndex(tarBytes);
  const tarSha256 = index.imageSha256;
  return {
    compressedBytes,
    compressedSha256,
    tarBytes,
    tarSha256,
    baseId: `sha256:${tarSha256}`,
    index,
    cachePath,
    cacheHit,
  };
}
```

Continue the file with `buildCachePath`, `readOptional`, `decompressZstd`, `decompressWithNativeStream`, and `toArrayBuffer`. `decompressZstd` should try `DecompressionStream("zstd")` first and fall back to dynamic `node:zlib` `zstdDecompress`.

- [ ] **Step 4: Route Sandbox image boot through the loader**

In `packages/kernel/src/sandbox.ts`:

- replace the `buildTarImageIndex` import with `loadYurtImage`;
- change `SandboxOptions.image` comment to zstd-compressed `.yurtimg`;
- add `imageCacheDir?: string`;
- replace direct file read/index creation with:

```ts
const image = options.image
  ? await loadYurtImage(options.image, { cacheDir: options.imageCacheDir })
  : undefined;
```

- construct `TarImageRootProvider` with:

```ts
new TarImageRootProvider({
  id: image.baseId,
  image: image.tarBytes,
  index: image.index,
})
```

- [ ] **Step 5: Route CLI image boot through `.yurtimg` only**

In `packages/kernel/src/cli.ts`, remove `.yurtimg.zst` handling and make image execution branch:

```ts
const [, , imageArg, ...commandArgv] = process.argv;
if (imageArg && imageArg.endsWith(".yurtimg")) {
  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter,
    image: imageArg,
    imageCacheDir: process.env.YURT_IMAGE_CACHE_DIR ?? join(tmpdir(), "yurt-image-cache"),
    bootArgv: ["/bin/true"],
  });
  // existing env, default /bin/sh check, runArgv, finally destroy
}
```

Add `join` from `node:path` and `tmpdir` from `node:os`.

- [ ] **Step 6: Convert sandbox and CLI image tests to zstd fixtures**

In `packages/kernel/src/__tests__/sandbox-image_test.ts` and `packages/kernel/src/__tests__/cli-image_test.ts`:

- import `zstdCompress` from `node:zlib`;
- add a `zstd(data: Uint8Array): Promise<Uint8Array>` helper;
- wrap every `.yurtimg` fixture written to disk or passed to `Sandbox.create({ image })` with `await zstd(tar(...))`;
- update test names that still say "uncompressed tar image".

CLI tests that execute `cli.ts` need `--allow-write` and `--allow-env` because the CLI now writes the decompressed tar cache and reads `YURT_IMAGE_CACHE_DIR`.

- [ ] **Step 7: Export loader from index**

Add to `packages/kernel/src/index.ts`:

```ts
export { loadYurtImage } from "./image-loader.js";
export type {
  LoadedYurtImage,
  LoadYurtImageOptions,
} from "./image-loader.js";
```

- [ ] **Step 8: Update runtime docs wording**

Update `docs/superpowers/specs/2026-05-07-yurt-image-runtime-design.md` and `docs/superpowers/plans/2026-05-07-yurt-image-runtime-phase1.md` so they no longer describe `.yurtimg` as raw/uncompressed tar or expose `.yurtimg.zst` as a user-facing image extension. Use:

- `.yurtimg` = zstd-compressed tar image;
- decompressed tar = internal cache/runtime artifact;
- runtime base id = decompressed tar SHA-256.

- [ ] **Step 9: Run runtime image verification**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/image-loader_test.ts packages/kernel/src/__tests__/sandbox-image_test.ts packages/kernel/src/__tests__/cli-image_test.ts
/Users/sunny/.deno/bin/deno check packages/kernel/src/index.ts packages/kernel/src/cli.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add docs/superpowers/specs/2026-05-07-yurt-image-runtime-design.md docs/superpowers/plans/2026-05-07-yurt-image-runtime-phase1.md packages/kernel/src/image-loader.ts packages/kernel/src/__tests__/image-loader_test.ts packages/kernel/src/sandbox.ts packages/kernel/src/cli.ts packages/kernel/src/index.ts packages/kernel/src/__tests__/sandbox-image_test.ts packages/kernel/src/__tests__/cli-image_test.ts
git commit -m "feat: load zstd yurt images"
```

---

### Task 1: Empty Stored-Disk VFS Mode

**Files:**
- Modify: `packages/kernel/src/vfs/vfs.ts`
- Modify: `packages/kernel/src/vfs/__tests__/vfs_test.ts`

- [ ] **Step 1: Write failing VFS tests**

Append tests to `packages/kernel/src/vfs/__tests__/vfs_test.ts`:

```ts
Deno.test("empty disk VFS starts with only virtual provider paths", () => {
  const vfs = new VFS({ layout: "empty" });

  expect(vfs.readdir("/").map((entry) => entry.name).sort()).toEqual([
    "dev",
    "proc",
  ]);
  expect(vfs.getProviderPaths?.().sort()).toEqual(["/dev", "/proc"]);
  expect(vfs.stat("/dev").type).toBe("dir");
  expect(vfs.stat("/proc").type).toBe("dir");
});

Deno.test("empty disk VFS reserves virtual provider mount paths", () => {
  const vfs = new VFS({ layout: "empty" });

  expect(() => vfs.mkdir("/dev")).toThrow(/EEXIST|EROFS|EACCES/);
  expect(() => vfs.writeFile("/proc", new Uint8Array())).toThrow();
  vfs.withWriteAccess(() => {
    vfs.mkdir("/bin");
    vfs.writeFile("/bin/tool", new Uint8Array([1]), 0o555);
  });
  expect(vfs.stat("/bin/tool").permissions).toBe(0o555);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test packages/kernel/src/vfs/__tests__/vfs_test.ts
```

Expected: FAIL because `VfsOptions.layout` does not exist and root listings do not merge provider mount names without stored directories.

- [ ] **Step 3: Add VFS options and constructor behavior**

In `packages/kernel/src/vfs/vfs.ts`, extend `VfsOptions`:

```ts
export interface VfsOptions {
  fsLimitBytes?: number;
  fileCount?: number;
  uid?: number;
  gid?: number;
  /** Default creates convenience dirs; empty creates only stored root plus virtual providers. */
  layout?: "default" | "empty";
}
```

Change the constructor:

```ts
this.initializing = true;
if ((options?.layout ?? "default") === "default") {
  this.initDefaultLayout();
}
this.initializing = false;
this.registerProvider('/dev', new DevProvider());
this.registerProvider(
  '/proc',
  new ProcProvider(
    () => this.getStorageStats(),
    () => this.getMountList(),
    () => this.processListProvider?.() ?? [],
  ),
);
```

- [ ] **Step 4: Make provider mounts visible without stored dirs**

In `readdir("/")`, merge first-level provider mount names into the root listing if they are not already stored children:

```ts
if (path === "/") {
  for (const mountPath of this.providers.keys()) {
    const [name, rest] = mountPath.slice(1).split("/");
    if (name && rest === undefined && !inode.children.has(name)) {
      entries.push({ name, type: "dir" });
    }
  }
}
```

Ensure the entries are not duplicated. It is acceptable to sort only in callers/tests; existing `readdir` ordering does not need to change.

- [ ] **Step 5: Reserve provider mount paths for mutation**

Add a helper in `VFS`:

```ts
private isProviderMountPath(path: string): boolean {
  const normalized = "/" + parsePath(path).join("/");
  return this.providers.has(normalized);
}
```

At the start of mutating operations that create/replace/remove leaf nodes (`writeFile`, `mkdir`, `mkdirp`, `unlink`, `rmdir`, `rename`, `symlink`, `link` destination), reject exact provider mount paths with `EROFS`:

```ts
if (this.isProviderMountPath(path)) {
  throw new VfsError("EROFS", `virtual mount path is read-only: ${path}`);
}
```

Do not reject paths below provider mounts; those should continue dispatching to the provider through `matchProvider`.

- [ ] **Step 6: Run VFS tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test packages/kernel/src/vfs/__tests__/vfs_test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/vfs/vfs.ts packages/kernel/src/vfs/__tests__/vfs_test.ts
git commit -m "feat: add empty disk vfs mode"
```

---

### Task 2: Deterministic Image Exporter

**Files:**
- Create: `packages/kernel/src/image-exporter.ts`
- Create: `packages/kernel/src/__tests__/image-exporter_test.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write failing exporter tests**

Create `packages/kernel/src/__tests__/image-exporter_test.ts`:

```ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { VFS } from "../vfs/vfs.ts";
import { exportVfsToYurtImage } from "../image-exporter.ts";
import { loadYurtImage } from "../image-loader.ts";
import { TarImageRootProvider } from "../vfs/tar-image-root-provider.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("exportVfsToYurtImage", () => {
  it("exports an empty-disk VFS as a reloadable zstd yurt image", async () => {
    const vfs = new VFS({ layout: "empty" });
    vfs.withWriteAccess(() => {
      vfs.mkdir("/etc");
      vfs.writeFile("/etc/config.txt", enc.encode("config"), 0o640);
      vfs.chown("/etc/config.txt", 42, 43);
      vfs.symlink("/etc/config.txt", "/config-link");
      vfs.chown("/config-link", 44, 45, false);
    });

    const image = await exportVfsToYurtImage(vfs);
    const loaded = await loadYurtImage(image);
    const root = new TarImageRootProvider({
      id: loaded.baseId,
      image: loaded.tarBytes,
      index: loaded.index,
    });

    expect(dec.decode(root.readFile("/etc/config.txt"))).toBe("config");
    expect(root.stat("/etc/config.txt")).toMatchObject({
      type: "file",
      permissions: 0o640,
      uid: 42,
      gid: 43,
    });
    expect(root.readlink("/config-link")).toBe("/etc/config.txt");
    expect(root.readdir("/").map((entry) => entry.name).sort()).toEqual([
      "config-link",
      "etc",
    ]);
  });

  it("skips virtual provider paths and is deterministic", async () => {
    const vfs = new VFS({ layout: "empty" });
    vfs.withWriteAccess(() => {
      vfs.mkdir("/bin");
      vfs.writeFile("/bin/a", enc.encode("a"), 0o555);
    });

    const first = await exportVfsToYurtImage(vfs);
    const second = await exportVfsToYurtImage(vfs);
    expect(first).toEqual(second);

    const loaded = await loadYurtImage(first);
    const root = new TarImageRootProvider({
      id: loaded.baseId,
      image: loaded.tarBytes,
      index: loaded.index,
    });
    expect(root.readdir("/").map((entry) => entry.name)).toEqual(["bin"]);
    expect(() => root.stat("/dev")).toThrow();
    expect(() => root.stat("/proc")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-exporter_test.ts
```

Expected: FAIL because `image-exporter.ts` does not exist.

- [ ] **Step 3: Implement tar and zstd exporter**

Create `packages/kernel/src/image-exporter.ts` with:

```ts
import type { DirEntry, StatResult } from "./vfs/inode.js";
import type { VfsLike } from "./vfs/vfs-like.js";

const BLOCK_SIZE = 512;
const text = new TextEncoder();
const VIRTUAL_PREFIXES = ["/dev", "/proc"];

export interface ExportTarOptions {
  skipPrefixes?: string[];
}

export async function exportVfsToYurtImage(
  vfs: VfsLike,
  options: ExportTarOptions = {},
): Promise<Uint8Array> {
  return await zstdCompress(await exportVfsToTar(vfs, options));
}

export async function exportVfsToTar(
  vfs: VfsLike,
  options: ExportTarOptions = {},
): Promise<Uint8Array> {
  const paths = walk(vfs, "/", new Set([
    ...VIRTUAL_PREFIXES,
    ...(vfs.getProviderPaths?.() ?? []),
    ...(options.skipPrefixes ?? []),
  ]));
  const chunks: Uint8Array[] = [];
  for (const path of paths) {
    const stat = vfs.lstat(path);
    if (stat.type === "dir") {
      chunks.push(tarEntry(path, stat, new Uint8Array(), "5"));
    } else if (stat.type === "symlink") {
      chunks.push(tarEntry(path, stat, new Uint8Array(), "2", vfs.readlink(path)));
    } else {
      chunks.push(tarEntry(path, stat, vfs.readFile(path), "0"));
    }
  }
  chunks.push(new Uint8Array(BLOCK_SIZE * 2));
  return concat(chunks);
}

function walk(vfs: VfsLike, root: string, skipPrefixes: Set<string>): string[] {
  const out: string[] = [];
  function visit(path: string): void {
    if (isSkipped(path, skipPrefixes)) return;
    const stat = vfs.lstat(path);
    if (path !== "/") out.push(path);
    if (stat.type !== "dir") return;
    const entries = vfs.readdir(path)
      .filter((entry: DirEntry) => !isSkipped(joinPath(path, entry.name), skipPrefixes))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) visit(joinPath(path, entry.name));
  }
  visit(root);
  return out;
}
```

Continue the file with helper functions `isSkipped`, `joinPath`, `tarPath`, `tarEntry`, `stringField`, `octal`, `checksum`, `concat`, `pad512`, and `zstdCompress`. Use Node zlib dynamically:

```ts
async function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const { zstdCompress } = await import("node:zlib");
  return new Promise((resolve, reject) => {
    zstdCompress(bytes, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(result));
    });
  });
}
```

For tar headers, write USTAR fields:

- name field from absolute path without leading `/`;
- directories with trailing `/`;
- type `0`, `2`, or `5`;
- size `0` for dirs/symlinks;
- mtime `0`;
- mode/uid/gid from `StatResult`;
- linkname for symlinks.

If a path exceeds the simple USTAR name/prefix limits, throw `new Error("tar path too long: ...")`.

- [ ] **Step 4: Export helper from index**

Add to `packages/kernel/src/index.ts`:

```ts
export {
  exportVfsToTar,
  exportVfsToYurtImage,
} from "./image-exporter.js";
export type { ExportTarOptions } from "./image-exporter.js";
```

- [ ] **Step 5: Run exporter tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-exporter_test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/image-exporter.ts packages/kernel/src/__tests__/image-exporter_test.ts packages/kernel/src/index.ts
git commit -m "feat: export vfs as yurt image"
```

---

### Task 3: YurtImageBuilder API

**Files:**
- Create: `packages/kernel/src/image-builder.ts`
- Create: `packages/kernel/src/__tests__/image-builder_test.ts`
- Modify: `packages/kernel/src/sandbox.ts`
- Modify: `packages/kernel/src/index.ts`

- [ ] **Step 1: Write failing builder tests**

Create `packages/kernel/src/__tests__/image-builder_test.ts`:

```ts
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { YurtImageBuilder } from "../image-builder.ts";
import { exportVfsToYurtImage } from "../image-exporter.ts";
import { loadYurtImage } from "../image-loader.ts";
import { TarImageRootProvider } from "../vfs/tar-image-root-provider.ts";
import { VFS } from "../vfs/vfs.ts";

const WASM_DIR = resolve(decodeURIComponent(new URL("../platform/__tests__/fixtures", import.meta.url).pathname));
const enc = new TextEncoder();
const dec = new TextDecoder();

async function providerFromImage(image: Uint8Array): Promise<TarImageRootProvider> {
  const loaded = await loadYurtImage(image);
  return new TarImageRootProvider({ id: loaded.baseId, image: loaded.tarBytes, index: loaded.index });
}

describe("YurtImageBuilder", () => {
  it("builds from an empty disk with copied files and metadata", async () => {
    const dir = await mkdtemp("/tmp/yurt-builder-");
    const src = join(dir, "config.txt");
    await writeFile(src, "config");

    const builder = await YurtImageBuilder.empty({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    try {
      await builder.copyIn(src, "/etc/config.txt", { uid: 10, gid: 20, mode: 0o640 });
      builder.symlink("/etc/config.txt", "/config-link");
      const root = await providerFromImage(await builder.exportImage());

      expect(dec.decode(root.readFile("/etc/config.txt"))).toBe("config");
      expect(root.stat("/etc/config.txt")).toMatchObject({ uid: 10, gid: 20, permissions: 0o640 });
      expect(root.readlink("/config-link")).toBe("/etc/config.txt");
      expect(() => root.stat("/dev")).toThrow();
    } finally {
      builder.destroy();
    }
  });

  it("builds from a base image and omits deleted base paths", async () => {
    const baseVfs = new VFS({ layout: "empty" });
    baseVfs.withWriteAccess(() => {
      baseVfs.mkdir("/etc");
      baseVfs.writeFile("/etc/base.txt", enc.encode("base"));
      baseVfs.writeFile("/etc/delete-me.txt", enc.encode("delete"));
    });
    const baseImage = await exportVfsToYurtImage(baseVfs);

    const builder = await YurtImageBuilder.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), baseImage });
    try {
      await builder.copyIn(enc.encode("upper"), "/etc/upper.txt");
      builder.remove("/etc/delete-me.txt");
      const root = await providerFromImage(await builder.exportImage());

      expect(dec.decode(root.readFile("/etc/base.txt"))).toBe("base");
      expect(dec.decode(root.readFile("/etc/upper.txt"))).toBe("upper");
      expect(() => root.stat("/etc/delete-me.txt")).toThrow();
    } finally {
      builder.destroy();
    }
  });

  it("runs argv-native commands during build", async () => {
    const builder = await YurtImageBuilder.empty({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    try {
      await builder.copyIn(await Deno.readFile(join(WASM_DIR, "echo-args.wasm")), "/bin/echo-args", { mode: 0o555 });
      const result = await builder.run(["/bin/echo-args", "a b", "$HOME"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b\n$HOME\n");
    } finally {
      builder.destroy();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-builder_test.ts
```

Expected: FAIL because `image-builder.ts` does not exist.

- [ ] **Step 3: Factor a reusable argv runtime helper**

In `packages/kernel/src/sandbox.ts`, make the loader-context helper accessible without exposing the full `Sandbox` constructor. Add an exported internal function near `Sandbox.createLoaderContext`:

```ts
export function createProcessLoaderContextForVfs(opts: {
  vfs: VfsLike;
  adapter: PlatformAdapter;
  kernel: ProcessKernel;
  mgr: ProcessManager;
  processes: Map<number, Process>;
  runtimeBackend?: RuntimeEngineBackend;
  moduleCache?: WasmModuleCache;
  stdoutLimit?: number;
  stderrLimit?: number;
}): LoaderContext {
  return Sandbox.createLoaderContext({
    vfs: opts.vfs,
    adapter: opts.adapter,
    kernel: opts.kernel,
    mgr: opts.mgr,
    processes: opts.processes,
    runtimeBackend: opts.runtimeBackend ?? unsupportedRuntimeEngineBackend,
    extensionRegistry: new ExtensionRegistry(),
    getSandbox: () => undefined,
    moduleCache: opts.moduleCache,
    stdoutLimit: opts.stdoutLimit,
    stderrLimit: opts.stderrLimit,
  });
}
```

If TypeScript visibility blocks this, rename `private static createLoaderContext` to `static createLoaderContext` and do not export it from `index.ts`.

- [ ] **Step 4: Implement builder API**

Create `packages/kernel/src/image-builder.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { PlatformAdapter } from "./platform/adapter.js";
import { NodeAdapter } from "./platform/node-adapter.js";
import type { RunResult } from "./run-result.js";
import { loadYurtImage } from "./image-loader.js";
import { exportVfsToYurtImage } from "./image-exporter.js";
import { ProcessKernel } from "./process/kernel.js";
import { ProcessManager } from "./process/manager.js";
import type { Process } from "./process/handle.js";
import { loadProcess } from "./process/loader.js";
import { OverlayVFS } from "./vfs/overlay-vfs.js";
import { TarImageRootProvider } from "./vfs/tar-image-root-provider.js";
import { VFS } from "./vfs/vfs.js";
import type { VfsLike } from "./vfs/vfs-like.js";
import { defaultWasmModuleCache, type WasmModuleCache } from "./process/module-cache.js";
import { createProcessLoaderContextForVfs } from "./sandbox.js";

export interface YurtImageBuilderOptions {
  wasmDir: string;
  adapter?: PlatformAdapter;
  baseImage?: string | Uint8Array;
  imageCacheDir?: string;
  moduleCache?: WasmModuleCache;
}

export interface CopyInOptions {
  uid?: number;
  gid?: number;
  mode?: number;
}

export class YurtImageBuilder {
  private readonly vfs: VfsLike;
  private readonly adapter: PlatformAdapter;
  private readonly moduleCache: WasmModuleCache;
  private readonly kernel = new ProcessKernel();
  private readonly processes = new Map<number, Process>();
  private readonly mgr: ProcessManager;
  private destroyed = false;

  private constructor(vfs: VfsLike, adapter: PlatformAdapter, moduleCache: WasmModuleCache) {
    this.vfs = vfs;
    this.adapter = adapter;
    this.moduleCache = moduleCache;
    this.mgr = new ProcessManager(vfs, adapter, undefined, undefined, moduleCache);
    this.vfs.setProcessListProvider?.(() => this.kernel.listProcesses());
  }

  static async create(options: YurtImageBuilderOptions): Promise<YurtImageBuilder> {
    const adapter = options.adapter ?? new NodeAdapter();
    const moduleCache = options.moduleCache ?? defaultWasmModuleCache;
    const upper = new VFS({ layout: "empty" });
    const loaded = options.baseImage
      ? await loadYurtImage(options.baseImage, { cacheDir: options.imageCacheDir })
      : undefined;
    const vfs = loaded
      ? new OverlayVFS({
        base: new TarImageRootProvider({ id: loaded.baseId, image: loaded.tarBytes, index: loaded.index }),
        upper,
      })
      : upper;
    return new YurtImageBuilder(vfs, adapter, moduleCache);
  }

  static empty(options: Omit<YurtImageBuilderOptions, "baseImage">): Promise<YurtImageBuilder> {
    return YurtImageBuilder.create(options);
  }

  async copyIn(src: string | Uint8Array, dest: string, options: CopyInOptions = {}): Promise<void> {
    this.assertAlive();
    const data = typeof src === "string" ? new Uint8Array(await readFile(src)) : src;
    this.vfs.withWriteAccess(() => {
      ensureParent(this.vfs, dest);
      this.vfs.writeFile(dest, data, options.mode ?? 0o644);
      this.vfs.chown(dest, options.uid ?? 0, options.gid ?? 0);
      this.vfs.chmod(dest, options.mode ?? 0o644);
    });
  }
```

Continue the class with `mkdir`, `symlink`, `unlink`, `rmdir`, `remove`, `chmod`, `chown`, `run`, `exportImage`, `destroy`, and `assertAlive`.

`remove(path)` should recursively walk `this.vfs.lstat(path)` and `this.vfs.readdir(path)`; remove children first, then call `rmdir` or `unlink`.

`run(argv)` should:

```ts
const startTime = performance.now();
const ctx = createProcessLoaderContextForVfs({
  vfs: this.vfs,
  adapter: this.adapter,
  kernel: this.kernel,
  mgr: this.mgr,
  processes: this.processes,
  moduleCache: this.moduleCache,
});
const proc = await loadProcess(ctx, {
  argv,
  mode: "cli",
  env: { HOME: "/", PWD: "/", USER: "root", PATH: "/bin:/usr/bin" },
  cwd: "/",
});
this.processes.set(proc.pid, proc);
try {
  const stdout = proc.fdReadAndClear(1);
  const stderr = proc.fdReadAndClear(2);
  return {
    exitCode: proc.exitCode ?? 0,
    stdout: stdout.data,
    stderr: stderr.data,
    executionTimeMs: performance.now() - startTime,
    truncated: stdout.truncated || stderr.truncated
      ? { stdout: stdout.truncated, stderr: stderr.truncated }
      : undefined,
  };
} finally {
  await proc.terminate();
  await this.kernel.waitpid(proc.pid);
}
```

`exportImage()` should call `exportVfsToYurtImage(this.vfs)`.

- [ ] **Step 5: Export builder from index**

Add to `packages/kernel/src/index.ts`:

```ts
export { YurtImageBuilder } from "./image-builder.js";
export type {
  CopyInOptions,
  YurtImageBuilderOptions,
} from "./image-builder.js";
```

- [ ] **Step 6: Run builder tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write packages/kernel/src/__tests__/image-builder_test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/image-builder.ts packages/kernel/src/__tests__/image-builder_test.ts packages/kernel/src/sandbox.ts packages/kernel/src/index.ts
git commit -m "feat: add yurt image builder api"
```

---

### Task 4: CLI Image Build Command

**Files:**
- Modify: `packages/kernel/src/cli.ts`
- Create: `packages/kernel/src/__tests__/cli-image-build_test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `packages/kernel/src/__tests__/cli-image-build_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadYurtImage } from "../image-loader.ts";
import { TarImageRootProvider } from "../vfs/tar-image-root-provider.ts";
import { VFS } from "../vfs/vfs.ts";
import { exportVfsToYurtImage } from "../image-exporter.ts";

const CLI = resolve(decodeURIComponent(new URL("../cli.ts", import.meta.url).pathname));
const deno = Deno.execPath();
const enc = new TextEncoder();
const dec = new TextDecoder();

async function rootFromFile(path: string): Promise<TarImageRootProvider> {
  const loaded = await loadYurtImage(await readFile(path));
  return new TarImageRootProvider({ id: loaded.baseId, image: loaded.tarBytes, index: loaded.index });
}

Deno.test("yurt image build creates an image from empty disk", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-build-");
  const src = join(dir, "hello.txt");
  const out = join(dir, "out.yurtimg");
  await writeFile(src, "hello");

  const result = await new Deno.Command(deno, {
    args: [
      "run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", CLI,
      "image", "build", "--empty", "-o", out,
      "--copy", `${src}:/etc/hello.txt`,
      "--chmod", "640:/etc/hello.txt",
      "--chown", "10:20:/etc/hello.txt",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = dec.decode(result.stderr);
  assertEquals(result.code, 0, stderr);
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/hello.txt")), "hello");
  assertEquals(root.stat("/etc/hello.txt").permissions, 0o640);
  assertEquals(root.stat("/etc/hello.txt").uid, 10);
  assertEquals(root.stat("/etc/hello.txt").gid, 20);
});

Deno.test("yurt image build removes paths from a base image", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-build-");
  const base = join(dir, "base.yurtimg");
  const out = join(dir, "out.yurtimg");
  const vfs = new VFS({ layout: "empty" });
  vfs.withWriteAccess(() => {
    vfs.mkdir("/etc");
    vfs.writeFile("/etc/drop.txt", enc.encode("drop"));
    vfs.writeFile("/etc/keep.txt", enc.encode("keep"));
  });
  await writeFile(base, await exportVfsToYurtImage(vfs));

  const result = await new Deno.Command(deno, {
    args: [
      "run", "--allow-read", "--allow-write", "--allow-run", "--allow-env", CLI,
      "image", "build", base, "-o", out, "--rm", "/etc/drop.txt",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = dec.decode(result.stderr);
  assertEquals(result.code, 0, stderr);
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/keep.txt")), "keep");
  try {
    root.stat("/etc/drop.txt");
    throw new Error("expected deleted path to be missing");
  } catch (error) {
    assertStringIncludes(String(error), "ENOENT");
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/cli-image-build_test.ts
```

Expected: FAIL because `cli.ts` does not parse `image build`.

- [ ] **Step 3: Implement minimal parser**

At the start of `main()` in `packages/kernel/src/cli.ts`, before `.yurtimg` run handling:

```ts
if (process.argv[2] === "image" && process.argv[3] === "build") {
  await runImageBuild(process.argv.slice(4));
  return;
}
```

Add `runImageBuild(args: string[])` in the same file. It should parse:

- `--empty`;
- `-o <path>` and `--output <path>`;
- optional base image positional argument;
- repeatable `--copy host:vfs`;
- repeatable `--chmod mode:path`;
- repeatable `--chown uid:gid:path`;
- repeatable `--rm path`;
- `--run`, with all remaining args as the command argv.

Use `YurtImageBuilder.empty(...)` when `--empty` is set; otherwise require a base image positional argument and call `YurtImageBuilder.create(...)`.

After applying operations:

```ts
const image = await builder.exportImage();
await (await import("node:fs/promises")).writeFile(outputPath, image);
```

Set `process.exitCode` from `--run` result when present. On parse errors, write a single-line message to stderr and set exit code `2`.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/__tests__/cli-image-build_test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/cli.ts packages/kernel/src/__tests__/cli-image-build_test.ts
git commit -m "feat: add yurt image build cli"
```

---

### Task 5: Final Verification And Docs Sync

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-05-08-yurt-image-build-design.md`
- Modify if needed: `docs/superpowers/plans/2026-05-08-yurt-image-build.md`

- [ ] **Step 1: Run focused image build verification**

Run:

```bash
/Users/sunny/.deno/bin/deno test --allow-read --allow-write --allow-run --allow-env packages/kernel/src/vfs/__tests__/vfs_test.ts packages/kernel/src/__tests__/image-exporter_test.ts packages/kernel/src/__tests__/image-builder_test.ts packages/kernel/src/__tests__/cli-image-build_test.ts packages/kernel/src/__tests__/image-loader_test.ts packages/kernel/src/__tests__/sandbox-image_test.ts packages/kernel/src/__tests__/cli-image_test.ts
```

Expected: PASS.

- [ ] **Step 2: Run type checks**

Run:

```bash
/Users/sunny/.deno/bin/deno check packages/kernel/src/index.ts packages/kernel/src/cli.ts
```

Expected: PASS.

- [ ] **Step 3: Run diff checks and stale wording scans**

Run:

```bash
git diff --check
rg -n "yurtimg\\.zst|uncompressed \\.yurtimg|ExportImageOptions|include\\?|exclude\\?|default stored directory" docs/superpowers/specs/2026-05-07-yurt-image-runtime-design.md docs/superpowers/specs/2026-05-08-yurt-image-build-design.md docs/superpowers/plans/2026-05-07-yurt-image-runtime-phase1.md docs/superpowers/plans/2026-05-08-yurt-image-build.md packages/kernel/src
```

Expected: `git diff --check` exits 0. The `rg` command exits 1 with no matches.

- [ ] **Step 4: Commit final docs corrections if any**

If Step 3 required doc corrections:

```bash
git add docs/superpowers/specs/2026-05-08-yurt-image-build-design.md docs/superpowers/plans/2026-05-08-yurt-image-build.md
git commit -m "docs: align yurt image build plan"
```

If no corrections were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage: Tasks cover empty stored-disk VFS mode, virtual `/dev` and `/proc` reservation, builder copy/metadata/delete/run operations, base-image and empty-image starts, merged VFS export, zstd `.yurtimg` output, and minimal CLI.
- Placeholder scan: No placeholder markers remain. Deferred hardlink identity and browser persistent cache are explicitly outside phase 1 in the spec and are not part of this implementation plan.
- Type consistency: `YurtImageBuilder`, `YurtImageBuilderOptions`, `CopyInOptions`, `exportVfsToTar`, `exportVfsToYurtImage`, and `loadYurtImage` names are used consistently across tasks.
