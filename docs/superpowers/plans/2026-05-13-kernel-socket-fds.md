# Kernel Socket Fds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make socket operations in the Rust kernel use POSIX-visible kernel file descriptors instead of leaking raw kernel-host socket handles.

**Architecture:** Mirror the existing pipe/OFD model: store host socket handles in a kernel registry with refcounts, put only socket ids in each process fd table, and make close/dup/poll operate on those fd entries. Preserve the current typed `env.sys_socket_*` ABI for this slice; AF_UNIX-specific address coverage follows from the same fd ownership model instead of from guest-side fd shims.

**Tech Stack:** Rust kernel wasm crate, existing kernel-host socket imports, ABI shim tests.

---

### Task 1: Add Kernel Socket Registry

**Files:**
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Test: `packages/kernel-wasm/src/dispatch.rs`

- [x] **Step 1: Write failing dispatch tests**

Add tests that call `METHOD_SYS_SOCKET_CONNECT`, assert the returned fd is the process's lowest free fd, then `dup` and `close` it. The test should fail before implementation because connect currently returns the raw native KH stub result.

- [x] **Step 2: Run the focused test**

Run: `cargo test -p yurt-kernel-wasm socket_fd -- --nocapture`
Expected: FAIL because no `FdEntry::Socket` exists and `sys_socket_connect` does not install into the fd table.

- [x] **Step 3: Implement registry and refcounts**

Add `FdEntry::Socket { id: u64 }`, `SocketEntry { handle: i32, refs: u32, domain: u8, sock_type: u8 }`, `Kernel::create_socket`, `socket`, `socket_inc_ref`, and `socket_dec_ref`. `socket_dec_ref` should return the host handle only when refs hit zero, so dispatch can call `kh::socket_close` outside the registry mutation path.

- [x] **Step 4: Wire close/dup/dup2**

Update `close_fd`, `dup_fd`, and `dup2_fd` to decrement/increment socket refs just like pipes and OFDs. Closing the last reference must call `kh::socket_close(handle)`.

- [x] **Step 5: Run focused tests**

Run: `cargo test -p yurt-kernel-wasm socket_fd -- --nocapture`
Expected: PASS.

### Task 2: Convert Socket Syscalls To Kernel Fds

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Test: `packages/kernel-wasm/src/dispatch.rs`

- [x] **Step 1: Write failing syscall tests**

Add tests for `sys_socket_send`, `sys_socket_recv`, `sys_socket_addr`, `sys_socket_accept`, and `sys_socket_close` using kernel fd inputs. Include non-socket fd and closed-fd cases that return `-EBADF`.

- [x] **Step 2: Run the focused test**

Run: `cargo test -p yurt-kernel-wasm socket_syscalls -- --nocapture`
Expected: FAIL because send/recv/addr/accept/close currently interpret the fd as a raw host handle.

- [x] **Step 3: Resolve fd to host handle in dispatch**

Add a helper that looks up `FdEntry::Socket { id }` for the caller pid and returns the stored host handle or `-EBADF`. Use it for send/recv/addr/accept. `sys_socket_accept` should validate that the listener fd is a socket, call `kh::socket_accept`, and install the accepted host handle as a new kernel fd.

- [x] **Step 4: Keep `sys_socket_close` fd-based**

Implement `sys_socket_close` by delegating to the same fd close logic as `METHOD_SYS_CLOSE`, preserving POSIX close semantics and fd refcounts.

- [x] **Step 5: Run focused tests**

Run: `cargo test -p yurt-kernel-wasm socket_syscalls -- --nocapture`
Expected: PASS.

### Task 3: Poll Socket Readiness Baseline

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Test: `packages/kernel-wasm/src/dispatch.rs`

- [x] **Step 1: Write failing poll tests**

Add tests that poll a live socket fd for `POLLOUT` and a closed fd for `POLLNVAL`. Add a read-readiness test only if the kernel-host import can probe without consuming data.

- [x] **Step 2: Run the focused test**

Run: `cargo test -p yurt-kernel-wasm poll_socket -- --nocapture`
Expected: FAIL because `poll_revents_for_fd` has no socket arm.

- [x] **Step 3: Implement socket poll arm**

For `FdEntry::Socket`, return `POLLOUT` when requested and the socket id resolves. Return `POLLNVAL` for stale socket ids. Do not fake `POLLIN` unless there is a non-consuming readiness probe; keep that as a separate AF_UNIX/IP readiness enhancement if needed.

- [x] **Step 4: Run focused tests**

Run: `cargo test -p yurt-kernel-wasm poll_socket -- --nocapture`
Expected: PASS.

### Task 4: ABI And Integration Check

**Files:**
- Modify only if tests reveal stale docs/contracts: `abi/contract/yurt_abi_methods.toml`
- Test: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`

- [x] **Step 1: Update method docs**

Change socket method docs from “handle” wording to “kernel fd” wording where applicable.

- [x] **Step 2: Run crate checks**

Run: `cargo test -p yurt-kernel-wasm socket -- --nocapture`
Expected: PASS.

Run: `cargo test -p runtime-wasmtime kernel_wasm_trampoline -- --nocapture`
Expected: PASS.

- [x] **Step 3: Format and broader verification**

Run: `cargo fmt --all -- --check`
Expected: PASS.

Run: `cargo clippy --all-targets -- -D warnings`
Expected: PASS.

Run: `cargo test --tests`
Expected: PASS.

### Task 5: POSIX Socket Error Matrix

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Follow-up integration target: `abi/conformance/c/`
- Follow-up suite target: `https://github.com/bytecodealliance/open-posix-test-suite`

- [x] **Step 1: Check POSIX error contracts**

Use the POSIX man pages as the source of truth for common descriptor/socket
errors:

- `EBADF`: fd is not a valid open file descriptor.
- `ENOTSOCK`: fd is valid, but does not refer to a socket.
- `ENOTCONN`: connection-mode socket is not connected.
- `EINVAL`: `accept()` is called on a socket that is not accepting connections.
- `EOPNOTSUPP`: operation is unsupported for the socket type, such as
  `listen()`/`accept()` on a datagram socket.

- [x] **Step 2: Add fd-table unit coverage**

Add Rust kernel tests that exercise all socket syscall entry points with
unopened fds and valid file fds. The tests must assert both the errno and that
no kernel-host socket backend call occurred.

- [x] **Step 3: Add socket-state unit coverage**

Add Rust kernel tests for ordinary POSIX misuse:

- `recv()` on an open-but-unconnected stream socket returns `-ENOTCONN`.
- `read()` on the same socket returns `-ENOTCONN` through the unified fd path.
- `accept()` on an open stream socket that has not been listened on returns
  `-EINVAL`.
- `accept()` on a datagram socket returns `-EOPNOTSUPP`.

- [x] **Step 4: Promote selected rows to C ABI canaries**

Add C conformance cases under `abi/conformance/c/` so libc callers observe the
same errno values through POSIX APIs. Start with:

- `listen()` on a regular file fd returns `ENOTSOCK`.
- `accept()` on a regular file fd returns `ENOTSOCK`.
- `recv()`/`read()` on an unconnected stream socket returns `ENOTCONN`.
- `accept()` on an unlistened stream socket returns `EINVAL`.

- [ ] **Step 5: Add an optional formal POSIX suite harness**

Evaluate `bytecodealliance/open-posix-test-suite` as a slow-tier POSIX
conformance source. Keep it outside the fast pre-push tests; run it as a
guest-compat or manually triggered CI job once the syscall surface is broad
enough to make failures actionable.

### Task 6: Mine Open POSIX Suite For Threading Coverage

**Files:**
- Modify: `abi/conformance/c/pthread-canary.c`
- Modify: `packages/kernel/src/process/threads/cooperative-serial.ts`
- Test: `packages/kernel/src/process/__tests__/cooperative-serial_test.ts`

- [x] **Step 1: Inventory the upstream suite surface**

`bytecodealliance/open-posix-test-suite` currently emphasizes pthreads,
signals, sched, semaphores, mqueues, and timers rather than sockets. The first
useful pthread assertions are `pthread_self`, `pthread_equal`, `pthread_create`,
and default joinability.

- [x] **Step 2: Port pthread identity assertions into the local canary**

Extend `pthread-canary` with equivalent local checks:

- a child thread's `pthread_self()` equals the `pthread_t` returned by
  `pthread_create()`;
- child and main `pthread_t` values are distinct;
- two live joinable threads have distinct `pthread_t` values;
- a thread created with `attr == NULL` is joinable by default.

- [x] **Step 3: Fix the cooperative backend gap exposed by the canary**

The two-live-thread assertion failed because `CooperativeSerialBackend` capped
live spawned threads at one even though it already has bounded per-thread slot
and stack allocation. Replace that artificial limit with the existing slot
limit and add a backend regression test that creates two joinable threads before
joining either one.
