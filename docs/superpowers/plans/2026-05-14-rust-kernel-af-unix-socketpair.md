# Rust Kernel AF_UNIX Socketpair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rust-kernel AF_UNIX `socketpair` primitive that creates two connected kernel fds without using the legacy `yurt.host_socket_*` surface.

**Architecture:** Extend the existing kernel socket registry so sockets can be either host-backed TCP handles or in-kernel AF_UNIX stream endpoints. AF_UNIX stream endpoints own receive queues and peer ids; send/write pushes bytes to the peer queue, recv/read drains the local queue, close marks the peer as hung up, and poll reports readable/hangup/write readiness from kernel state.

**Tech Stack:** Rust kernel wasm crate, generated ABI method ids, existing kernel fd table and poll machinery.

---

### Task 1: Kernel Registry Support

**Files:**
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `abi/contract/yurt_abi_methods.toml`

- [x] **Step 1: Add a failing socketpair test**

Add a dispatch test that calls `METHOD_SYS_SOCKETPAIR`, expects two fds in the response, sends bytes through one fd, receives them from the other fd, and verifies `poll` read/write readiness.

- [x] **Step 2: Run focused test and verify red**

Run: `cargo test -p yurt-kernel-wasm socketpair -- --nocapture`
Expected: FAIL because `METHOD_SYS_SOCKETPAIR` is not defined or returns `-ENOSYS`.

- [x] **Step 3: Add method id and socket registry model**

Add `sys_socketpair` method id `0x1_0044`. Change `SocketEntry` from a raw host handle to a kind enum with `Host { handle }` and `UnixStream { peer_id, rx, peer_open }`. Add `Kernel::create_unix_stream_pair`.

- [x] **Step 4: Route send/recv/read/write/poll/close**

Host-backed sockets keep using `kh_socket_*`. AF_UNIX stream sockets push bytes to the peer queue, drain local bytes on recv/read, return EOF after peer close and empty queue, return `-EPIPE` when sending to a closed peer, and report `POLLIN`/`POLLOUT`/`POLLHUP` from kernel state.

- [x] **Step 5: Run focused tests**

Run: `cargo test -p yurt-kernel-wasm socketpair -- --nocapture`
Expected: PASS.

### Task 2: KHI Runtime Coverage

**Files:**
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs`
- Modify: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`
- Modify: `packages/kernel-host-interface-js/mod.ts`
- Modify: `packages/kernel-host-interface-js/sys_shim.ts`

- [x] **Step 1: Add sys_socketpair imports**

Add the `sys_socketpair` KHI method id and import wrappers for Wasmtime and the JS shim. The request remains a fixed binary buffer, not JSON.

- [x] **Step 2: Add a user-process trampoline test**

Add a Wasmtime user-process test that imports `env.sys_socketpair`, creates two kernel fds, sends bytes through one fd, and receives them from the peer.

- [x] **Step 3: Run focused runtime tests**

Run: `cargo test -p yurt-runtime-wasmtime user_process_socketpair -- --nocapture`
Expected: PASS.

Run: `cargo test -p yurt-runtime-wasmtime kernel_host_interface_method_ids_match_yurt_abi_methods_toml -- --nocapture`
Expected: PASS.

### Task 3: Verification

**Files:**
- Test only after Tasks 1-2.

- [x] **Step 1: Run kernel lib tests**

Run: `cargo test -p yurt-kernel-wasm --lib`
Expected: PASS.

- [x] **Step 2: Run Rust formatting and clippy**

Run: `cargo fmt --all -- --check`
Expected: PASS.

Run: `cargo clippy --all-targets -- -D warnings`
Expected: PASS.
