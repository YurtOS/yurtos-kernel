# Rust Fork Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement guest `fork()` parity with Rust-kernel-owned process lifecycle and host-adapter continuation execution.

**Architecture:** Rust owns pid allocation, process records, fd table cloning, wait visibility, and rollback. Host adapters implement only the continuation mechanics that cannot run inside the sandbox: guest memory snapshot, child instance creation, and parent/child resume values.

**Tech Stack:** Rust kernel wasm (`packages/kernel-wasm`), Wasmtime runtime (`packages/runtime-wasmtime`), Deno/TypeScript adapter bridge (`packages/kernel/src/process/loader.ts`), ABI manifests (`abi/contract/*.toml`), C canaries (`abi/conformance/c/fork-canary.c`), `cargo test`, `deno test`, and guest-compat.

---

## Spec

Design: `docs/superpowers/specs/2026-05-16-rust-fork-parity-design.md`

## Target File Responsibilities

- `abi/contract/yurt_abi.toml`: documents `host_fork` as a continuation-only guest import.
- `packages/runtime-wasmtime/src/kernel_host_interface.rs`: exposes `yurt.host_fork`; first returns `-ENOSYS`, later delegates to a Wasmtime continuation adapter.
- `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`: locks the Wasmtime import behavior and later Rust-backed fork behavior.
- `packages/kernel-wasm/src/kernel.rs`: owns `prepare_fork`, `commit_fork`, and `rollback_fork` process state transitions.
- `packages/kernel-wasm/src/lib.rs`: exports the fork host-control functions.
- `packages/kernel-wasm/src/dispatch/tests.rs`: tests kernel fork state transitions without host continuation machinery.
- `packages/kernel/src/process/loader.ts`: moves the current TypeScript fork child setup behind Rust prepare/commit/rollback calls when running with kernel.wasm.
- `packages/kernel/src/__tests__/abi_test.ts`: keeps the existing `fork-canary` continuation cases as the retirement gate.

## Task 1: Make `host_fork` an Explicit Wasmtime Boundary

- [x] **Step 1: Write the failing test**

Add `user_process_importing_host_fork_instantiates_and_returns_enosys` to `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`.

```rust
#[test]
fn user_process_importing_host_fork_instantiates_and_returns_enosys() {
    let mk = KernelHostInterface::load(ensure_kernel_wasm_built(), HostState::default()).unwrap();

    let user_wat = r#"
        (module
          (import "yurt" "host_fork" (func $host_fork (result i32)))
          (func (export "run") (result i32)
            (call $host_fork)))
    "#;
    let user_wasm = wat::parse_str(user_wat).unwrap();
    let mut user = mk.spawn_user_process(&user_wasm).unwrap();

    let rc = user.call_run().unwrap();
    assert_eq!(rc, -(ENOSYS as i32), "host_fork is present but unsupported");
}
```

Run: `cargo test -p yurt-runtime-wasmtime user_process_importing_host_fork_instantiates_and_returns_enosys`

Expected: fail with `unknown import: yurt::host_fork has not been defined`.

- [x] **Step 2: Add the minimal import**

Add `host_fork` to `register_yurt_thread_imports` in `packages/runtime-wasmtime/src/kernel_host_interface.rs`:

```rust
linker.func_wrap(YURT_NAMESPACE, "host_fork", || -> i32 { -(ENOSYS as i32) })?;
```

Add `[import.host_fork]` to `abi/contract/yurt_abi.toml`.

- [x] **Step 3: Verify green**

Run: `cargo test -p yurt-runtime-wasmtime user_process_importing_host_fork_instantiates_and_returns_enosys`

Expected: pass.

## Task 2: Add Rust Kernel Fork State Transitions

- [x] **Step 1: Write failing kernel tests**

Add tests in `packages/kernel-wasm/src/kernel.rs` or `packages/kernel-wasm/src/dispatch/tests.rs`:

```rust
#[test]
fn prepare_fork_allocates_hidden_child_until_commit() {
    let mut k = kernel_with_process(1);
    let child = k.prepare_fork(1).expect("prepare fork");
    assert!(child > 1);
    assert!(!k.is_waitable_child_for_test(1, child));
    k.commit_fork(1, child).expect("commit fork");
    assert!(k.is_waitable_child_for_test(1, child));
}

#[test]
fn rollback_fork_removes_prepared_child() {
    let mut k = kernel_with_process(1);
    let child = k.prepare_fork(1).expect("prepare fork");
    k.rollback_fork(1, child).expect("rollback fork");
    assert!(!k.has_process_for_test(child));
}
```

Run: `cargo test -p yurt-kernel-wasm fork`

Expected: fail because the methods do not exist.

- [x] **Step 2: Implement child process state**

Add a process fork state enum in `packages/kernel-wasm/src/kernel.rs`:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessForkState {
    Running,
    ForkPreparing { parent_pid: Pid },
}
```

Add the state to `Process`.

- [x] **Step 3: Implement prepare/commit/rollback**

Add:

```rust
pub fn prepare_fork(&mut self, parent_pid: Pid) -> Result<Pid, i32>;
pub fn commit_fork(&mut self, parent_pid: Pid, child_pid: Pid) -> Result<(), i32>;
pub fn rollback_fork(&mut self, parent_pid: Pid, child_pid: Pid) -> Result<(), i32>;
```

`prepare_fork` clones kernel-owned process metadata and fd table state from the parent but marks the child `ForkPreparing`. `commit_fork` changes the state to `Running`. `rollback_fork` removes only a matching prepared child.

- [x] **Step 4: Verify green**

Run: `cargo test -p yurt-kernel-wasm fork`

Expected: pass.

## Task 3: Export Fork Control Functions

- [x] **Step 1: Write failing export-surface test**

Update `kernel_wasm_export_surface_is_locked` in `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs` to include:

```rust
"kernel_prepare_fork",
"kernel_commit_fork",
"kernel_rollback_fork",
```

Run: `cargo test -p yurt-runtime-wasmtime kernel_wasm_export_surface_is_locked`

Expected: fail because the exports are missing.

- [x] **Step 2: Add exports**

Add to `packages/kernel-wasm/src/lib.rs`:

```rust
#[no_mangle]
pub extern "C" fn kernel_prepare_fork(parent_pid: u32) -> i64;

#[no_mangle]
pub extern "C" fn kernel_commit_fork(parent_pid: u32, child_pid: u32) -> i64;

#[no_mangle]
pub extern "C" fn kernel_rollback_fork(parent_pid: u32, child_pid: u32) -> i64;
```

Each wraps the matching `Kernel` method and returns `0`, child pid, or negated errno.

- [x] **Step 3: Verify green**

Run: `cargo test -p yurt-runtime-wasmtime kernel_wasm_export_surface_is_locked`

Expected: pass.

## Task 4: Wire Deno Continuation Fork Through Rust Ownership

- [ ] **Step 1: Write failing Deno integration coverage**

Extend the Rust-backed fork canary path in `packages/kernel/src/__tests__/abi_test.ts` so the continuation cases run with kernel.wasm enabled.

Run: `/Users/sunny/.deno/bin/deno test --allow-read --allow-env --allow-run --allow-ffi --allow-net --no-check packages/kernel/src/__tests__/abi_test.ts`

Expected: fail because TypeScript still owns fork state without Rust prepare/commit/rollback.

- [ ] **Step 2: Call Rust prepare before child snapshot**

In `packages/kernel/src/process/loader.ts`, replace direct `allocPid` for Rust-backed kernel execution with `kernel_prepare_fork(parentPid)`. Keep the existing TypeScript path unchanged for the old kernel.

- [ ] **Step 3: Commit or rollback**

After the child continuation is created, call `kernel_commit_fork(parentPid, childPid)`. On any child setup error before the continuation starts, call `kernel_rollback_fork(parentPid, childPid)`.

- [ ] **Step 4: Verify green**

Run the same `abi_test.ts` command.

Expected: continuation fork canaries pass under the Rust-backed kernel route.

## Task 5: Wasmtime Real Fork Support

- [ ] **Step 1: Write failing Wasmtime continuation test**

Add a Wasmtime fixture or WAT-based continuation test that imports `host_fork` and expects parent return `child_pid` and child return `0`.

Run: `cargo test -p yurt-runtime-wasmtime fork`

Expected: fail because `host_fork` still returns `-ENOSYS`.

- [ ] **Step 2: Implement Wasmtime continuation adapter**

Implement host memory snapshot and child instance startup behind `host_fork`, using the same Rust kernel prepare/commit/rollback exports.

- [ ] **Step 3: Verify green**

Run: `cargo test -p yurt-runtime-wasmtime fork`

Expected: pass.

## Task 6: Retirement Gate

- [ ] **Step 1: Run focused gates**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --tests
/Users/sunny/.deno/bin/deno fmt --check
/Users/sunny/.deno/bin/deno lint
/Users/sunny/.deno/bin/deno check 'packages/**/*.ts'
/Users/sunny/.deno/bin/deno test --allow-read --allow-env --allow-run --allow-ffi --allow-net --no-check packages/kernel/src/__tests__/abi_test.ts
```

- [ ] **Step 2: Run PR checks**

Push the branch and verify Rust, Deno, and Guest Compat Fixtures are green on PR #47.
