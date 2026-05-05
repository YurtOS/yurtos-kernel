# Yurt Package Format Design

## Purpose

Yurt needs a package format for sandbox-native binary and data packages. The
format must describe package identity, dependency relationships, and enough
install metadata for reproducible installs into the Yurt VFS.

The package format should not invent a full Linux distribution model. Yurt
packages install into an isolated sandbox filesystem with a small user model,
not into a host OS with system services, maintainer scripts, or global package
database semantics.

## Recommendation

Use a tar-based binary package with Conda-like package metadata:

- The archive is the source of truth for installed filesystem entries.
- Metadata describes package identity, dependencies, platform, and integrity.
- Links, permissions, ownership, and file types are represented by tar entries,
  not by Yurt-specific install directives.
- Yurt-specific metadata is kept minimal and only describes runtime requirements
  that are not filesystem facts.

This gives Yurt a simple package format while leaving room to adopt existing
Conda-style indexing and dependency solving conventions later.

## Non-Goals

- Do not adopt Debian package semantics, maintainer scripts, triggers, or system
  integration hooks.
- Do not adopt Nix derivations as the runtime install format.
- Do not encode symlinks or hardlinks in custom JSON install directives.
- Do not support arbitrary package install scripts in the first version.
- Do not model more users or groups than Yurt currently exposes.

## Package Artifact

A package artifact is a compressed tar archive. The preferred extension is:

```text
<name>-<version>-<build>.yurtpkg.tar.zst
```

`.tar.gz` may be accepted for local development if zstd support is unavailable,
but registry-published packages should use zstd.

All installable paths inside the archive are relative to the sandbox root.
For example:

```text
info/index.json
info/files.json
bin/busybox
bin/ash
bin/sh
usr/bin/cat
usr/share/busybox/help.txt
```

The installer maps `bin/busybox` to `/bin/busybox`. Archive entries must never
use absolute paths.

## Filesystem Semantics

The tar payload represents filesystem state directly:

- Regular files install as regular VFS files.
- Directories install as VFS directories.
- Symlinks install as VFS symlinks.
- Hardlinks install as VFS hardlinks when the VFS supports them.
- Mode bits are preserved.
- uid/gid are preserved.

Yurt uses canonical package ownership values:

```text
0:0       root
1000:1000 user
```

Package authors should use `0:0` for system tools and `1000:1000` for user-owned
data. Because Yurt only exposes these users today, package metadata does not need
to define arbitrary user or group databases.

### Links

Links are ordinary archive entries. A BusyBox package should encode applets as
symlinks or hardlinks in the tar payload:

```text
bin/busybox     regular file, mode 0755, uid 0, gid 0
bin/ash         symlink -> busybox
bin/sh          symlink -> busybox
usr/bin/cat     symlink -> ../../bin/busybox
```

There is no `multicall` metadata field. The package format does not need to know
that BusyBox dispatches by `argv[0]`; it only needs to install the links.

## Metadata Layout

Package metadata lives under `info/`.

### `info/index.json`

Required. Describes package identity and dependency constraints.

```json
{
  "schema_version": 1,
  "name": "busybox",
  "version": "1.36.1",
  "build": "yurt_0",
  "platform": "wasm32-wasip1-yurt",
  "summary": "BusyBox userland tools for Yurt",
  "license": "GPL-2.0-only",
  "depends": []
}
```

Fields:

- `schema_version`: Package metadata schema version. Initially `1`.
- `name`: Lowercase package name, unique within a registry.
- `version`: Upstream package version.
- `build`: Yurt build identifier, used to distinguish rebuilds of the same
  upstream version.
- `platform`: Target platform. Initial value is `wasm32-wasip1-yurt`.
- `summary`: Human-readable one-line description.
- `license`: SPDX license expression when known.
- `depends`: Array of dependency constraints.

Dependency entries use a deliberately small Conda-like subset:

```json
[
  "libz >=1.3,<2",
  "busybox >=1.36"
]
```

Version comparison and solver behavior can start with exact package names and
simple comparison operators. The format should not require a full Conda solver in
the first implementation.

### `info/files.json`

Required. Records the installed file manifest for validation and uninstall.

```json
{
  "files": [
    {
      "path": "bin/busybox",
      "type": "file",
      "sha256": "...",
      "size": 123456,
      "mode": "0755",
      "uid": 0,
      "gid": 0
    },
    {
      "path": "bin/ash",
      "type": "symlink",
      "target": "busybox",
      "mode": "0777",
      "uid": 0,
      "gid": 0
    }
  ]
}
```

The tar entries remain authoritative for extraction. `info/files.json` exists so
the installer can verify integrity, record ownership of installed paths, and
uninstall packages without scanning historical archives.

### `info/yurt.json`

Optional. Describes runtime requirements that cannot be represented as
filesystem entries.

```json
{
  "min_yurt_version": "0.1.0",
  "requires": {
    "network": false,
    "processes": true,
    "threads": false
  },
  "commands": ["busybox", "ash", "sh", "cat"]
}
```

Fields:

- `min_yurt_version`: Minimum Yurt runtime version required.
- `requires`: Runtime capabilities the package expects.
- `commands`: Optional command names for discovery and UI listing only.

`info/yurt.json` must not contain file installation directives. It must not
declare symlinks, hardlinks, permissions, or multicall applets.

## Registry Index

A package registry exposes a JSON index with artifact metadata. The shape should
be close to Conda `repodata.json`, but it can start smaller.

```json
{
  "schema_version": 1,
  "platform": "wasm32-wasip1-yurt",
  "packages": {
    "busybox-1.36.1-yurt_0.yurtpkg.tar.zst": {
      "name": "busybox",
      "version": "1.36.1",
      "build": "yurt_0",
      "depends": [],
      "sha256": "...",
      "size": 1234567
    }
  }
}
```

The installer should fetch the index, resolve dependencies, verify artifact
hashes, and then install packages in dependency order.

## Kernel Fixture Extractor

`yurtos-kernel` only needs a small tar extractor for boot fixtures and tests.
That extractor applies a prevalidated tar payload to the VFS:

- regular files become VFS files
- directories are created as needed
- symlinks and hardlinks are created through the VFS link APIs
- tar mode, uid, and gid are preserved

It does not resolve dependencies, fetch registries, write package databases, or
implement `pkg`/`pip` commands. Once an executable is present in the VFS with
execute bits, the existing process loader should be able to execute it through
normal path resolution.

## Package-Manager Rules

These rules belong to the future package-manager layer, not to
`yurtos-kernel`.

The installer must validate archives before mutating the VFS:

- Reject absolute paths.
- Reject `.` and `..` path traversal.
- Reject entries that normalize outside the sandbox root.
- Reject hardlinks whose targets are absolute or escape the package root.
- Preserve symlink targets as stored, but reject symlink entries whose link path
  itself escapes the sandbox root.
- Reject duplicate archive entries after path normalization.
- Verify file hashes and sizes from `info/files.json` when present.
- Preserve tar mode, uid, and gid.
- Record installed files in a package-manager-owned database if that layer wants
  list/info/remove/conflict operations.

Install should be transactional where practical:

1. Validate metadata and archive paths.
2. Resolve and fetch dependencies.
3. Check path conflicts against already installed packages.
4. Extract into the VFS.
5. Write package database records outside the kernel abstraction.

If extraction fails, the installer should remove paths it created during that
attempt before returning an error.

## Conflict Rules

The first version should use conservative conflict behavior:

- Installing a package fails if it would overwrite a path owned by another
  installed package.
- Reinstalling the exact same package build may be treated as idempotent if all
  recorded files match.
- Upgrades are modeled as remove old package then install new package.
- Shared directories are allowed when their metadata is compatible.

Hardlinks within a package are allowed. Hardlinks across packages are not needed
in the first version.

## Package Database

Installed package state is owned by the package-manager layer, not by
`yurtos-kernel`. A package-manager implementation may choose to persist state
in VFS metadata files such as:

```text
/usr/share/pkg/packages.json
/usr/share/pkg/files.json
```

The database records:

- package name, version, build, platform
- source URL or registry artifact name
- install timestamp
- installed paths and file ownership
- package-level hash and size

Those files support package-manager operations such as list, info, remove, and
conflict detection. The kernel should not interpret them; it only applies an
already validated artifact/install plan to the VFS for boot fixtures and tests.

## Migration From Current Manifests

The current sidecar manifest shape in `packages/kernel/src/boot/manifest.ts`
contains file, symlink, and multicall install directives. The new format replaces
those directives with tar-native filesystem entries.

Migration path:

1. Add package archive reading and validation outside the kernel repo.
2. Keep the kernel-side fixture extractor limited to applying a prevalidated tar
   payload to the VFS.
3. Convert BusyBox from `busybox.wasm` plus `busybox.manifest.json` into a
   `busybox-<version>-<build>.yurtpkg.tar.zst` archive.
4. Keep legacy sidecar manifests temporarily for existing fixtures.
5. Remove legacy sidecar manifest support once package archives cover the same
   cases.

## Testing

Kernel unit tests should cover:

- tar path normalization and rejection cases
- symlink and hardlink extraction
- uid/gid/mode preservation

Package-manager tests, in the future sister repository, should cover metadata
parsing, dependency constraint parsing, conflict detection, package database
writes, and uninstall behavior.

Integration tests should cover:

- installing BusyBox and running `/bin/ash`
- installing a package with hardlinks
- installing dependency chains
- rejecting an archive with path traversal
- rejecting an archive with a conflicting file
- preserving root-owned executable permissions

## Open Extension Points

These are intentionally deferred:

- richer dependency solver behavior
- package signatures
- OCI registry transport
- multiple platforms in one registry
- package channels
- optional features
- pre/post install hooks

The schema should leave room for these, but the first implementation should not
include them.
