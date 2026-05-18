# Issue 128 WASI Shim Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue 128 by applying the same host-buffer length cap to older `wasi_shim.rs` guest-controlled allocations and preserving `-EFAULT` from entropy host calls.

**Architecture:** Keep the fix local. Add small private helpers in `packages/runtime-wasmtime/src/wasi_shim.rs` that validate single guest lengths and iovec sums before allocation, returning WASI `EFAULT`. In `packages/kernel-wasm`, preserve negative errno from `kh::fill_random` through `sys_getrandom` and `/dev/random`/`/dev/urandom` reads while documenting the widened contract.

**Tech Stack:** Rust workspace, `yurt-kernel-wasm`, `yurt-runtime-wasmtime`, existing kernel host ABI constants and test modules.

---

### Task 1: WASI Guest Buffer Allocation Guards

**Files:**
- Modify: `packages/runtime-wasmtime/src/wasi_shim.rs`

- [ ] **Step 1: Write failing helper tests**

Add unit tests in `wasi_shim.rs` that assert oversized single lengths and iovec sums return WASI `EFAULT`.

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p yurt-runtime-wasmtime wasi_shim --lib`
Expected: compile failure or failing assertions because the helper functions do not exist yet.

- [ ] **Step 3: Implement minimal guards**

Import `checked_guest_buffer_sum`, add private helper functions, and route `fd_write`, `fd_read`, `path_rename`, `path_link`, and `path_open` guest-controlled allocations through them before `vec!`.

- [ ] **Step 4: Run focused runtime tests**

Run: `cargo test -p yurt-runtime-wasmtime wasi_shim --lib`
Expected: tests pass.

### Task 2: Entropy Errno Fidelity

**Files:**
- Modify: `packages/kernel-wasm/src/kh.rs`
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Modify: `packages/kernel-wasm/src/vfs.rs`
- Modify: `abi/contract/kernel_host_abi.toml`
- Modify: `abi/contract/yurt_abi_methods.toml`

- [ ] **Step 1: Write failing errno tests**

Add tests showing `fill_random` can surface a mocked `-EFAULT`, `sys_getrandom` returns that errno, and `DevBackend::read` returns that errno for random devices.

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p yurt-kernel-wasm --lib random`
Expected: compile failure or failing assertions because test random error injection and errno pass-through are not implemented.

- [ ] **Step 3: Implement minimal errno pass-through**

Teach the native test `kh_random` shim to consume a test override, map `Err(rc) => rc as i64` in the two kernel callers, and update ABI docs to mention `-EFAULT`.

- [ ] **Step 4: Run focused kernel tests**

Run: `cargo test -p yurt-kernel-wasm --lib random`
Expected: tests pass.

### Task 3: Verification

**Files:**
- No additional code files.

- [ ] **Step 1: Format**

Run: `cargo fmt --all -- --check`
Expected: success.

- [ ] **Step 2: Focused package checks**

Run: `cargo clippy -p yurt-runtime-wasmtime --all-targets -- -D warnings`
Run: `cargo clippy -p yurt-kernel-wasm --all-targets -- -D warnings`
Expected: both succeed.

- [ ] **Step 3: Focused tests**

Run: `cargo test -p yurt-runtime-wasmtime wasi_shim --lib`
Run: `cargo test -p yurt-kernel-wasm --lib random`
Expected: both succeed.
