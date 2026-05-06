# Wasmtime Runtime Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Codepod's Rust Wasmtime server into Yurt as `packages/runtime-wasmtime` and prove real epoch-based backend scheduling is wired.

**Architecture:** Import the existing Rust crate, rename package/binary/protocol labels to Yurt, and keep it out of default workspace members. Preserve Wasmtime epoch interruption, nice-to-quantum scheduling, timeout poisoning, and child-store quantum setup before adding a BusyBox runner.

**Tech Stack:** Rust, Cargo workspace, Wasmtime, Tokio, WASI preview1, serde JSON-RPC.

---

### Task 1: Import The Crate Skeleton

**Files:**
- Create: `packages/runtime-wasmtime/**`
- Modify: `Cargo.toml`

- [ ] **Step 1: Copy the old crate into the Yurt repo**

Run:
```bash
cp -R /Users/sunny/work/codepod/codepod/packages/sdk-server-wasmtime packages/runtime-wasmtime
```

Expected: `packages/runtime-wasmtime/Cargo.toml` exists.

- [ ] **Step 2: Add the crate to workspace members**

Modify root `Cargo.toml`:
```toml
members = [
  "packages/runtime-wasmtime",
  "test-fixtures/yurt-process",
  ...
]
```

Do not add it to `default-members`.

- [ ] **Step 3: Run metadata to verify the workspace sees it**

Run:
```bash
cargo metadata --no-deps --format-version 1
```

Expected before rename: command succeeds and includes `sdk-server-wasmtime` in the package list.

### Task 2: Rename The Crate To Yurt

**Files:**
- Modify: `packages/runtime-wasmtime/Cargo.toml`
- Modify: `packages/runtime-wasmtime/src/lib.rs`
- Modify: `packages/runtime-wasmtime/src/main.rs`
- Modify: `packages/runtime-wasmtime/tests/*.rs`

- [ ] **Step 1: Write a failing package-name check**

Run:
```bash
cargo metadata --no-deps --format-version 1
```

Expected: FAIL to find `yurt-runtime-wasmtime` in the metadata because the imported crate is still named `sdk-server-wasmtime`.

- [ ] **Step 2: Rename package, library, and binary**

In `packages/runtime-wasmtime/Cargo.toml`, set:
```toml
[package]
name = "yurt-runtime-wasmtime"

[lib]
name = "yurt_runtime_wasmtime"

[[bin]]
name = "yurt-runtime-wasmtime"
path = "src/main.rs"
```

- [ ] **Step 3: Update Rust test imports**

Replace:
```rust
sdk_server_wasmtime
```

With:
```rust
yurt_runtime_wasmtime
```

- [ ] **Step 4: Verify package rename**

Run:
```bash
cargo metadata --no-deps --format-version 1
```

Expected: PASS and package list includes `yurt-runtime-wasmtime`.

### Task 3: Preserve Epoch Scheduling Behavior

**Files:**
- Test: `packages/runtime-wasmtime/tests/shell_integration.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/instance.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/spawn.rs`

- [ ] **Step 1: Add a failing focused test for exported scheduler math**

Add to `packages/runtime-wasmtime/tests/shell_integration.rs`:
```rust
#[test]
fn nice_to_quantum_matches_yurt_policy() {
    assert_eq!(yurt_runtime_wasmtime::wasm::nice_to_quantum(0), 10);
    assert_eq!(yurt_runtime_wasmtime::wasm::nice_to_quantum(10), 5);
    assert_eq!(yurt_runtime_wasmtime::wasm::nice_to_quantum(19), 1);
    assert_eq!(yurt_runtime_wasmtime::wasm::nice_to_quantum(255), 1);
}
```

- [ ] **Step 2: Run the test**

Run:
```bash
cargo test -p yurt-runtime-wasmtime nice_to_quantum_matches_yurt_policy
```

Expected: PASS if the old helper is already public; otherwise FAIL because the helper is missing or crate import names are stale.

- [ ] **Step 3: Restore or expose `nice_to_quantum` if needed**

Ensure `packages/runtime-wasmtime/src/wasm/mod.rs` contains:
```rust
pub fn nice_to_quantum(nice: u8) -> u64 {
    let n = nice.min(19) as u64;
    (10 - n / 2).max(1)
}
```

- [ ] **Step 4: Verify the focused test**

Run:
```bash
cargo test -p yurt-runtime-wasmtime nice_to_quantum_matches_yurt_policy
```

Expected: PASS.

### Task 4: Verify Wasmtime Engine Construction

**Files:**
- Test: `packages/runtime-wasmtime/tests/shell_integration.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs`

- [ ] **Step 1: Add a backend construction test**

Add:
```rust
#[tokio::test]
async fn test_wasm_engine_constructs_with_epoch_support() {
    let engine = yurt_runtime_wasmtime::wasm::WasmEngine::new()
        .expect("WasmEngine::new() should enable Wasmtime backend features");
    assert_eq!(yurt_runtime_wasmtime::wasm::nice_to_quantum(19), 1);
    drop(engine);
}
```

- [ ] **Step 2: Run the test**

Run:
```bash
cargo test -p yurt-runtime-wasmtime test_wasm_engine_constructs_with_epoch_support
```

Expected: PASS only when the Wasmtime dependency builds and the engine can be constructed.

### Task 5: Rename Public Protocol Labels

**Files:**
- Modify: `packages/runtime-wasmtime/src/**/*.rs`
- Modify: `packages/runtime-wasmtime/tests/*.rs`

- [ ] **Step 1: Search remaining Codepod public names**

Run:
```bash
rg -n "codepod|Codepod|CODEPOD|sdk_server_wasmtime|sdk-server-wasmtime" packages/runtime-wasmtime
```

Expected: Results remain after raw import.

- [ ] **Step 2: Rename crate/public labels**

Replace public-facing names with:
```text
yurt
Yurt
YURT
yurt_runtime_wasmtime
yurt-runtime-wasmtime
```

Keep vendored comments only if they describe history and are not user-facing.

- [ ] **Step 3: Verify no stale public names remain**

Run:
```bash
rg -n "codepod|Codepod|CODEPOD|sdk_server_wasmtime|sdk-server-wasmtime" packages/runtime-wasmtime
```

Expected: no results, except explicitly intentional historical comments if any are added.

### Task 6: Run The Rust Backend Test Suite

**Files:**
- No new files.

- [ ] **Step 1: Run focused backend tests**

Run:
```bash
cargo test -p yurt-runtime-wasmtime nice_to_quantum
cargo test -p yurt-runtime-wasmtime test_wasm_engine_constructs_with_epoch_support
```

Expected: PASS.

- [ ] **Step 2: Run full backend crate tests**

Run:
```bash
cargo test -p yurt-runtime-wasmtime
```

Expected: PASS with active VFS, network, and backend scheduling tests. Imported shell/RPC integration tests may be ignored with an explicit reason until the next Yurt runtime semantics slice.

- [ ] **Step 3: If fixture-path tests fail, narrow the first commit**

Do not hide failures. Either update fixture paths to Yurt fixtures in the same task or mark only imported shell-dependent tests ignored with a comment that they are blocked on the next Yurt runtime semantics slice.

### Task 7: Commit The Port Slice

**Files:**
- Add/modify only files from this plan.

- [ ] **Step 1: Review diff**

Run:
```bash
git diff -- Cargo.toml packages/runtime-wasmtime docs/superpowers/specs/2026-05-06-wasmtime-runtime-port-design.md docs/superpowers/plans/2026-05-06-wasmtime-runtime-port.md
```

Expected: Diff contains the Rust backend port and docs only.

- [ ] **Step 2: Commit**

Run:
```bash
git add Cargo.toml packages/runtime-wasmtime docs/superpowers/specs/2026-05-06-wasmtime-runtime-port-design.md docs/superpowers/plans/2026-05-06-wasmtime-runtime-port.md
git commit -m "feat: port wasmtime runtime backend"
```

Expected: Commit succeeds.
