# Remove Remaining ABI JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove JSON transport from the remaining guest/kernel WASM host imports.

**Architecture:** Delete the legacy `host_native_invoke` import and replace `host_stat`, `host_readdir`, and `host_glob` outputs with fixed little-endian binary records. Remove shared JSON memory helpers so new guest/kernel imports cannot use them accidentally.

**Tech Stack:** TypeScript on Deno for kernel imports and tests; Rust for Wasmtime runtime imports and shell-exec guest fixture code.

---

### Task 1: Boundary Guard

**Files:**
- Modify: `packages/kernel/src/host-imports/__tests__/host-json-boundary_test.ts`

- [x] Add the remaining imports to the no-JSON guard: `host_stat`, `host_readdir`, and `host_glob`.
- [x] Add a production-source guard that scans `common.ts` and `kernel-imports.ts` for `writeJson`, `JSON.parse`, and `JSON.stringify`.
- [x] Run the boundary test and verify it fails on the current implementation.

### Task 2: TypeScript Native Records

**Files:**
- Modify: `packages/kernel/src/host-imports/common.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/kernel/src/kernel-api.ts`
- Modify: `packages/kernel/src/host-imports/__tests__/imports-shape_test.ts`
- Modify: `packages/kernel/src/host-imports/__tests__/imports-parity_test.ts`

- [x] Add tests that decode native `host_stat`, `host_readdir`, and `host_glob` records.
- [x] Delete `host_native_invoke` from imports and parity expectations.
- [x] Delete `writeJson` from common helpers and `KernelApiMemory`.
- [x] Implement `writeStatRecord` and `writeStringListRecord` helpers local to `kernel-imports.ts`.
- [x] Update `host_stat`, `host_readdir`, and `host_glob` to write native records.
- [x] Run targeted Deno tests and verify they pass.

### Task 3: Rust Runtime And Guest Fixture

**Files:**
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs`
- Modify: `packages/runtime-wasmtime/src/vfs/inode.rs`
- Modify: `test-fixtures/shell-exec/src/host.rs`
- Modify: `abi/src/yurt_runtime.h`

- [x] Add native record encoders to the Wasmtime host imports.
- [x] Replace JSON stat/readdir/glob responses with native records.
- [x] Add native record decoders to `test-fixtures/shell-exec/src/host.rs`.
- [x] Update comments that describe JSON fallbacks or JSON list formats.
- [x] Run `cargo check -p yurt-runtime-wasmtime`.

### Task 4: Verification And PR

**Files:**
- Commit all touched files.

- [x] Run focused Deno checks/tests for host imports.
- [x] Run focused Rust checks/tests for runtime and shell fixture.
- [x] Run broader local gates as time permits and record any blockers.
- [ ] Push `fix/remove-all-abi-json`.
- [ ] Open a draft PR against `main`.

Known verification blockers:

- `deno check 'packages/**/*.ts'` fails on pre-existing unrelated test type errors
  in fixture-path, network gateway, Python networking, socket backend, and host
  filesystem tests.
- `cargo clippy -p yurt-shell-exec --all-targets -- -D warnings` fails on
  pre-existing shell fixture warnings outside this change.
- `cargo test -p yurt-shell-exec --lib host:: --target wasm32-wasip1` fails
  because existing test-support code references `libc` on the wasm test target.
