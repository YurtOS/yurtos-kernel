# Yurt Image Build Design

**Status:** Draft
**Date:** 2026-05-08
**Repository:** `YurtOS/yurtos-kernel`

## Summary

Yurt needs a Docker-like image construction primitive that can start from either
an existing `.yurtimg` or an empty filesystem, mutate that filesystem through
kernel VFS operations, optionally run sandboxed commands, and export the merged
result as a new canonical zstd-compressed `.yurtimg`.

The kernel owns the low-level filesystem behavior:

- create an image build root;
- copy host files or byte payloads into the VFS;
- create directories and symlinks;
- change uid, gid, and mode;
- run commands in the sandbox when requested;
- walk the final merged VFS view;
- emit deterministic tar bytes;
- zstd-compress those tar bytes into `.yurtimg`.

Higher-level package or Dockerfile-like languages can build on top of this
primitive in a separate package or a later kernel-facing tool.

## Goals

- Build an image from an existing `.yurtimg`.
- Build an image from an empty root.
- Copy files from outside the sandbox into the image VFS.
- Apply metadata operations: `chmod`, `chown`, and symlink ownership where the
  current VFS supports it.
- Run a command inside the build sandbox before export.
- Export the final merged L1+L2 state as a new zstd-compressed `.yurtimg`.
- Keep tar indexing as the runtime model: exported images load through the same
  `loadYurtImage` and `TarImageRootProvider` path as published images.

## Non-Goals

- Dockerfile parsing.
- Multi-layer image manifests.
- Registry push/pull.
- Signed provenance.
- `.yurtlayer` delta export.
- Hardlink-preserving export in the first pass unless the current VFS exposes
  hardlink identity cleanly during merged traversal.

## Public API

Add a focused builder API in the kernel package:

```ts
interface YurtImageBuilderOptions {
  wasmDir: string;
  adapter?: PlatformAdapter;
  baseImage?: string | Uint8Array;
  imageCacheDir?: string;
}

interface CopyInOptions {
  uid?: number;
  gid?: number;
  mode?: number;
}

class YurtImageBuilder {
  static create(options: YurtImageBuilderOptions): Promise<YurtImageBuilder>;
  static empty(options: Omit<YurtImageBuilderOptions, "baseImage">): Promise<YurtImageBuilder>;
  copyIn(src: string | Uint8Array, dest: string, options?: CopyInOptions): Promise<void>;
  mkdir(path: string, options?: CopyInOptions): void;
  symlink(target: string, path: string, options?: CopyInOptions): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  remove(path: string): void;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number, followSymlinks?: boolean): void;
  run(argv: string[]): Promise<RunResult>;
  exportImage(): Promise<Uint8Array>;
  destroy(): void;
}
```

`YurtImageBuilder.create({ baseImage })` creates the same VFS shape as an
image-backed sandbox, but it must not install fixture defaults or require a
resident boot process just to mutate files. `YurtImageBuilder.empty(...)`
creates a mutable VFS with no default storage layout and uses that VFS as the
whole image.

Command execution should use a small build runtime around `ProcessKernel`,
`ProcessManager`, and `loadProcess`, or an equivalent `Sandbox` construction
mode that skips default root population and resident boot. Empty builds cannot
depend on `/bin/sh`, `/bin/true`, Python stdlib, or fixture tools existing
before the caller copies them into the VFS.

The builder should expose operations in terms of VFS paths, not Docker concepts.
That keeps policy out of the kernel.

## Export Format

Export produces a canonical `.yurtimg`:

1. Walk the merged VFS view from `/`.
2. Skip virtual filesystems such as `/dev` and `/proc`.
3. Emit a deterministic tar:
   - directories before children;
   - lexical path order;
   - normalized absolute VFS paths converted to relative tar paths;
   - regular files with exact bytes;
   - directories with mode, uid, gid;
   - symlinks with target, mode, uid, gid where available;
   - stable mtime, defaulting to `0` for deterministic output.
4. zstd-compress the tar bytes.
5. Return the compressed `.yurtimg` bytes.

The decompressed tar hash remains the runtime base id. The compressed hash is
useful for cache/provenance but does not replace the base id.

## Empty Image Semantics

An empty image build starts with a mutable VFS that has no default stored
directory layout. The first export still writes a normal zstd `.yurtimg` tar, so
the output is identical in shape to images built from an existing base.

Image building needs a VFS construction mode that starts with an empty stored
disk while still mounting kernel virtual filesystems. The behavior is required:

- no stored directories are created except `/`;
- built-in virtual mount points such as `/dev` and `/proc` remain reserved;
- virtual provider contents are not exported into image storage;
- callers cannot create, overwrite, remove, or export stored entries at virtual
  provider mount paths;
- callers may create ordinary stored paths such as `/bin`, `/etc`, `/usr`, and
  `/home` explicitly.

This matches the intended model: `/proc` and `/dev` are kernel-maintained
virtual filesystems, not image contents. Yurt does not need `mknod` for phase 1;
device files exposed under `/dev` remain provider-generated and disappear from
the exported image.

The empty root should contain only what the builder or caller creates plus
reserved virtual mounts that are omitted from storage export. It should not
implicitly install fixture tools, Python stdlib, or default `/etc` files unless
the caller explicitly copies or generates them. If the caller wants to run
commands during an empty build, they must first add the executable and any
supporting files required by that command.

## Command Execution

`run(argv)` uses the existing argv-native sandbox execution path. It must not
join argv into a shell string. The command sees the current build filesystem,
and its writes are included in the later export.

For base-image builds, command writes land in the overlay upper layer and export
captures the merged L1+L2 view. For empty builds, command writes land directly
in the mutable VFS and export captures that VFS.

## Copy And Metadata Rules

`copyIn` accepts either a host path or a byte array:

- host path source is Node/Deno-only and reads bytes through dynamic Node
  imports, keeping browser imports safe;
- byte-array source works in browser and Node;
- destination must be an absolute VFS path;
- parent directories are created with root ownership and `0755` unless they
  already exist;
- default file metadata is `uid=0`, `gid=0`, `mode=0644`;
- explicit `uid`, `gid`, and `mode` are applied after writing.

`mkdir`, `symlink`, `chmod`, and `chown` call through to the same VFS methods
used by the sandbox. Builder operations should run with setup/root authority so
image construction can prepare root-owned files even when normal runtime users
would not have permission.

Deletion is a kernel builder operation, not something that requires userland
`rm`:

- `unlink(path)` removes a regular file or symlink;
- `rmdir(path)` removes an empty directory;
- `remove(path)` recursively removes a file, symlink, or directory subtree.

For base-image builds, deleting a lower-only path records the existing
`OverlayVFS` whiteout state and export walks the merged view, so deleted lower
paths are omitted from the new snapshot image. For empty builds, deletion
mutates the mutable build VFS directly.

## CLI Surface

Add a minimal CLI path after the API exists:

```bash
yurt image build --empty -o out.yurtimg --copy ./tool.wasm:/bin/tool --chmod 555:/bin/tool
yurt image build base.yurtimg -o out.yurtimg --copy ./config.json:/etc/config.json --run /bin/setup
```

The first CLI implementation should be intentionally small:

- `--empty`;
- optional base image positional argument;
- `-o` / `--output`;
- repeatable `--copy host:vfs`;
- repeatable `--chmod mode:path`;
- repeatable `--chown uid:gid:path`;
- repeatable `--rm path`;
- one `--run` command consuming the remaining argv.

More expressive build files are outside the first implementation.

## Testing

Tests should prove the kernel primitive, not a Docker-compatible UX:

- exporting from an empty builder creates a zstd `.yurtimg` that reloads through
  `loadYurtImage`;
- copying a host file preserves bytes and requested mode/uid/gid;
- chmod and chown are visible after reloading the exported image;
- building from a base image captures base plus upper writes;
- deleting a base path before export omits it from the merged image;
- running an argv command during build mutates the image and preserves argv
  boundaries;
- CLI happy path builds an image from `--empty` and from a base image.

## Deferred Work

- Hardlink-preserving merged export is deferred unless current VFS traversal
  exposes stable inode identity during implementation. The first merged
  snapshot export may expand hardlinks as regular files and must document that
  behavior in the exporter.
- Browser persistent cache for exported images can follow the existing
  browser-storage image-loader work. The first API can return bytes.
