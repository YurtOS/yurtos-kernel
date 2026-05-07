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
layer, and places runtime writes in the existing writable upper layer through
`OverlayVFS`. A compressed `.yurtimg.zst` is the transport form; CLI and browser
tooling expand it before booting.

The goal is not Docker compatibility. The kernel project owns the primitive
image runtime: load image, run command, preserve upper state, and export a new
image. Package repositories and friendlier Docker-like workflows can build on
top of these primitives from `yurt-pkg`.

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

The CLI runtime should support turning the resulting VFS state into a new
image. This is the primitive that lets package tooling install at runtime and
then collapse layer 2 into a new layer 1 image:

```bash
yurt --snapshot-out next.yurtimg base.yurtimg pkg install yurt-greet
```

At process exit:

1. The sandbox has base image layer plus upper VFS layer.
2. The kernel/tooling walks the merged VFS view.
3. It writes a new uncompressed `.yurtimg` tar.
4. The output image becomes a standalone runtime image; it does not require the
   previous base image or upper layer.

This export path belongs in the kernel project because it is filesystem
serialization, not package policy. `yurt-pkg` can later offer a nicer
Docker-like wrapper around it, but the primitive is kernel-owned.

The first export implementation may be full-image export. Incremental layer
export is a non-goal for v1.

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

## Non-Goals

- Dockerfile parsing.
- OCI image/layer compatibility.
- Registry push/pull.
- Incremental layer export.
- Package dependency solving or repository policy.
- Expanding images into host directory trees as the normal runtime path.

## Tests

Kernel tests should include:

- `TarImageRootProvider` unit tests for files, directories, symlinks,
  hardlinks, metadata, duplicate-path rejection, and traversal rejection.
- Overlay integration tests proving image base reads and upper writes work
  through `OverlayVFS`.
- CLI tests for:
  - `yurt image.yurtimg command`;
  - default `/bin/sh`;
  - missing shell error;
  - `.yurtimg.zst` cache expansion;
  - `--snapshot-out`.
- Browser adapter tests for compressed image load, index build, command run,
  and upper-layer writes.
- Package-boundary tests proving the kernel treats `/var/lib/yurt-pkg` as
  ordinary files and does not need package-manager policy.

## Implementation Sequence

1. Add tar image indexer and `TarImageRootProvider`.
2. Wire `Sandbox.create({ image })` to `OverlayVFS`.
3. Update `yurt` CLI to support `yurt <image> [command...]`.
4. Add compressed image cache expansion for the CLI.
5. Add full merged-VFS export to uncompressed `.yurtimg` tar and
   `--snapshot-out`.
6. Add browser image loading/decompression coverage.
7. Add signed manifest/cache metadata plumbing once image publishing defines
   the signing flow.
