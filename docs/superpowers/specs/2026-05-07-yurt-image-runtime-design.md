# Yurt Image Runtime Design

**Status:** Draft
**Date:** 2026-05-07
**Repository:** `YurtOS/yurtos-kernel`

## Summary

Yurt needs a kernel-owned image runtime so users and higher-level package
tooling can run:

```bash
yurt image.yurtimg [command...]
yurt image.yurtimg.zst [command...]
```

An uncompressed `.yurtimg` is a tar filesystem image. The kernel loads its
filesystem index into memory, uses the tar file as the read-only base VFS
layer, and places runtime writes in a writable layer through `OverlayVFS`. The
default writable layer is the existing in-memory `VFS`, but the upper layer is
an explicit backend boundary: a caller can provide a local-directory,
browser-storage, S3-backed, or other permission-aware implementation later. A
compressed `.yurtimg.zst` is the transport form; CLI and browser tooling expand
it before booting.

The goal is not Docker compatibility. The kernel project owns the primitive
image runtime: load image, run command, preserve or export upper state, merge
overlay deltas, and export a new image. Package repositories and friendlier
Docker-like workflows can build on top of these primitives from `yurt-pkg`.

## Existing Capabilities

The kernel already has most of the filesystem foundation:

- `RootProvider` exposes read-only file, stat, directory, and symlink
  operations with uid/gid/mode metadata.
- `OverlayVFS` combines a read-only `RootProvider` with a writable upper `VFS`.
  It supports whiteouts, copy-up, permission checks, snapshots, and `cowClone`.
- `Sandbox.create({ baseRoot })` already creates
  `OverlayVFS({ base: NodeDirectoryRootProvider, upper: VFS })`.
- `applyTarToVfs(...)` can extract tar entries into a mutable `VFS`.
- The current `yurt` CLI starts a fixture-backed sandbox, but it does not yet
  accept an image path as its first argument.

This design adds image-backed roots without changing package-manager policy.

## Image Format

Yurt has two image states:

- **Runtime image:** uncompressed tar, extension `.yurtimg`.
- **Transport image:** compressed and signed runtime image,
  extension `.yurtimg.zst`.

The kernel runtime consumes the uncompressed tar form. Tar is the v1 filesystem
format because it already represents the data Yurt needs:

- paths;
- regular file bytes;
- directories;
- symlinks;
- hardlinks;
- mode;
- uid/gid;
- mtime.

The kernel does not expand `.yurtimg` into a directory tree. It scans tar
headers, loads an in-memory path index, and serves file contents by offset from
the image bytes/file. That is the normal filesystem shape: metadata is resident
and content is read lazily.

Unsupported tar entry types fail image loading. v1 supports regular files,
directories, symlinks, and hardlinks. Hardlinks must resolve to regular-file
entries in the same image.

Layer 1 is always a single image file. That keeps the kernel-facing artifact
portable across Node, browser, and embedded runtimes. The image may be stored on
disk, in memory, in OPFS, or in another byte provider, but semantically it is one
indexed tar filesystem.

## Layer Images

Yurt also needs an overlay delta artifact for writable layer state:

- **Layer image:** uncompressed tar-like overlay delta, extension `.yurtlayer`.
- **Transport layer image:** compressed and signed layer image,
  extension `.yurtlayer.zst`.

A layer image records upper-layer additions, modifications, metadata changes,
and deletions. Deletions are required because layer 2 can hide files and
directories from layer 1; the format is not add-only.

Layer images should use regular tar entries for created or modified filesystem
objects and an explicit v1 whiteout representation for deletions. The exact
encoding must be documented with the implementation, but it must satisfy these
rules:

- deleting a file hides that exact lower-layer path;
- deleting a directory hides the lower directory and all children unless a
  later layer recreates paths below it;
- whiteout entries cannot target paths outside the image namespace;
- applying layer images in order is deterministic.

Yurt layer images are not OCI layers. They are kernel-owned overlay delta
artifacts that can support Docker-like workflows later without importing Docker
semantics into the kernel.

## TarImageRootProvider

Add `TarImageRootProvider`, implementing `RootProvider`:

```ts
interface TarImageRootProviderOptions {
  id: string;              // usually sha256:<uncompressed-image-sha256>
  image: Uint8Array | Blob | FileBackedImage;
  index?: TarImageIndex;
}
```

The provider loads or receives a `TarImageIndex`:

```ts
interface TarImageIndex {
  imageSha256: string;
  entries: Record<string, TarImageEntry>;
}

type TarImageEntry =
  | { type: "dir"; mode: number; uid: number; gid: number; mtime: number }
  | { type: "file"; mode: number; uid: number; gid: number; mtime: number; offset: number; size: number }
  | { type: "symlink"; mode: number; uid: number; gid: number; mtime: number; target: string }
  | { type: "hardlink"; mode: number; uid: number; gid: number; mtime: number; target: string };
```

Provider behavior:

- `readFile(path)` returns regular file bytes. For hardlinks, it reads the
  resolved target file bytes.
- `stat(path)` follows symlinks according to existing `RootProvider` behavior.
- `lstat(path)` returns the entry itself.
- `readdir(path)` lists direct children from the index.
- `readlink(path)` returns symlink targets.
- Paths are absolute and normalized. `..` traversal is rejected while indexing.
- Duplicate non-directory paths are rejected while indexing.
- Compatible duplicate directory entries may merge only when mode/uid/gid
  match. Any other duplicate path is invalid.

For the TypeScript/browser path, v1 may require the uncompressed image bytes to
be in memory. The provider API should keep the storage boundary explicit so a
later OPFS/file-backed reader can avoid loading large images fully into memory.

## Sandbox Integration

Add a sandbox option equivalent to:

```ts
Sandbox.create({
  image: "/path/to/image.yurtimg",
  bootArgv: ["/bin/sh"],
});
```

Internally this creates:

```ts
OverlayVFS({
  base: new TarImageRootProvider(...),
  upper: new VFS(...),
})
```

The image is layer 1 and read-only. Runtime writes, deletes, chmod/chown
changes, and package installs go to the upper layer. Existing overlay
permissions and whiteouts remain authoritative.

The upper layer must be pluggable. The v1 `yurt` CLI and image-building path can
use the default in-memory `VFS`, because that is enough to run a command and then
export either the upper layer or the merged filesystem. Other runtimes can supply
a writable backend with the same semantics: local directory, browser OPFS,
IndexedDB, S3, or a custom backend. Backend implementations are responsible for
preserving the permission metadata and whiteout behavior exposed through the
overlay interface.

The existing `baseRoot` directory provider remains useful for tests and local
development, but image loading is the normal kernel artifact path.

## `yurt` CLI

The kernel package should ship a CLI with this v1 form:

```bash
yurt <image> [command...]
```

Examples:

```bash
yurt yurt-greet-demo.yurtimg yurt-greet Codex
yurt cpython-3.14.yurtimg python --version
yurt dev.yurtimg /bin/sh
yurt dev.yurtimg
```

Command behavior:

- If `[command...]` is present, spawn that command in the image.
- If no command is present, default to `/bin/sh`.
- If `/bin/sh` is missing, fail clearly:

  ```text
  no command provided and /bin/sh is not present in image
  ```

- The CLI should not use a host shell fallback.
- The CLI should set the usual baseline environment:
  `HOME=/home/user`, `PWD=/home/user`, `USER=user`, `PATH=/bin:/usr/bin`.

Compressed image behavior:

- If `<image>` ends in `.yurtimg.zst`, expand it into a CLI cache before boot.
- Cache by uncompressed content hash, not by input path.
- Reuse an existing cached `.yurtimg` and index when the hash matches.
- Signature verification can be added when signed image manifests land; v1 must
  keep the cache layout compatible with storing manifest/provenance beside the
  image.

Suggested CLI cache:

```text
~/.cache/yurt/images/sha256-<hash>/image.yurtimg
~/.cache/yurt/images/sha256-<hash>/index.json
~/.cache/yurt/images/sha256-<hash>/manifest.json
```

## Suspend And Image Export

The CLI runtime should support exporting either the upper layer or the merged
filesystem at process exit. These are kernel-owned filesystem serialization
primitives, not package policy.

Upper-layer export preserves layer 2 as a reusable overlay delta:

```bash
yurt --export-upper session.yurtlayer base.yurtimg /bin/sh
```

Merged snapshot export collapses layer 1 plus layer 2 into a standalone runtime
image:

```bash
yurt --snapshot-out next.yurtimg base.yurtimg pkg install yurt-greet
```

At process exit, for `--export-upper`:

1. The sandbox has a base image layer plus an upper writable layer.
2. The kernel/tooling walks the upper layer state.
3. It writes a `.yurtlayer` containing additions, modifications, metadata
   changes, and whiteouts for deletions.
4. The output layer can later be merged onto the same or compatible base image.

At process exit, for `--snapshot-out`:

1. The sandbox has base image layer plus upper VFS layer.
2. The kernel/tooling walks the merged VFS view.
3. It writes a new uncompressed `.yurtimg` tar.
4. The output image becomes a standalone runtime image; it does not require the
   previous base image or upper layer.

The export paths belong in the kernel project because they serialize VFS state.
`yurt-pkg` can later offer nicer package-aware image-building commands around
them.

## Layer Merge

The kernel tooling should provide a primitive that merges one or more layer
images onto a base image in order:

```bash
yurt image merge base.yurtimg layer1.yurtlayer layer2.yurtlayer -o out.yurtimg
```

Merge semantics:

- start from the indexed layer 1 image;
- apply each layer image in argument order;
- regular entries create or replace paths;
- metadata entries update the effective path metadata;
- whiteouts hide lower-layer files or directories;
- later layers may recreate paths hidden by earlier layers;
- the result is a standalone `.yurtimg` tar with no dependency on the input
  layers.

This is enough to maintain Docker-like layer chains if a higher-level tool wants
that, while keeping the kernel primitive small and filesystem-focused.

## Browser Runtime

Browser support is a first-class kernel-project deliverable.

Browser flow:

1. Fetch or receive `.yurtimg.zst`.
2. Decompress to uncompressed tar bytes.
3. Scan tar headers and build/load the in-memory path index.
4. Store image bytes plus index in IndexedDB/OPFS or keep them in memory for
   small images.
5. Boot `Sandbox` with `TarImageRootProvider` as layer 1.

The browser must not expand the image into thousands of files. It should use
the same indexed tar provider model as the CLI. The implementation may start
with an in-memory `Uint8Array`; OPFS-backed range reads can follow when image
sizes require it.

For browser image building, the default upper layer can be in memory for small
sessions. Larger sessions can use OPFS or IndexedDB as the pluggable upper
backend. Exporting upper layers and merged images should use the same kernel
serialization logic as the CLI, writing bytes to the browser-selected storage
target instead of to a host filesystem path.

Browser tests should cover:

- loading an uncompressed image;
- loading a compressed image through the browser decompression path;
- reading files by index;
- running a command from the image;
- proving runtime writes land in upper VFS and do not mutate image bytes.

## Signing And Provenance

The kernel image loader should verify format integrity, but package/repository
policy remains outside the kernel.

Expected signed transport shape:

```json
{
  "image_format": "yurtimg-tar-v1",
  "compressed_sha256": "...",
  "uncompressed_sha256": "...",
  "created_at": "...",
  "packages": []
}
```

The signing workflow itself belongs to package/image publishing tooling, not
the kernel runtime. The kernel CLI cache should store this manifest when
available and should key runtime images by the uncompressed image hash.

Layer image manifests should identify the base image hash they were produced
against when that information is known. The low-level merge primitive may still
accept layers explicitly, but signed publishing workflows should use the base
hash to prevent accidentally applying a delta to the wrong image.

## Non-Goals

- Dockerfile parsing.
- OCI image/layer compatibility.
- Registry push/pull.
- Content-addressed layer graph management.
- Package dependency solving or repository policy.
- Expanding images into host directory trees as the normal runtime path.

## Tests

Kernel tests should include:

- `TarImageRootProvider` unit tests for files, directories, symlinks,
  hardlinks, metadata, duplicate-path rejection, and traversal rejection.
- Overlay integration tests proving image base reads and upper writes work
  through `OverlayVFS`.
- Upper-backend contract tests for writes, chmod/chown, whiteouts, permission
  checks, and snapshots.
- Layer-image export tests proving adds, modifications, metadata changes, and
  deletions survive an `--export-upper` round trip.
- Layer merge tests proving one or more `.yurtlayer` inputs apply in order,
  including deleting layer 1 paths and recreating paths in later layers.
- Snapshot export tests proving merged L1+L2 state becomes a standalone
  `.yurtimg`.
- CLI tests for:
  - `yurt image.yurtimg command`;
  - default `/bin/sh`;
  - missing shell error;
  - `.yurtimg.zst` cache expansion;
  - `--export-upper`;
  - `--snapshot-out`;
  - `yurt image merge`.
- Browser adapter tests for compressed image load, index build, command run,
  upper-layer writes, and image/layer export.
- Package-boundary tests proving the kernel treats `/var/lib/yurt-pkg` as
  ordinary files and does not need package-manager policy.

## Implementation Sequence

1. Add tar image indexer and `TarImageRootProvider`.
2. Wire `Sandbox.create({ image })` to `OverlayVFS`.
3. Define the upper-layer backend interface and keep the default `VFS`
   implementation wired for CLI/image builds.
4. Update `yurt` CLI to support `yurt <image> [command...]`.
5. Add compressed image cache expansion for the CLI.
6. Add upper-layer export to `.yurtlayer` with deletion/whiteout support.
7. Add full merged-VFS export to uncompressed `.yurtimg` tar and
   `--snapshot-out`.
8. Add ordered layer merge into standalone `.yurtimg`.
9. Add browser image loading/decompression/export coverage.
10. Add signed manifest/cache metadata plumbing once image publishing defines
   the signing flow.
