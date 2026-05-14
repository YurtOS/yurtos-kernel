# Rust Kernel AF_UNIX Path Stream Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Rust-kernel AF_UNIX pathname stream listener/connect/accept support without routing through the legacy TypeScript Unix socket registry.

**Architecture:** Reuse the existing binary `sys_socket_listen`, `sys_socket_connect`, `sys_socket_accept`, `sys_socket_send`, and `sys_socket_recv` method family. A `unix:` address prefix selects the in-kernel AF_UNIX path registry. Listener sockets own a pending accepted-end queue; connect creates a Unix stream pair, returns the client fd, and queues the server endpoint until accept installs it in the caller fd table.

**Tech Stack:** Rust kernel wasm crate, existing KHI syscall wrappers, Wasmtime user-process tests.

---

### Task 1: Kernel AF_UNIX Path Streams

**Files:**
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/kernel-wasm/src/abi.rs`
- Modify: `packages/kernel-wasm/src/kh.rs`

- [x] **Step 1: Add failing kernel dispatch tests**

Add tests for `unix:` listen/connect/accept round-tripping bytes, missing listeners, full backlog, and closing a listener with a pending client.

- [x] **Step 2: Verify red**

Run: `cargo test -p yurt-kernel-wasm af_unix_path_stream -- --nocapture`
Expected: FAIL because `sys_socket_listen` still routes `unix:` through the host TCP mock.

- [x] **Step 3: Add kernel listener state**

Add a `UnixListener` socket kind, a path-to-listener map, listener creation, connect queueing, accept draining, and listener close cleanup.

- [x] **Step 4: Route syscalls**

Route `sys_socket_listen`, `sys_socket_connect`, `sys_socket_accept`, `sys_poll`, close, send, and recv for Unix listener/stream socket kinds. Host sockets continue using `kh_socket_*`.

- [x] **Step 5: Verify focused kernel tests**

Run: `cargo test -p yurt-kernel-wasm af_unix_path_stream -- --nocapture`
Expected: PASS.

### Task 2: Runtime Coverage

**Files:**
- Modify: `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`

- [x] **Step 1: Add Wasmtime user-process test**

Add a WAT user module that imports `sys_socket_listen`, `sys_socket_connect`, `sys_socket_accept`, `sys_socket_send`, and `sys_socket_recv`, then round-trips bytes over an AF_UNIX pathname stream.

- [x] **Step 2: Verify focused runtime test**

Run: `cargo test -p yurt-runtime-wasmtime user_process_af_unix_path_stream -- --nocapture`
Expected: PASS.

### Task 3: Verification

- [x] **Step 1: Run kernel tests**

Run: `cargo test -p yurt-kernel-wasm --lib`
Expected: PASS.

- [x] **Step 2: Run runtime focused tests**

Run: `cargo test -p yurt-runtime-wasmtime user_process_af_unix_path_stream -- --nocapture`
Expected: PASS.

Run: `cargo test -p yurt-runtime-wasmtime user_process_socketpair -- --nocapture`
Expected: PASS.

- [x] **Step 3: Run Rust gates**

Run: `cargo fmt --all -- --check`
Expected: PASS.

Run: `cargo clippy --all-targets -- -D warnings`
Expected: PASS.

Run: `cargo test --tests`
Expected: PASS.
