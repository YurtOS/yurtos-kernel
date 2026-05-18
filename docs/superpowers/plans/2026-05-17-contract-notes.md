# Contract notes: SYS_SPAWN encoding + guest spawn/wait convention

**Date:** 2026-05-17
**Branch:** `claude/remove-typescript-kernel-CUcuf`
**Task:** Task 1 discovery spike — pins two byte-level contracts before later
coding tasks.

---

## (a) Confirmed `SYS_SPAWN` request byte layout

**Source:** `packages/kernel-wasm/src/dispatch/process.rs:1236–1269`
**Cross-checked against:**
- `packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts:74–94`
  (`encodeSysSpawnRequest` helper)
- `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs:1610–1616`
  (identical manual encoding in Rust tests)

### The layout `sys_spawn` parses (kernel-internal wire format)

This is the byte sequence that `kernel.syscall(SYS_SPAWN, callerPid, request)`
consumes. It is **distinct** from the `yurt_spawn_request_v1` struct used by
`host_spawn` (see §b below).

```
offset 0        : u32 LE  path_len
offset 4        : [u8; path_len]   UTF-8 path (e.g. b"/bin/echo")
offset 4+path_len : repeated for each argv entry:
                    u32 LE  arg_len
                    [u8; arg_len]  UTF-8 arg bytes
```

**No argc field.** The kernel parses args by consuming `u32 alen + alen bytes`
in a loop until the buffer is exhausted. There is no explicit count prefix.

This **differs from the spec's stated layout** (`u32 path_len + path + u32 argc
+ (u32 len + arg)*`). The spec incorrectly included an `argc` field. The source
wins: there is no `argc`. The kernel loop (`process.rs:1250–1269`) reads `u32
alen` then `alen` bytes, repeating until the cursor cannot advance by 4 more
bytes. The argv entries appended to `PendingSpawn.argv` exclude the path itself
(the path is only in `raw_path`).

**Method constant:** `SYS_SPAWN = 0x1_002F`
(source: `packages/kernel-host-interface-js/mod.ts:178`,
`packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs:188`)

### Minimal encoding (Rust, confirmed from trampoline tests)

```rust
let path: &[u8] = b"/bin/echo";
let mut req = (path.len() as u32).to_le_bytes().to_vec();
req.extend_from_slice(path);
for arg in [b"echo".as_slice(), b"hi".as_slice()] {
    req.extend_from_slice(&(arg.len() as u32).to_le_bytes());
    req.extend_from_slice(arg);
}
// req is now the complete SYS_SPAWN request
```
(verbatim from `kernel_wasm_trampoline.rs:1611–1616`)

### `drain_spawn` response layout (host reads this back)

Source: `packages/kernel-wasm/src/dispatch/process.rs:1365–1398`

```
offset 0              : u32 LE  child_pid
offset 4              : u32 LE  wasm_len
offset 8              : [u8; wasm_len]  wasm image bytes
offset 8+wasm_len     : u32 LE  argc
offset 12+wasm_len    : repeated argc times:
                          u32 LE  arg_len
                          [u8; arg_len]
```

Total bytes written = `4 + 4 + wasm_len + 4 + Σ(4 + arg_len)`.
The `drain_spawn` call returns `need` (the required buffer size) when the
buffer is too small, so the host must retry with a suitably-sized buffer.

---

## (b) Confirmed guest spawn+wait API for `wasm32-wasip1` fixtures

**Sources:**
1. `test-fixtures/yurt-process/src/lib.rs` — the canonical Rust helper crate
   for wasm32-wasip1 fixtures (the new fixture should depend on this crate).
2. `abi/src/yurt_runtime.h:127–135` — the C-ABI declarations.
3. `abi/include/yurt_abi.h:60–95` — the struct definitions.
4. `abi/src/yurt_spawn.c` — `posix_spawn(3)` built on top of `host_spawn`.
5. `abi/src/yurt_process.c:103–123` — `waitpid(2)` built on top of `host_wait`.

### Option A — Use the `yurt-process` crate (recommended for new fixtures)

The existing crate `test-fixtures/yurt-process` wraps `host_spawn`/`host_wait`
into a `Command` builder. This is the pattern used by `shell-exec` and others.

```rust
// Cargo.toml: yurt-process = { path = "../../yurt-process" }
use yurt_process::Command;

fn main() {
    let status = Command::new("/bin/child")
        .arg("child")
        .status()
        .expect("spawn failed");
    println!("child exited: {}", status.code().unwrap_or(-1));
    std::process::exit(0);
}
```

`Command::status()` builds the `yurt_spawn_request_v1`, calls `host_spawn`,
then calls `host_wait(child_pid, 0, ...)` and returns `ExitStatus`.
(source: `test-fixtures/yurt-process/src/lib.rs:272–320`)

### Option B — Direct `extern "C"` block (if the fixture cannot add a dep)

The `yurt_spawn_request_v1` struct is a variable-length record. The simplest
direct approach uses `yurt-process`'s `build_spawn_request` helper, but if
going fully raw, the extern block (confirmed from two independent sources) is:

```rust
#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_spawn(
        req_ptr: *const u8,
        req_len: usize,
        out_ptr:  *mut u8,
        out_cap:  usize,
    ) -> i32;

    fn host_wait(
        pid:     i32,
        flags:   i32,
        out_ptr: *mut u8,
        out_cap: usize,
    ) -> i32;
}
```

Source A (`test-fixtures/yurt-process/src/lib.rs:15–24`):
```
fn host_spawn(req_ptr: *const u8, req_len: usize, out_ptr: *mut u8, out_cap: usize) -> i32;
fn host_wait(pid: i32, flags: i32, out_ptr: *mut u8, out_cap: usize) -> i32;
```

Source B (`abi/src/yurt_runtime.h:127–135`):
```c
__attribute__((import_module("yurt"), import_name("host_spawn")))
int yurt_host_spawn(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_wait")))
int yurt_host_wait(int pid, int flags, int out_ptr, int out_cap);
```

Both import from module `"yurt"` with names `"host_spawn"` and `"host_wait"`.

### `host_spawn` request format (`yurt_spawn_request_v1`)

`host_spawn` does NOT use the kernel-internal `SYS_SPAWN` wire format above.
It expects a `yurt_spawn_request_v1` record (source: `abi/include/yurt_abi.h`):

**Fixed header (88 bytes = `SPAWN_REQUEST_V1_SIZE`):**

| offset | size | field          | notes |
|--------|------|----------------|-------|
| 0      | 4    | `size` (u32 LE)| total record size in bytes |
| 4      | 2    | `version` (u16 LE) | must be `1` (`YURT_ABI_RECORD_VERSION_1`) |
| 6      | 2    | `flags` (u16)  | currently `0` |
| 8      | 8    | `prog` span    | `{u32 off, u32 len}` — program path |
| 16     | 8    | `argv0` span   | `{u32 off, u32 len}` — argv[0] override |
| 24     | 4    | `args_off`     | offset of span array for args[1..] |
| 28     | 4    | `args_count`   | number of entries in args span array |
| 32     | 4    | `env_off`      | offset of env-pair array |
| 36     | 4    | `env_count`    | number of env pairs |
| 40     | 8    | `cwd` span     | `{u32 off, u32 len}` |
| 48     | 4    | `stdin_fd` (i32 LE) | |
| 52     | 4    | `stdout_fd` (i32 LE) | |
| 56     | 4    | `stderr_fd` (i32 LE) | |
| 60     | 4    | `pass_fds_off` | |
| 64     | 4    | `pass_fds_count` | |
| 68     | 8    | `stdin_data` span | `{u32 off, u32 len}` |
| 76     | 4    | `nice` (i32 LE) | |
| 80     | 4    | `fd_map_off`   | |
| 84     | 4    | `fd_map_count` | |

All string/vec data follows after offset 88, 4-byte aligned.

Source: `abi/include/yurt_abi.h:60–78`, confirmed by
`test-fixtures/yurt-process/src/lib.rs:39–57` (named constants),
`packages/kernel/src/host-imports/__tests__/spawn-request-fixture.ts:133–156`
(TypeScript mirror), and `packages/kernel/src/host-imports/kernel-imports.ts:286`
(`SPAWN_REQUEST_V1_SIZE = 88`).

### `host_spawn` return value

`host_spawn` writes a `yurt_spawn_result_v1` record (4 bytes: `i32 pid LE`) to
`out_ptr` and returns the number of bytes written (4) on success, or a negative
errno on failure.  Source: `abi/include/yurt_abi.h:92–95`,
`test-fixtures/yurt-process/src/lib.rs:289–299`.

### `host_wait` request and response

`host_wait(pid, flags, out_ptr, out_cap) -> i32`

- `pid`: the child pid to wait for (> 0), or `0` to wait for any child.
- `flags`: `0` for blocking wait; `YURT_WAIT_NOHANG = 1` for non-blocking.
- Writes a `yurt_wait_result_v1` (16 bytes) into `out_ptr`:
  `{i32 pid, i32 exit_code, i32 signal, i32 flags}` all LE.
- Returns `16` (bytes written) on success, `-EAGAIN` if no child has exited and
  `WNOHANG` was set, `-ECHILD` if no waitable children.

Source: `abi/include/yurt_abi.h:80–85`, `abi/src/yurt_process.c:103–123`,
`packages/kernel-host-interface-deno/wasm-kernel-imports.ts:762–821`.

### `posix_spawn` / `waitpid` (higher-level libc surface)

Both `posix_spawn(3)` and `waitpid(2)` are available on `wasm32-wasip1` in
the yurt abi. They delegate directly to `host_spawn` / `host_wait`:
- `abi/src/yurt_spawn.c:643–654` — `posix_spawn` → `do_posix_spawn` →
  `yurt_host_spawn`
- `abi/src/yurt_process.c:103–123` — `waitpid` → `yurt_host_wait`

For a Rust fixture that links against musl/wasi-sdk, calling `libc::posix_spawn`
or `std::process::Command` is NOT available on `wasm32-wasip1` (wasi-libc stubs
them). The correct approach is either Option A (`yurt-process` crate) or Option B
(direct `extern "C"` block above).

---

## (c) Confirmed `WNOHANG` flag bit value

**Source:** `packages/kernel-wasm/src/dispatch/process.rs:1133`

```rust
const WNOHANG: u32 = 1;
```

Also confirmed in `waitid` at `process.rs:1133` and the abi header:
```c
#define YURT_WAIT_NOHANG 1u   // abi/include/yurt_abi.h:32
```

The C-side `waitpid` maps `WNOHANG` to `YURT_WAIT_NOHANG`:
```c
int flags = (options & WNOHANG) ? (int)YURT_WAIT_NOHANG : 0;
// abi/src/yurt_process.c:106
```

`WNOHANG` bit = `1` (bit 0 of the `flags` word passed to `host_wait`).

---

## Discrepancy from spec

The spec (`docs/superpowers/specs/2026-05-17-js-host-multiprocess-driver-design.md`,
§Imports in `buildUserYurtImports`) states the `SYS_SPAWN` request shape as:
> `u32 path_len + path + u32 argc + (u32 len + arg)*`

**The actual layout has no `argc` field.** Source wins. The kernel parser
(`process.rs:1250–1269`) loops consuming `u32 alen + alen bytes` until the
buffer is exhausted; it does not read an `argc` count. The test helper
`encodeSysSpawnRequest` in `kernel-host-interface_test.ts:74–94` confirms this:
it builds `u32 path_len + path + (u32 arg_len + arg)*` with no argc.

The JS `host_spawn` implementation in `mod.ts` must build this layout exactly
(no argc) when calling `kernel.syscall(METHOD.SYS_SPAWN, ...)`.

---

## Summary for later tasks

| Contract point | Confirmed value | Source |
|---|---|---|
| `SYS_SPAWN` method constant | `0x1_002F` | `mod.ts:178`, trampoline:188 |
| `SYS_SPAWN` wire format | `u32 path_len + path + (u32 alen + arg)*` (no argc) | `process.rs:1236–1269` |
| `drain_spawn` response | `u32 pid + u32 wasm_len + wasm + u32 argc + (u32 alen + arg)*` | `process.rs:1365–1398` |
| `host_spawn` request struct | `yurt_spawn_request_v1`, 88-byte fixed header + variable tail | `yurt_abi.h:60–78` |
| `host_spawn` import module | `"yurt"`, import name `"host_spawn"` | `yurt_runtime.h:127` |
| `host_wait` import module | `"yurt"`, import name `"host_wait"` | `yurt_runtime.h:134` |
| `host_wait` flags: WNOHANG | `1` (bit 0) | `process.rs:1133`, `yurt_abi.h:32` |
| Rust fixture API | `yurt-process::Command` builder or direct `extern "C"` block | `yurt-process/src/lib.rs:15–24` |
| `host_spawn` output | `yurt_spawn_result_v1` (4 bytes: `i32 pid`) | `yurt_abi.h:92–95` |
| `host_wait` output | `yurt_wait_result_v1` (16 bytes: `i32 pid, i32 exit_code, i32 signal, i32 flags`) | `yurt_abi.h:80–85` |
