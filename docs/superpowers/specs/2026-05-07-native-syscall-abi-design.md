# Native Syscall ABI for Yurt Host Imports - Design

**Date:** 2026-05-07
**Status:** Approved direction, pending implementation plan
**Supersedes:** `2026-05-07-flatbuffers-syscalls-design.md`

## Decision

Yurt's kernel ABI should use the WebAssembly host import boundary directly. Core Wasm imports already provide the optimized function-call mechanism: C and Rust guests call imported functions, the engine transfers scalar arguments, and host code reads or writes guest linear memory only when the call needs variable-size data.

Do **not** add a schema layer by default. JSON is removed. FlatBuffers is not the target ABI unless a future external-versioning need appears.

## Motivation

The JSON-era ABI made every structured call pay for parse/stringify, escaping, base64 for binary payloads, and hand-written C JSON helpers. FlatBuffers fixes several of those costs, but it is still an extra abstraction on top of an already well-designed Wasm import interface.

The rational ABI is:

- scalar imports for scalar syscalls;
- pointer/length pairs for strings and byte buffers;
- C-layout structs or small offset-table records in guest memory when a call needs compound data;
- return values that follow POSIX-style errno conventions.

The ABI should be easy to call from C, Rust, and TypeScript without runtime schema dependencies.

## Scope

### In scope

- Remove every JSON host-call payload and every `writeJson` / `JSON.parse` compatibility path at the kernel ABI boundary.
- Remove the current FlatBuffers host-call payloads added during the cutover and replace them with native import signatures or native memory records.
- Keep buffer/pointer processing at the host boundary. Rust/Wasmtime decodes through `wasmtime::Caller`; TypeScript decodes in the Deno/browser fallback. Guest code only calls imports and uses small local libc wrappers/builders where needed.
- Keep pure scalar imports scalar.
- Convert canaries and runtime shims to the new ABI. No legacy JSON canaries.
- Keep shell/bash as a normal guest process. The only special fact is that TypeScript may start it from outside with a TTY; it does not get a separate ABI.
- Preserve POSIX errno behavior: success returns non-negative values; failures return negative errno at the host import boundary or set guest `errno` in C wrappers as appropriate.

### Out of scope

- Backwards compatibility with JSON callers.
- FlatBuffers schema evolution.
- External plugin ABI versioning.
- Streaming redesign for very large payloads.
- `setjmp` / `longjmp`, pthread, mutex, and condvar opaque-state imports. These continue to pass opaque guest pointers or scalar ids as required by their C compatibility contracts.

## ABI Rules

### Return Convention

Host imports use one of these conventions:

- `>= 0`: success. The value is a byte count, fd, pid, boolean-as-0/1, or required output size depending on the call.
- `< 0`: failure as negative POSIX errno, for example `-ENOENT`, `-EBADF`, `-EAGAIN`, `-EOVERFLOW`.

Structured outputs use retry sizing: if the output buffer is too small, the host returns the required size as a positive integer and does not partially commit the response.

Stream I/O follows POSIX semantics instead. `host_read_fd`, `host_write_fd`, `host_socket_recv`, and `host_socket_send` may complete partially. They return the number of bytes actually read or written, `0` for EOF on reads, or negative errno for failure. Nonblocking calls return `-EAGAIN` when no progress can be made. These calls never use required-size retry semantics because doing so would force buffering/draining behavior and break nonblocking operation.

### Strings And Bytes

Strings are UTF-8 byte spans: `(ptr, len)`. They are not NUL-terminated at the ABI boundary.

Byte buffers are raw spans: `(ptr, len)`. Binary data is never base64 encoded.

Structured outputs use `(out_ptr, out_cap)` and return the number of bytes required or written. Stream outputs use `(out_ptr, out_cap)` and return the number of bytes actually transferred.

## ABI Contract Source

The ABI contract is a generated and inspectable artifact set:

- `abi/contract/yurt_abi.toml` is the authoritative human-readable contract. It lists every import, argument type, return convention, struct, record, constant, errno mapping, and doc comment.
- `docs/abi/generated/yurt_abi.h`, `docs/abi/generated/native_abi_generated.rs`, and `docs/abi/generated/native-generated.ts` are generated from the contract and committed as proposed target ABI reference artifacts.
- `docs/abi/native-syscall-abi.md` is generated from the same contract so reviewers can inspect the complete ABI in one place.
- CI runs the generator and fails if generated artifacts drift.

The contract generator is deliberately small and repo-local. It does not introduce a runtime schema dependency; it is only a build/review tool for keeping the proposed C guest header, Rust host metadata, TS host metadata, and documentation views identical. Until each import family is migrated, the generated views must stay out of live runtime/header paths such as `abi/include/yurt_abi.h`, `packages/runtime-wasmtime/src/wasm/`, and `packages/kernel/src/host-imports/`.

### Fixed Struct Outputs

When a syscall naturally returns a fixed-size C structure, the ABI writes that C-layout structure directly:

- `host_getrlimit(resource, out_ptr, out_len) -> i32`
- `host_tcgetattr(fd, out_ptr, out_len) -> i32`
- `host_get_winsize(fd, out_ptr, out_len) -> i32`
- `host_sched_getaffinity(pid, mask_ptr, mask_len) -> i32`

The C shim owns the struct layout and validates `out_len`.

### Variable Compound Records

Calls that need arrays or mixed fields use a small native record in guest memory. Records are little-endian and versioned by a header:

```c
typedef struct {
  uint32_t size;
  uint16_t version;
  uint16_t flags;
} yurt_abi_record_header;
```

Records use offsets relative to the start of the record, not guest absolute pointers, so a single `(ptr, len)` identifies the complete request. Offset `0` means absent where allowed.

Validation is part of the ABI, not guest responsibility. Rust/Wasmtime host imports and TS fallback imports must enforce the same rules:

- `header.size` is the logical initialized record size, not allocation capacity.
- `header.size <= req_len` and `header.size >= min_size_for(version)`.
- All offsets and `offset + len` calculations are checked for integer overflow.
- Every referenced span must land wholly within `header.size`.
- All vector counts must fit within `header.size`; count multiplication is overflow-checked before indexing.
- All multi-byte scalar fields and vector entries are 4-byte aligned. Unaligned offsets are invalid.
- Strings are UTF-8 byte spans. Interior NUL bytes are allowed because ABI strings are not C strings; C shims that need C strings must copy and append their own terminator.
- Duplicate references and overlapping spans are allowed for immutable input data.
- Unknown record versions are invalid until explicitly added to the contract.

Example pattern for spawn:

```c
typedef struct {
  yurt_abi_record_header header;
  uint32_t prog_off;
  uint32_t argv0_off;
  uint32_t args_vec_off;
  uint32_t env_vec_off;
  uint32_t cwd_off;
  int32_t stdin_fd;
  int32_t stdout_fd;
  int32_t stderr_fd;
  uint32_t pass_fds_vec_off;
} yurt_spawn_request_v1;
```

String vectors are count-prefixed arrays of `{ off, len }`. Env vectors are count-prefixed arrays of `{ key_off, key_len, value_off, value_len }`.

### Path Operations

Path-based mutators should not be forced into a generic request envelope. Use direct import signatures:

- `host_chdir(path_ptr, path_len) -> i32`
- `host_chmod(path_ptr, path_len, mode) -> i32`
- `host_chown(path_ptr, path_len, uid, gid, follow_symlinks) -> i32`
- `host_mkdir(path_ptr, path_len, mode) -> i32`
- `host_remove(path_ptr, path_len, flags) -> i32`
- `host_rename(from_ptr, from_len, to_ptr, to_len) -> i32`
- `host_symlink(target_ptr, target_len, link_ptr, link_len) -> i32`

This is closer to the underlying POSIX shape and avoids unnecessary envelope allocation.

### Wait Family

The wait family folds into one import:

```c
host_wait(pid, flags, out_ptr, out_len) -> i32
```

- `pid > 0`: wait for that child.
- `pid <= 0`: wait-any semantics for the caller's children.
- `flags & YURT_WAIT_NOHANG`: nonblocking.
- On success, host writes a fixed `yurt_wait_result_v1 { int32_t pid; int32_t exit_code; int32_t signal; int32_t flags; }`.
- If no child is ready under `NOHANG`, return `-EAGAIN`.
- If there are no children, return `-ECHILD`.

### Process Spawn

Spawn remains a compound record because argv/env/pass-fds are variable-sized:

```c
host_spawn(req_ptr, req_len, out_ptr, out_len) -> i32
```

On success, host writes `yurt_spawn_result_v1 { int32_t pid; }` and returns its size. On failure, it returns negative errno.

### Command Execution

`host_run_command` is **not** part of the native kernel ABI. Shell execution is represented by spawning a normal guest process such as `/bin/sh`, `/bin/bash`, or another registered executable with pipes for stdin/stdout/stderr.

The existing `yurt_system`, `yurt_popen`, Python subprocess shim, and PID-1 command helpers are compatibility layers. They must be implemented in terms of `host_spawn`, `host_pipe`, `host_write_fd`, `host_read_fd`, and `host_wait`, not by adding a command-execution syscall at the host boundary.

### File And Socket I/O

File and socket byte movement should be direct:

- `host_read_fd(fd, out_ptr, out_cap) -> i32`
- `host_write_fd(fd, data_ptr, data_len) -> i32`
- `host_socket_send(fd, data_ptr, data_len, flags) -> i32`
- `host_socket_recv(fd, out_ptr, out_cap, flags) -> i32`

Socket metadata calls can stay scalar or fixed-struct where possible:

- `host_socket_connect(fd, host_ptr, host_len, port, flags) -> i32`
- `host_socket_bind(fd, host_ptr, host_len, port) -> i32`
- `host_socket_addr(fd, which, out_ptr, out_len) -> i32`
- `host_socket_option(fd, option, has_value, value) -> i32`

## TypeScript Host Side

TypeScript host imports should become direct host-boundary adapters:

- receive scalar import arguments from V8;
- decode pointer/span inputs and native records in TypeScript where a browser-style runtime requires it;
- perform host policy/state operations that still live in TypeScript, such as VFS, process kernel, network bridge, and socket backend calls;
- encode structured responses directly into guest memory when the syscall cannot be expressed as a direct scalar or byte-span return.

Do not parse request JSON at the ABI boundary. Do not build response JSON at the ABI boundary.

Memory views must be re-derived after any `await`, because `WebAssembly.Memory.grow()` can invalidate old views.

## Rust/Wasmtime Host Side

Do not add a shared guest-facing ABI codec crate. The Wasmtime host is the optimized path and should decode at the import boundary:

- Host imports receive scalar arguments from Wasmtime.
- Import handlers read/write guest linear memory through `wasmtime::Caller`.
- Small Rust helper functions may live next to the import handlers for local parsing, bounds checks, and fixed-output writes.
- Generated Rust metadata in `docs/abi/generated/native_abi_generated.rs` provides constants and C-layout structs for the proposed host implementation. Implementation tasks copy or install only the pieces whose import family has actually been cut over.

The Wasmtime runtime is the preferred implementation path because Rust can receive the host-call scalars and read/write guest memory directly through `wasmtime::Caller`. Deno and browser JavaScript remain supported as the minimum JS-family fallback: they decode native records in TypeScript because browser-style runtimes cannot hand guest memory pointers to native Rust without adding a platform-specific bridge. That extra JS-side cost is acceptable and should not drive the server/Wasmtime ABI design. Deno is the primary automated test target for this fallback because it provides a browser-like WebAssembly environment with easier filesystem/process-driven tests.

## C/Rust Guest Side

The generated C ABI reference is `docs/abi/generated/yurt_abi.h`, produced from `abi/contract/yurt_abi.toml`, with:

- import declarations;
- record structs;
- constants for flags and record versions;
- small local builders for offset-table records where a compound request is unavoidable.

Guest code should not depend on a general ABI codec library. It calls host imports. C shims only exist to present libc/POSIX-compatible functions on top of those imports. The live `abi/include/yurt_abi.h` remains the shipped ABI header until the corresponding native cutover installs matching declarations and implementations.

Rust std patches call the same imports through `extern "C"` declarations or through libc wrappers. No generated schema bindings are needed.

## Migration

1. Create `abi/contract/yurt_abi.toml` and a generator that emits C guest, Rust host, TS host, and Markdown views of the contract.
2. Generate `docs/abi/generated/yurt_abi.h`, `docs/abi/generated/native_abi_generated.rs`, and `docs/abi/generated/native-generated.ts` from the contract as proposed reference artifacts.
3. Convert TS host imports one family at a time to native signatures and decode pointer/span inputs in TS fallback code.
4. Convert Rust/Wasmtime host imports one family at a time to native signatures and decode pointer/span inputs in import handlers.
5. Convert C ABI shims and Rust std call sites to those signatures without adding a guest codec framework.
6. Remove `host_run_command` from the kernel ABI and implement command compatibility through spawn/pipe/wait.
7. Delete FlatBuffers helpers and generated bindings once no import uses them.
8. Delete JSON helpers, `writeJson`, and all legacy JSON host branches.
9. Rebuild C canaries, Rust canaries, Rust std canaries, and bash fixtures.
10. Run ABI, host-import, fixture, and shell/process tests.
11. Add grep-based CI checks that reject `writeJson`, ABI-boundary `JSON.parse`, FlatBuffers host imports, `host_run_command`, and old wait imports.

## Test Strategy

- Unit tests for each host import family using direct memory buffers.
- Contract drift tests that regenerate `docs/abi/generated/yurt_abi.h`, Rust generated layouts, TS fallback layouts, and `docs/abi/native-syscall-abi.md` and compare them to the checked-in files.
- Cross-parser fixtures: a shared corpus of valid and malformed native record bytes must produce identical decoded values or identical negative errno from Rust/Wasmtime host parsers and TS fallback parsers.
- ABI canaries for C and Rust std.
- Memory-growth-across-await test for every async import that reads request bytes.
- Grep canaries:
  - no `writeJson` under `packages/kernel/src/host-imports`;
  - no `JSON.parse(readString(...))` at host import boundaries;
  - no `host_waitpid`, `host_waitpid_nohang`, `host_wait_any`, or `host_wait_any_nohang`;
  - no `host_run_command`;
  - no `abi/src/*json*` helper functions.

## Open Questions

- Exact record layouts for process-list filters.
- Whether all socket operations should be split into direct scalar signatures, or whether a few rare metadata operations deserve compact records.
