# Remove Remaining Guest Kernel JSON Design

## Context

PR 35 removed JSON transport from the scoped socket, DNS, fetch,
fd-read, process-list, and extension host imports. A follow-up scan still
found JSON on the guest/kernel boundary in four places:

- `host_native_invoke`
- `host_stat`
- `host_readdir`
- `host_glob`

The goal is not to remove JSON from every project subsystem. JSON remains
valid for metadata files, conformance traces, persistence snapshots,
HTTP/application payloads, runtime-server JSON-RPC, and toolchain sidecars.
The rule is narrower and stricter: a binary running in userland must not use
JSON to communicate with the kernel through WASM host imports.

## Decisions

### Delete `host_native_invoke`

`host_native_invoke` is legacy Python native-module RPC. It is not the
supported extension path. The supported paths are:

- `host_spawn` for host command execution through the process manager.
- `host_extension_invoke` for generic extension/plugin calls, already using
  native request and response records from PR 35.

This change deletes `host_native_invoke` from the TypeScript host import
implementation and parity tests. It does not add a replacement ABI.

### Convert `host_stat` To A Native Record

`host_stat(path_ptr, path_len, out_ptr, out_cap) -> i32` keeps its current
function signature but writes a fixed little-endian record instead of JSON.

Record layout, version 1:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | total record size |
| 4 | u16 | version, `1` |
| 6 | u16 | flags, reserved |
| 8 | u32 | file type bits: bit 0 file, bit 1 dir, bit 2 symlink |
| 12 | u32 | mode |
| 16 | u64 | size |
| 24 | u64 | mtime_ms |

Missing paths continue to return the existing negative error code rather than
returning an `exists: false` JSON object. This matches the current TypeScript
kernel behavior and keeps error handling scalar.

### Convert `host_readdir` And `host_glob` To A Shared String List Record

Both imports keep their current signatures but write the same binary string
list record.

Header layout, version 1:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | total record size |
| 4 | u16 | version, `1` |
| 6 | u16 | flags, reserved |
| 8 | u32 | entry count |
| 12 | u32 | entries offset |
| 16 | u32 | strings offset |
| 20 | u32 | strings length |

Each entry is an 8-byte pair:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | u32 | UTF-8 byte offset relative to `strings_offset` |
| 4 | u32 | UTF-8 byte length |

The string blob is packed UTF-8 bytes without NUL terminators. Empty lists are
valid and have count `0`.

### Remove JSON Helpers From Host Import Memory APIs

`writeJson` is removed from `packages/kernel/src/host-imports/common.ts` and
from `KernelApiMemory`. Tests that still need JSON for application-level data
must use local test helpers, not shared host-import memory APIs.

### Strengthen Boundary Tests

`host-json-boundary_test.ts` expands from the PR 35 scoped list to the full
host-import implementation. Production files under
`packages/kernel/src/host-imports` must not contain `writeJson`, `JSON.parse`,
or `JSON.stringify`. Test files may use JSON to build fixtures or inspect
legacy application payloads.

## Implementation Scope

Modify:

- `packages/kernel/src/host-imports/common.ts`
- `packages/kernel/src/host-imports/kernel-imports.ts`
- `packages/kernel/src/host-imports/__tests__/host-json-boundary_test.ts`
- `packages/kernel/src/host-imports/__tests__/imports-parity_test.ts`
- `packages/kernel/src/host-imports/__tests__/imports-shape_test.ts`
- `packages/kernel/src/kernel-api.ts`
- `packages/runtime-wasmtime/src/wasm/mod.rs`
- `packages/runtime-wasmtime/src/vfs/inode.rs`
- `test-fixtures/shell-exec/src/host.rs`
- `abi/src/yurt_runtime.h`

Update direct tests that asserted JSON output for `host_stat`,
`host_readdir`, or `host_glob` so they assert the native record layouts.

## Out Of Scope

- Removing JSON from runtime server JSON-RPC in `packages/runtime-wasmtime`.
- Removing JSON from metadata files such as `base-image.json`,
  `*.manifest.json`, or `*.yurtmeta.json`.
- Removing JSON from persistence snapshot encoding.
- Removing JSON from HTTP payload tests or Python/requests `.json()` behavior.
- Replacing process-list JSON. PR 35 already moved the host import transport
  to native records; its public shell API may still render JSON text.

## Verification

Targeted verification:

- Run the boundary test and shape tests covering the converted imports.
- Run `deno check` on the host-import files and tests.
- Run `cargo check -p yurt-runtime-wasmtime`.
- Run the shell-exec fixture tests that exercise stat, readdir, and glob.

Completion still requires the repository gates from `AGENTS.md` before
claiming the branch is done.
