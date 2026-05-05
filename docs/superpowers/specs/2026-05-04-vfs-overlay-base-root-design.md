# VFS Overlay Base Root Design

## Goal

Yurt needs a kernel-owned overlay filesystem so sandboxes can boot from a reusable read-only base root while all runtime writes land in an isolated upper VFS. This belongs in the kernel repository because permission checks, executable lookup, persistence, and fork isolation are kernel responsibilities.

Sandbox pooling and multi-sandbox orchestration are out of scope for this repository.

## Architecture

Add a `RootProvider` abstraction for immutable base roots. A provider exposes read-only file, stat, directory, and symlink operations with explicit metadata: type, size, mode, uid, gid, and timestamps.

Add `OverlayVFS`, implementing the same VFS-like surface used by the process kernel:

- `base`: immutable `RootProvider`
- `upper`: writable `VFS`
- `whiteouts`: normalized deleted paths that hide base entries
- `credential`: effective uid/gid/groups used for kernel permission checks

Lookup order is upper first, then base, unless a whiteout hides the path. Writes copy up only the minimum required metadata and parent directories. Deletes of base entries create whiteouts. Renames must preserve POSIX-like behavior for files, symlinks, empty directories, destination replacement, and non-empty directory rejection.

## Sandbox Integration

Add a sandbox option for a read-only base root. Normal sandbox creation remains unchanged. With a base root:

- boot files and registered tools come from the base root manifest
- runtime writes go only to the upper VFS
- fork/cowClone keeps the same base provider and clones only upper state
- user code cannot bypass overlay checks by writing directly to the base

The base root manifest must include enough metadata to register executable tools without scanning or mutating the base.

## Persistence

Persistence stores only:

- upper VFS state
- overlay whiteouts
- base root id

Restore must reject a base id mismatch. This prevents applying an upper layer to a different immutable root and silently producing incoherent files.

## Permissions

All authorization stays in kernel/VFS code. Overlay operations must use uid/gid/mode checks for:

- read, write, execute, and search
- file creation in directories
- directory listing
- chmod/chown
- unlink/rmdir
- rename source and destination parents
- symlink creation and readlink behavior

Root uid `0` may bypass permission checks where POSIX permits it. The default runtime credential remains uid/gid `1000`.

## Tests

The overlay needs high coverage before integration is considered complete:

- overlay unit tests for read, write, copy-up, whiteout, readdir merge, chmod, chown, symlink, readlink, unlink, rmdir, and rename
- permission tests for owner/group/other semantics on base and upper entries
- security tests proving runtime uid `1000` cannot shadow or replace root-owned `/bin`, `/etc`, or executable base entries
- persistence tests for upper state, whiteouts, symlinks, and base-id mismatch
- sandbox tests that boot from a base root, write only to upper, fork with isolated upper state, and keep base files unchanged

## Import Strategy

Use Codepod's `feature/vfs-root-overlay` branch as the behavioral source, but adapt names and boundary assumptions to Yurt. Port in small slices:

1. root provider interfaces and test helpers
2. overlay VFS with unit tests
3. serializer/persistence support
4. sandbox base-root boot integration
5. security and fork regression tests

Do not import sandbox pooling or orchestration behavior.
