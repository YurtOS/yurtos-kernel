# Rust Kernel Dispatcher Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the oversized Rust kernel dispatcher into focused modules without changing syscall behavior.

**Architecture:** Keep `dispatch::dispatch()` as the single public syscall router, but move domain-specific implementation and tests into `packages/kernel-wasm/src/dispatch/`. The first pass is mechanical: preserve function bodies, names, errno behavior, and tests while reducing per-file size and review scope.

**Tech Stack:** Rust `wasm32-wasip1` kernel crate, Cargo workspace tests, GitHub PR #45.

---

### Task 1: Create Dispatch Module Directory

**Files:**
- Move: `packages/kernel-wasm/src/dispatch.rs` -> `packages/kernel-wasm/src/dispatch/mod.rs`

- [ ] **Step 1: Move the file mechanically**

Run:

```bash
mkdir -p packages/kernel-wasm/src/dispatch
git mv packages/kernel-wasm/src/dispatch.rs packages/kernel-wasm/src/dispatch/mod.rs
```

- [ ] **Step 2: Verify no behavior changed**

Run:

```bash
cargo test -p yurt-kernel-wasm --lib
```

Expected: all existing Rust kernel lib tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/mod.rs
git commit -m "refactor: move dispatcher into module directory"
```

### Task 2: Extract Dispatcher Tests

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Create: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Move the entire `#[cfg(test)] mod tests` body**

Move the test module body from `mod.rs` into `tests.rs`. Replace it in `mod.rs` with:

```rust
#[cfg(test)]
mod tests;
```

At the top of `tests.rs`, keep:

```rust
use super::*;
```

- [ ] **Step 2: Verify tests still compile and pass**

Run:

```bash
cargo test -p yurt-kernel-wasm --lib
```

Expected: all existing Rust kernel lib tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "refactor: split dispatcher tests"
```

### Task 3: Extract Socket Dispatch

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Create: `packages/kernel-wasm/src/dispatch/socket.rs`

- [ ] **Step 1: Move socket helpers and syscalls**

Move these functions/constants into `socket.rs`: `MSG_PEEK`, `datagram_queue_bytes`, `rights_queue_full`, `socket_handle_for_fd`, `socket_id_for_fd`, socket fd install/replace helpers, sockaddr helpers, socket send/recv/sendmsg/recvmsg helpers, `sys_socket_*` functions, and `socket_handle_domain_type_for_fd`.

Add in `mod.rs`:

```rust
mod socket;
```

Import call targets into the router with:

```rust
use socket::{
    sys_socket_accept, sys_socket_addr, sys_socket_bind, sys_socket_close, sys_socket_connect,
    sys_socket_info, sys_socket_listen, sys_socket_open, sys_socket_recv, sys_socket_recvfrom,
    sys_socket_recvmsg, sys_socket_send, sys_socket_sendmsg, sys_socket_sendto, sys_socketpair,
};
```

- [ ] **Step 2: Keep shared fd helpers available**

Leave `close_entry`, `inc_entry_ref`, `close_fd_number`, and `has_buffer_capacity` in `mod.rs` as `pub(super)` if socket code needs them.

- [ ] **Step 3: Verify**

Run:

```bash
cargo test -p yurt-kernel-wasm --lib socket
cargo test -p yurt-kernel-wasm --lib
```

Expected: all socket tests and full Rust kernel lib tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/socket.rs
git commit -m "refactor: split socket dispatcher"
```

### Task 4: Extract Path/VFS Dispatch

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Create: `packages/kernel-wasm/src/dispatch/path_syscalls.rs`

- [ ] **Step 1: Move path-facing syscalls**

Move `sys_open`, `normalize_readable_path`, `mkdir`, `rmdir`, `readdir`, `symlink`, `install_host_fs_mount`, `install_yurtfs`, `install_tar_layer`, `maybe_decompress_zstd`, `rename`, `hard_link`, `readlink`, `realpath`, `unlink`, `stat_path`, `chown`, `utimens`, and `chmod`.

Add:

```rust
mod path_syscalls;
use path_syscalls::{
    chmod, chown, hard_link, install_host_fs_mount, install_tar_layer, install_yurtfs, mkdir,
    readlink, realpath, readdir, rename, rmdir, stat_path, symlink, sys_open, unlink, utimens,
};
```

- [ ] **Step 2: Verify**

Run:

```bash
cargo test -p yurt-kernel-wasm --lib proc_
cargo test -p yurt-kernel-wasm --lib path_
cargo test -p yurt-kernel-wasm --lib
```

Expected: path/proc tests and full Rust kernel lib tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/path_syscalls.rs
git commit -m "refactor: split path dispatcher"
```

### Task 5: Extract Process and Host-Control Dispatch

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs`
- Create: `packages/kernel-wasm/src/dispatch/process.rs`
- Create: `packages/kernel-wasm/src/dispatch/host_control.rs`

- [ ] **Step 1: Move process syscalls**

Move credentials, priority, scheduler, pgid/sid, kill, sigaction, sleep/yield, spawn/wait/record-exit helpers into `process.rs`.

- [ ] **Step 2: Move host-control encoders**

Move stdin/stdout/stderr host-control helpers, process/thread list encoders, scheduler response, snapshot response, and drain-spawn into `host_control.rs`.

- [ ] **Step 3: Verify**

Run:

```bash
cargo test -p yurt-kernel-wasm --lib process
cargo test -p yurt-kernel-wasm --lib kernel_
cargo test -p yurt-kernel-wasm --lib
```

Expected: process/host-control tests and full Rust kernel lib tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/process.rs packages/kernel-wasm/src/dispatch/host_control.rs
git commit -m "refactor: split process dispatcher"
```

### Task 6: Final Verification and Push

**Files:**
- No additional code files expected.

- [ ] **Step 1: Run local gates**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --tests
```

Expected: all commands exit 0.

- [ ] **Step 2: Push**

Run:

```bash
git push origin continue-rust-kernel-host-interface-2
```

- [ ] **Step 3: Check PR CI**

Run:

```bash
gh pr checks 45
```

Expected: required checks are passing or pending; investigate any failure before continuing feature work.
