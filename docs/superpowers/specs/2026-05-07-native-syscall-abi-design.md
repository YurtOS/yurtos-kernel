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

The ABI should be easy to call from C, Rust, and TypeScript without generated bindings.

## Scope

### In scope

- Remove every JSON host-call payload and every `writeJson` / `JSON.parse` compatibility path at the kernel ABI boundary.
- Remove the current FlatBuffers host-call payloads added during the cutover and replace them with native import signatures or native memory records.
- Move the buffer/pointer processing logic into Rust. TypeScript may own high-level sandbox policy and existing V8 import registration for now, but native ABI record parsing, fixed-struct writing, errno mapping, and byte-span helpers live in a reusable Rust ABI core crate.
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

If an output buffer is too small, the host returns the required size as a positive integer and does not partially commit the response unless the call explicitly documents partial writes.

### Strings And Bytes

Strings are UTF-8 byte spans: `(ptr, len)`. They are not NUL-terminated at the ABI boundary.

Byte buffers are raw spans: `(ptr, len)`. Binary data is never base64 encoded.

Outputs use `(out_ptr, out_cap)` and return the number of bytes required or written.

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

`host_run_command` should not be a JSON command object. Use a native record:

```c
host_run_command(req_ptr, req_len, out_ptr, out_cap) -> i32
```

The request record carries `cmd`, optional `cwd`, optional stdin bytes, stdin fd, and env. The response record carries exit code and offset spans for stdout/stderr bytes. If `out_cap` is too small, return required size.

Longer term, shell-like execution should prefer spawning `/bin/sh` or `/bin/bash` as a normal process rather than adding host-side shell semantics.

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

TypeScript host imports should become thin adapters:

- receive scalar import arguments from V8;
- call the Rust ABI core for request decoding, fixed-struct writing, and output sizing;
- perform host policy/state operations that still live in TypeScript, such as VFS, process kernel, network bridge, and socket backend calls;
- call the Rust ABI core to encode structured responses when the syscall cannot be expressed as a direct scalar or byte-span return.

Do not parse request JSON at the ABI boundary. Do not build response JSON at the ABI boundary.

Memory views must be re-derived after any `await`, because `WebAssembly.Memory.grow()` can invalidate old views.

## Rust ABI Core

Add a Rust crate, `abi/rust/yurt-abi-core`, that owns the ABI record and memory rules:

- `GuestMemory` trait for reading and writing guest linear memory without depending on V8, Deno, or Wasmtime.
- `decode` modules for native records such as spawn and run-command.
- `encode` modules for fixed outputs such as wait results, pipe results, process lists, socket addresses, stat metadata, and command results.
- `errno` module with POSIX errno constants shared by Rust and generated C headers.
- host-runtime helpers that can be used directly by `packages/runtime-wasmtime`.

The crate is a normal Rust library for tests and the Wasmtime runtime. It also exposes a narrow C ABI or generated header surface only where the C guest runtime needs builders for compound records. The old `yurt-abi-fb` crate is deleted once the native core is in place.

## C/Rust Guest Side

The C ABI runtime owns a small header, `abi/include/yurt_abi.h`, generated or checked against the Rust ABI core, with:

- import declarations;
- record structs;
- constants for flags and record versions;
- inline builders for offset-table records where useful.

Rust std patches call the same imports through `extern "C"` declarations or through libc wrappers. No generated schema bindings are needed.

## Migration

1. Create `abi/rust/yurt-abi-core` by reusing the Rust ABI crate structure from the `rust-abi-pilot` worktree and the FFI boundary lessons from `rust-abi-high-impact`, but without FlatBuffers.
2. Add `abi/include/yurt_abi.h` with native ABI structs, flags, and import declarations, sourced from or checked against the Rust ABI core.
3. Convert TS host imports one family at a time to native signatures and delegate record/struct work to the Rust ABI core adapter.
4. Convert C ABI shims and Rust std call sites to those signatures.
5. Delete FlatBuffers helpers and generated bindings once no import uses them.
6. Delete JSON helpers, `writeJson`, and all legacy JSON host branches.
7. Rebuild C canaries, Rust canaries, Rust std canaries, and bash fixtures.
8. Run ABI, host-import, fixture, and shell/process tests.
9. Add grep-based CI checks that reject `writeJson`, ABI-boundary `JSON.parse`, FlatBuffers host imports, and old wait imports.

## Test Strategy

- Unit tests for each host import family using direct memory buffers.
- Rust ABI core unit tests for each record decoder and fixed-output writer using an in-memory `GuestMemory` implementation.
- Cross-check tests that `abi/include/yurt_abi.h` constants and struct sizes match Rust ABI core constants.
- ABI canaries for C and Rust std.
- Memory-growth-across-await test for every async import that reads request bytes.
- Grep canaries:
  - no `writeJson` under `packages/kernel/src/host-imports`;
  - no `JSON.parse(readString(...))` at host import boundaries;
  - no `host_waitpid`, `host_waitpid_nohang`, `host_wait_any`, or `host_wait_any_nohang`;
  - no `abi/src/*json*` helper functions.

## Open Questions

- Whether `host_run_command` survives long term or becomes a compatibility layer over spawning a shell process.
- Exact record layouts for command execution and process listing.
- Whether all socket operations should be split into direct scalar signatures, or whether a few rare metadata operations deserve compact records.
