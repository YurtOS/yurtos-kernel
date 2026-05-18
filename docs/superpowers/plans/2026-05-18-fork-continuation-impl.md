# Real fork() Continuation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Rust/WASM kernel a true POSIX `fork()` (child resumes at the call site with the parent's exact memory+execution state) so the TypeScript kernel can be deleted (#170) without functional regression.

**Architecture:** Replace the broken memory-only `host_fork` *rebuild* in `runtime-wasmtime` with a real **Asyncify snapshot/rewind continuation**, porting the proven TS `async-bridge.ts` machinery (the only working reference, slated for deletion) to the Rust host. The kernel is unchanged (`prepare_fork`/`commit_fork`/`rollback_fork` + the `waitpid → -EAGAIN` linchpin already exist); all new work is host-side. Two libcs already exist (continuation = asyncify/strong `yurt_fork.c`; lean = weak `-ENOSYS` stub) — no ABI change. Decomposition is fixed by the spec: T1 → (T1.5 ∥ T2a ∥ T3) → T2b → T4 → T5.

**Tech Stack:** Rust (wasmtime 2x, `Caller`/`Linker`/`Store`), Binaryen `wasm-opt --asyncify`, the existing `yurt-cc` continuation toolchain, Deno/TS (JS host parity), `cargo test`/`fixture_parity.rs`, GitHub Actions (`guest-compat.yml`, `rust.yml`, `deno.yml`).

**Spec:** `docs/superpowers/specs/2026-05-18-fork-continuation-design.md` rev8 (commit `40d253b2`). **PR:** #224 / branch `claude/fork-impl`. **Worktree (ALL work here):** `/Users/sunny/work/yurtos/yurtos-kernel-forkimpl` — **NEVER** the shared primary checkout `/Users/sunny/work/yurtos/yurtos-kernel` (concurrent codex agent; see memory `feedback_always_use_worktree`).

---

## Cross-Cutting Constraints (apply to EVERY task)

- **No JSON at the guest↔kernel ABI boundary** — typed binary structs / typed wasm func params only.
- **All buffer/parse/format logic in safe Rust** — C files (`abi/src/*.c`) stay thin import/export shims only.
- **kernel-wasm is excluded from CI clippy** — after any `yurt-kernel-wasm` change run locally: `cargo clippy -p yurt-kernel-wasm --target wasm32-wasip1`.
- **Cross-host byte-parity discipline** — any behavior added to the Rust host (`packages/runtime-wasmtime/src/kernel_host_interface.rs`) must match the JS host (`packages/kernel-host-interface-js/mod.ts`) byte-for-byte on the same fixture. The reference for *both* is `packages/kernel/src/async-bridge.ts`.
- **`deno.yml` CI runs only the curated `IMAGE_RUNTIME_TESTS` list**, NOT a `*_test.ts` glob (memory `project_deno_ci_scope`). A new test only runs in CI if it is added to a workflow's explicit run list. `abi_test.ts` runs unconditionally via `guest-compat.yml`; `cargo test --tests` runs in `rust.yml` only when Rust files changed; the kernel-wasm/Rust-fork jobs are gated `vars.YURT_ENABLE_WASM_KERNEL_CI == '1'`.
- **Asyncify whole-module taint is per-module mutually exclusive with JSPI/native** (`abi/toolchain/yurt-toolchain/src/wasm_opt.rs:21-26`) — continuation fixtures MUST be built through the continuation toolchain path; never asyncify a lean module.
- **Commit cadence:** every task's last step is a commit. Push to `claude/fork-impl` at the end of each task. Never force-push (concurrent agents); if push is rejected, `git pull --rebase` then re-run the task's test gate before re-push.
- **Definition of done (whole plan):** `fork-twice` + `fork-exec` byte-identical through the Rust `kernel_host_interface` host AND the JS `Runner`; `abi_test.ts:640` longjmp-across-fork canary green on the Rust path; legacy Deno setjmp/longjmp tests re-runnable green after T1.5; existing fixtures stay green; all PR #224 CI green for the checks that run.

---

## File Structure (created / modified, by responsibility)

**T1 — asyncify fixture substrate**
- Modify `packages/runtime-wasmtime/tests/fixture_parity.rs` — add an asyncify build path to `ensure_fixture_built` + a minimal red Rust fork oracle.
- Create `test-fixtures/wasm/fork-exec/` (Cargo crate) — fork-then-exec fixture.
- Modify `abi/Makefile` — ensure `fork-exec` (if C) / nothing if Rust; verify `fork-canary.wasm` continuation build is reachable from `make -C abi all copy-fixtures`.

**T1.5 — Rust-host setjmp/longjmp substrate (independently shippable)**
- Create `packages/runtime-wasmtime/src/asyncify_bridge.rs` — Rust port of the `async-bridge.ts` asyncify state machine (setjmp/longjmp half).
- Modify `packages/runtime-wasmtime/src/kernel_host_interface.rs` — register `host_setjmp`/`host_longjmp`; wire the `wrapExport` pump around user-process entry.
- Modify `.github/workflows/guest-compat.yml` — re-enable the legacy Deno setjmp/longjmp tests.

**T2a — fork core**
- Modify `packages/runtime-wasmtime/src/asyncify_bridge.rs` — add the fork half (`AsyncifyForkSnapshot`, `host_fork`, snapshot/rewind, parked-continuation registry).
- Modify `packages/runtime-wasmtime/src/kernel_host_interface.rs` — replace `instantiate_fork_child`/`host_fork`/the `call_run` child drive with the parked-continuation model; lean guest → `-ENOSYS`.
- Create `docs/superpowers/plans/2026-05-18-fork-rust-driver-spike-notes.md` — the T2a spike deliverable (resolved re-entrant-drive mechanism + final signatures).

**T2b — jmpBufStates across fork**
- Modify `packages/runtime-wasmtime/src/asyncify_bridge.rs` — extend snapshot/restore with `jmp_buf_states`.

**T3 — JS host parity**
- Modify `packages/kernel-host-interface-js/mod.ts` — port `host_setjmp`/`host_longjmp`/`host_fork` + the pump into the JS host engine.

**T4 — cross-host parity + edges + CI**
- Modify `packages/runtime-wasmtime/tests/fixture_parity.rs` — replace the characterizing test with the real cross-host oracle; add edges.
- Modify `.github/workflows/guest-compat.yml` — add a NEW unconditionally-running Rust fork oracle job.

**T5 — interlock**
- Modify the #170 issue body (via `gh`) — the file-scoped keep-until-T4 list.

---

## Task 1 (spec T1): Asyncify fixture-build harness + `fork-exec` fixture + minimal red Rust oracle

**Why first / longest pole:** every later task needs (a) the ability to build an asyncify-instrumented fixture from `fixture_parity.rs`, and (b) a live, unconditionally-CI'd Rust fork oracle to iterate against (M2). Today `ensure_fixture_built` does a plain `cargo build` with no `wasm-opt --asyncify` step.

**Files:**
- Modify: `packages/runtime-wasmtime/tests/fixture_parity.rs` (`ensure_fixture_built` @ 51-66; `fixture_wasm_path` @ 45-49)
- Create: `test-fixtures/wasm/fork-exec/Cargo.toml`, `test-fixtures/wasm/fork-exec/src/main.rs`
- Verify: `abi/Makefile` (`copy-fixtures` @ 276-280; `fork-canary.wasm` rule @ 201-207) — read-only confirmation
- Reference (read): `abi/toolchain/yurt-toolchain/src/wasm_opt.rs` (`continuation_args` @ 15-18)

- [ ] **Step 1: Add a failing test that an asyncify-instrumented fixture exports the asyncify state machine**

Add to `packages/runtime-wasmtime/tests/fixture_parity.rs`:

```rust
#[test]
fn asyncify_fixture_exports_state_machine() {
    // T1: ensure_fixture_built must, for a continuation fixture, run
    // wasm-opt --asyncify so the artifact exports the asyncify_* state
    // machine and yurt_asyncify_buf_addr/size. fork-twice is built
    // through the continuation path (it imports yurt.host_fork).
    ensure_fixture_built_asyncify("fork-twice-wasm");
    let bytes = std::fs::read(fixture_wasm_path("fork-twice-wasm")).unwrap();
    let module =
        wasmtime::Module::new(&wasmtime::Engine::default(), &bytes).unwrap();
    let exports: Vec<&str> = module.exports().map(|e| e.name()).collect();
    for want in [
        "asyncify_start_unwind",
        "asyncify_stop_unwind",
        "asyncify_start_rewind",
        "asyncify_stop_rewind",
        "asyncify_get_state",
        "yurt_asyncify_buf_addr",
        "yurt_asyncify_buf_size",
    ] {
        assert!(
            exports.contains(&want),
            "asyncify fixture missing export {want}; exports={exports:?}"
        );
    }
}
```

- [ ] **Step 2: Run it; verify it fails (no `ensure_fixture_built_asyncify`)**

Run: `cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl && cargo test -p yurt-runtime-wasmtime --test fixture_parity asyncify_fixture_exports_state_machine`
Expected: FAIL — `cannot find function ensure_fixture_built_asyncify`.

- [ ] **Step 3: Implement `ensure_fixture_built_asyncify` (cargo build → wasm-opt --asyncify in place)**

The existing `ensure_fixture_built` (lines 51-66) does `cargo build --release -p <crate> --target wasm32-wasip1`. The asyncify variant builds then post-processes with the SAME flags `continuation_args()` uses (`wasm_opt.rs:6-18`: `-O2 --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --asyncify`). Add below `ensure_fixture_built`:

```rust
/// Build a continuation fixture: plain cargo build, then wasm-opt
/// --asyncify in place (mirrors yurt-cc's continuation_args so the
/// Rust-crate fixtures match the C-canary asyncify build exactly).
fn ensure_fixture_built_asyncify(crate_name: &str) {
    ensure_fixture_built(crate_name);
    let wasm = fixture_wasm_path(crate_name);
    let wasm_opt = which::which("wasm-opt")
        .expect("wasm-opt on PATH (Binaryen) required for asyncify fixtures");
    let status = Command::new(wasm_opt)
        .args([
            "-O2",
            "--enable-bulk-memory",
            "--enable-sign-ext",
            "--enable-nontrapping-float-to-int",
            "--asyncify",
        ])
        .arg(&wasm)
        .arg("-o")
        .arg(&wasm)
        .status()
        .expect("spawn wasm-opt");
    assert!(status.success(), "wasm-opt --asyncify failed for {crate_name}");
}
```

Add `use which;` only if not already imported — check the top of the file first; `which` is already a dependency of `yurt-toolchain`, confirm it is in `runtime-wasmtime`'s `Cargo.toml` `[dev-dependencies]`; if absent, add `which = "6"` to `packages/runtime-wasmtime/Cargo.toml` under `[dev-dependencies]`.

- [ ] **Step 4: Run the test; verify it passes**

Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity asyncify_fixture_exports_state_machine`
Expected: PASS. (If wasm-opt is missing locally: `brew install binaryen`.)

- [ ] **Step 5: Create the `fork-exec` fixture crate**

`test-fixtures/wasm/fork-exec/Cargo.toml`:

```toml
[package]
name = "fork-exec-wasm"
version = "0.1.0"
edition = "2021"
```

`test-fixtures/wasm/fork-exec/src/main.rs` (mirrors `fork-twice` deterministic-single-line discipline; child execs `child-exit7.wasm` which the kernel ramfs stages, parent waits):

```rust
//! T1 fixture: fork() then the child immediately exec()s a known
//! program; the parent waits and reports. Distinguishes a real
//! continuation (two roles, child path reached) from a rebuild.
use std::io::Write;

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_fork() -> i32;
}

fn emit(role: &str, detail: &str) {
    let line = format!("fork-exec {role} {detail}\n");
    std::io::stdout().write_all(line.as_bytes()).unwrap();
    std::io::stdout().flush().unwrap();
}

fn main() {
    let rc = unsafe { host_fork() };
    if rc < 0 {
        emit("errno", &format!("rc={rc}"));
        std::process::exit(-rc);
    }
    if rc == 0 {
        // Child: exec a fixed program. Use the yurt_process exec shim
        // the same way spawn-wait's Command does.
        emit("child", "exec=/child-exit7.wasm");
        let err = yurt_process::exec("/child-exit7.wasm", &["/child-exit7.wasm"]);
        // exec only returns on failure.
        emit("child", &format!("exec-failed rc={err}"));
        std::process::exit(126);
    }
    emit("parent", &format!("forked rc={}", if rc > 0 { "pid" } else { "0" }));
    std::process::exit(0);
}
```

> If `yurt_process` does not expose a free `exec(path, argv) -> i32`, the implementer's Step-5 sub-task is: grep `test-fixtures/wasm/spawn-wait/src/main.rs` + the `yurt_process` crate for the exact exec/Command surface and use it verbatim (spawn-wait uses `yurt_process::Command::new(...).status()`). Do not invent an API — use the one spawn-wait uses; if only `Command` exists, the child does `Command::new("/child-exit7.wasm").status()` then `exit(0)`.

- [ ] **Step 6: Register the fixture crate in the workspace**

Confirm `test-fixtures/wasm/*` is a workspace glob: `grep -n 'test-fixtures' /Users/sunny/work/yurtos/yurtos-kernel-forkimpl/Cargo.toml`. If members are explicit, add `"test-fixtures/wasm/fork-exec"` to `[workspace] members`. Then:

Run: `cargo build --release -p fork-exec-wasm --target wasm32-wasip1`
Expected: builds; artifact at `target/wasm32-wasip1/release/fork-exec-wasm.wasm`.

- [ ] **Step 7: Add the minimal RED Rust fork oracle (M2 — the live T2a target)**

The existing `fork_twice_characterizes_current_host_fork` (lines 432-491) asserts the *broken rebuild*. Add a NEW, separate oracle that asserts the *correct* behavior and is therefore RED today (it becomes T2a's green target; do NOT modify the characterizing test yet — T4 replaces it):

```rust
/// T1/M2 ORACLE (RED until T2a). The real continuation contract:
/// fork-twice must emit TWO lines — parent (`rc=pid`-ish, sentinel=42)
/// AND child (`rc=0 sentinel=42`, proving the child resumed at the
/// fork() site with the parent's post-sentinel memory). This is the
/// live target T2a iterates against; T4 promotes it to the cross-host
/// oracle. `#[ignore]` so it does not break CI before T2a — run
/// explicitly with `-- --ignored`.
#[test]
#[ignore = "RED until T2a lands real continuation; M2 live target"]
fn fork_twice_real_continuation_oracle() {
    ensure_fixture_built_asyncify("fork-twice-wasm");
    let wasm = std::fs::read(fixture_wasm_path("fork-twice-wasm")).unwrap();
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm).unwrap();
    let _ = user.run_start();
    // Drive any parked child continuation to completion (T2a installs
    // the pump; until then this returns 0 and the child line is absent).
    let _ = mk.run_pending_spawns();
    let stdout =
        String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 2, "expected parent+child lines, got {stdout:?}");
    assert!(
        lines.iter().any(|l| l.starts_with("fork-twice parent")
            && l.ends_with("sentinel=42")),
        "missing parent line: {stdout:?}"
    );
    assert!(
        lines.iter().any(|l| l == &"fork-twice child rc=0 sentinel=42"),
        "missing child continuation line (rebuild, not continuation): {stdout:?}"
    );
}
```

- [ ] **Step 8: Run the full fixture_parity suite; confirm green + the new oracle ignored**

Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity`
Expected: all pre-existing tests PASS (incl. `fork_twice_characterizes_current_host_fork` still green — rebuild unchanged); `fork_twice_real_continuation_oracle` shows `ignored`.
Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_twice_real_continuation_oracle -- --ignored`
Expected: FAIL (1 line, no child) — confirms it is a correct RED oracle.

- [ ] **Step 9: Commit + push**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
cargo fmt -p yurt-runtime-wasmtime
git add packages/runtime-wasmtime/tests/fixture_parity.rs packages/runtime-wasmtime/Cargo.toml test-fixtures/wasm/fork-exec Cargo.toml
git commit -m "feat(fork T1): asyncify fixture-build harness + fork-exec fixture + red continuation oracle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin claude/fork-impl
```

---

## Task 2 (spec T1.5): Rust-host setjmp/longjmp substrate — port `async-bridge.ts`

**Independently shippable & valuable:** this is exactly the missing impl the pending legacy Deno setjmp/longjmp tests wait on (memory `project_setjmp_longjmp`). It is a **bounded port of a proven reference** — `packages/kernel/src/async-bridge.ts`. Gates T2b only; does NOT gate T2a.

**The reference (verbatim, port these exactly):** `async-bridge.ts` — `initFromInstance` (194-209), `hostSetjmp` (230-257), `hostLongjmp` (272-282), `captureBuffer` (335-345), `restoreBuffer` (350-361), `resetBufferHeader` (175-184), `wrapExport` (448-485, setjmp/longjmp branches only for this task). The guest side already exists: `abi/src/yurt_setjmp.c` imports `yurt.host_setjmp`/`yurt.host_longjmp` and exports `yurt_asyncify_buf_addr`/`yurt_asyncify_buf_size`; asyncify state values: `1 == UNWINDING`, `2 == REWINDING`.

**Files:**
- Create: `packages/runtime-wasmtime/src/asyncify_bridge.rs`
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs` (`mod` decl; `register_yurt_thread_imports` @ 3474-3625; the user-process entry path `run_start` @ 3179-3185 and `call_export_i32`)
- Modify: `.github/workflows/guest-compat.yml` (re-enable legacy setjmp tests)
- Reference: a setjmp continuation fixture already builds — `abi/Makefile` `setjmp-canary.wasm` (in `CANARY_NAMES`) → `packages/kernel/src/platform/__tests__/fixtures/setjmp-canary.wasm`.

- [ ] **Step 1: Create `asyncify_bridge.rs` with the state struct and a unit test for the buffer header**

`packages/runtime-wasmtime/src/asyncify_bridge.rs`:

```rust
//! Rust port of packages/kernel/src/async-bridge.ts (asyncify state
//! machine). The guest (abi/src/yurt_setjmp.c) implements setjmp/
//! longjmp by calling yurt.host_setjmp/host_longjmp imports; the host
//! drives Binaryen's asyncify unwind/rewind. This module owns that
//! host-side machinery. Mirrors async-bridge.ts symbol-for-symbol so
//! the JS host (T3) and this host stay byte-parity-locked.

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use wasmtime::{Instance, Memory, Store, TypedFunc};

/// Binaryen asyncify state values (async-bridge.ts: `getState() === 1/2`).
pub const ASYNCIFY_UNWINDING: i32 = 1;
pub const ASYNCIFY_REWINDING: i32 = 2;

/// Per-jmp_buf saved continuation (async-bridge.ts jmpBufStates value:
/// {savedHigh, savedData, stackPointer}).
#[derive(Clone)]
pub struct JmpBufState {
    pub saved_high: u32,
    pub saved_data: Vec<u8>,
    pub stack_pointer: Option<i32>,
}

/// The asyncify export surface (async-bridge.ts initFromInstance).
pub struct AsyncifyExports {
    pub start_unwind: TypedFunc<i32, ()>,
    pub stop_unwind: TypedFunc<(), ()>,
    pub start_rewind: TypedFunc<i32, ()>,
    pub stop_rewind: TypedFunc<(), ()>,
    pub get_state: TypedFunc<(), i32>,
    pub data_addr: i32,
    pub data_size: i32,
    pub stack_pointer: Option<wasmtime::Global>,
}

/// Host-side asyncify bridge state (async-bridge.ts field block 152-172,
/// setjmp/longjmp subset for T1.5; fork fields added in T2a).
#[derive(Default)]
pub struct AsyncifyBridge {
    pub pending_setjmp: Option<i32>,
    pub pending_longjmp: Option<(i32, i32)>, // (env_ptr, val)
    pub jmp_buf_states: HashMap<i32, JmpBufState>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jmp_buf_state_roundtrips_bytes() {
        let s = JmpBufState {
            saved_high: 0x1234,
            saved_data: vec![1, 2, 3, 4],
            stack_pointer: Some(42),
        };
        let c = s.clone();
        assert_eq!(c.saved_high, 0x1234);
        assert_eq!(c.saved_data, vec![1, 2, 3, 4]);
        assert_eq!(c.stack_pointer, Some(42));
    }
}
```

- [ ] **Step 2: Run the unit test; verify it passes; declare the module**

Add `mod asyncify_bridge;` to `packages/runtime-wasmtime/src/lib.rs` (or wherever sibling `mod` decls live — grep `^mod ` / `^pub mod ` in `src/lib.rs`).
Run: `cargo test -p yurt-runtime-wasmtime asyncify_bridge::tests::jmp_buf_state_roundtrips_bytes`
Expected: PASS.

- [ ] **Step 3: Write a failing integration test driving the existing setjmp-canary through the Rust host**

Add to `packages/runtime-wasmtime/tests/fixture_parity.rs` (the canary fixture already exists at `packages/kernel/src/platform/__tests__/fixtures/setjmp-canary.wasm`; the harness here uses Rust-crate fixtures, so build the C canary via make and read it by path — mirror how other tests locate the platform fixtures dir; grep an existing test for `platform/__tests__/fixtures` usage and copy that path resolution):

```rust
#[test]
fn setjmp_longjmp_runs_through_rust_host() {
    // T1.5 oracle: the asyncify setjmp-canary must run on the Rust
    // host with POSIX semantics (setjmp 0 first, longjmp value second).
    // Canary is built by `make -C abi all copy-fixtures`.
    let wasm = read_platform_fixture("setjmp-canary.wasm");
    let mk = fresh_kernel_host_interface();
    let mut user = mk.spawn_user_process(&wasm).unwrap();
    let _ = user.run_start();
    let out =
        String::from_utf8_lossy(&user.captured_stdout().unwrap()).to_string();
    // setjmp-canary's default case prints the canonical setjmp/longjmp
    // result. Assert the exact line the TS host produces for the same
    // fixture (capture it once via the abi_test.ts setjmp-canary case
    // and pin it here verbatim — byte parity).
    assert_eq!(out.trim(), "setjmp-canary longjmp=42");
    assert_eq!(user.last_exit().unwrap_or(-1), 0);
}
```

> Step-3 sub-task: the asserted string MUST be the exact stdout the *TS* host yields for `setjmp-canary` (byte parity). Before writing the literal, run the TS oracle once: `deno test --no-check --allow-read --allow-env --allow-run packages/kernel/src/__tests__/abi_test.ts --filter "setjmp"` and read the canary's expected stdout from the test body (`abi_test.ts:544-617`); pin that exact string. Also implement `read_platform_fixture` helper if absent (path: repo-root `packages/kernel/src/platform/__tests__/fixtures/<name>`).

- [ ] **Step 4: Run it; verify it fails (no setjmp host support yet)**

Run: `make -C abi all copy-fixtures && cargo test -p yurt-runtime-wasmtime --test fixture_parity setjmp_longjmp_runs_through_rust_host`
Expected: FAIL — the canary's `yurt.host_setjmp`/`host_longjmp` imports are unresolved (linker error) or the run traps.

- [ ] **Step 5: Implement `initFromInstance`, `resetBufferHeader`, `captureBuffer`, `restoreBuffer`**

Port `async-bridge.ts` 194-209 / 175-184 / 335-345 / 350-361 into `asyncify_bridge.rs`. Memory r/w uses `Memory::read`/`Memory::write`; the asyncify header is two LE u32 at `data_addr` and `data_addr+4`:

```rust
impl AsyncifyExports {
    /// async-bridge.ts initFromInstance (194-209).
    pub fn from_instance<T>(
        store: &mut Store<T>,
        instance: &Instance,
        data_addr: i32,
        data_size: i32,
    ) -> Result<Self> {
        Ok(Self {
            start_unwind: instance
                .get_typed_func(&mut *store, "asyncify_start_unwind")?,
            stop_unwind: instance
                .get_typed_func(&mut *store, "asyncify_stop_unwind")?,
            start_rewind: instance
                .get_typed_func(&mut *store, "asyncify_start_rewind")?,
            stop_rewind: instance
                .get_typed_func(&mut *store, "asyncify_stop_rewind")?,
            get_state: instance
                .get_typed_func(&mut *store, "asyncify_get_state")?,
            data_addr,
            data_size,
            stack_pointer: instance
                .get_global(&mut *store, "__stack_pointer"),
        })
    }
}

fn mem<'a, T>(store: &mut Store<T>, instance: &Instance) -> Result<Memory> {
    instance
        .get_memory(&mut *store, "memory")
        .ok_or_else(|| anyhow!("instance missing memory export"))
}

impl AsyncifyBridge {
    /// async-bridge.ts resetBufferHeader (175-184): header = [dataAddr+8, dataAddr+dataSize].
    pub fn reset_buffer_header<T>(
        &self,
        store: &mut Store<T>,
        memory: &Memory,
        exp: &AsyncifyExports,
    ) -> Result<()> {
        if exp.data_size < 8 {
            return Ok(());
        }
        let lo = (exp.data_addr + 8) as u32;
        let hi = (exp.data_addr + exp.data_size) as u32;
        memory.write(&mut *store, exp.data_addr as usize, &lo.to_le_bytes())?;
        memory.write(
            &mut *store,
            (exp.data_addr + 4) as usize,
            &hi.to_le_bytes(),
        )?;
        Ok(())
    }

    /// async-bridge.ts captureBuffer (335-345).
    pub fn capture_buffer<T>(
        &mut self,
        store: &mut Store<T>,
        memory: &Memory,
        exp: &AsyncifyExports,
        env_ptr: i32,
    ) -> Result<()> {
        let mut hdr = [0u8; 4];
        memory.read(&*store, exp.data_addr as usize, &mut hdr)?;
        let high = u32::from_le_bytes(hdr);
        let buf_start = (exp.data_addr + 8) as u32;
        let data_len = (high - buf_start) as usize;
        let mut saved = vec![0u8; data_len];
        memory.read(&*store, buf_start as usize, &mut saved)?;
        let sp = exp
            .stack_pointer
            .as_ref()
            .and_then(|g| g.get(&mut *store).i32());
        self.jmp_buf_states.insert(
            env_ptr,
            JmpBufState { saved_high: high, saved_data: saved, stack_pointer: sp },
        );
        Ok(())
    }

    /// async-bridge.ts restoreBuffer (350-361).
    pub fn restore_buffer<T>(
        &self,
        store: &mut Store<T>,
        memory: &Memory,
        exp: &AsyncifyExports,
        env_ptr: i32,
    ) -> Result<()> {
        let Some(state) = self.jmp_buf_states.get(&env_ptr) else {
            return Ok(());
        };
        memory.write(
            &mut *store,
            (exp.data_addr + 8) as usize,
            &state.saved_data,
        )?;
        memory.write(
            &mut *store,
            exp.data_addr as usize,
            &state.saved_high.to_le_bytes(),
        )?;
        if let (Some(sp), Some(g)) = (state.stack_pointer, exp.stack_pointer.as_ref()) {
            g.set(&mut *store, wasmtime::Val::I32(sp))?;
        }
        Ok(())
    }
}
```

- [ ] **Step 6: Implement `host_setjmp`/`host_longjmp` import logic + the `wrapExport` pump (setjmp/longjmp branches)**

Port `async-bridge.ts` `hostSetjmp` (230-257), `hostLongjmp` (272-282), and the `wrapExport` while-loop (448-483, only the `pendingSetjmp`/`pendingLongjmp`/else branches; fork branch is T2a). In wasmtime, imports cannot re-enter the same instance from inside a `func_wrap` closure, so the pump lives in the host **driver** (the code that calls `_start`), and the import handlers only set `pending_*` + call `start_unwind`. The bridge state must be reachable from both the import closure and the driver — store it in `UserState` behind a `RefCell`/`Arc<Mutex<_>>`.

Add to `asyncify_bridge.rs`:

```rust
impl AsyncifyBridge {
    /// async-bridge.ts hostSetjmp (230-257). Returns the value the
    /// guest's setjmp() should yield. Called from the host_setjmp import.
    pub fn host_setjmp<T>(
        &mut self,
        store: &mut Store<T>,
        memory: &Memory,
        exp: &AsyncifyExports,
        env_ptr: i32,
    ) -> Result<i32> {
        if exp.get_state.call(&mut *store, ())? == ASYNCIFY_REWINDING {
            exp.stop_rewind.call(&mut *store, ())?;
            self.reset_buffer_header(&mut *store, memory, exp)?;
            if let Some((_, val)) = self.pending_longjmp.take() {
                return Ok(val);
            }
            return Ok(0); // first-time post-capture rewind
        }
        self.pending_setjmp = Some(env_ptr);
        self.reset_buffer_header(&mut *store, memory, exp)?;
        exp.start_unwind.call(&mut *store, exp.data_addr)?;
        Ok(0) // ignored during unwind
    }

    /// async-bridge.ts hostLongjmp (272-282).
    pub fn host_longjmp<T>(
        &mut self,
        store: &mut Store<T>,
        memory: &Memory,
        exp: &AsyncifyExports,
        env_ptr: i32,
        val: i32,
    ) -> Result<()> {
        if !self.jmp_buf_states.contains_key(&env_ptr) {
            return Err(anyhow!("longjmp: unknown jmp_buf @{env_ptr:#x}"));
        }
        self.pending_longjmp = Some((env_ptr, val));
        self.reset_buffer_header(&mut *store, memory, exp)?;
        exp.start_unwind.call(&mut *store, exp.data_addr)?;
        Ok(())
    }
}

/// async-bridge.ts wrapExport (448-483), setjmp/longjmp subset.
/// Re-invokes `entry` while the module is unwinding, handling each
/// pending cause. `entry` is the typed `_start` (or any `()->()`/`()->i32`).
pub fn drive_with_asyncify<T>(
    store: &mut Store<T>,
    instance: &Instance,
    exp: &AsyncifyExports,
    bridge: &std::sync::Arc<std::sync::Mutex<AsyncifyBridge>>,
    mut call_entry: impl FnMut(&mut Store<T>) -> Result<()>,
) -> Result<()> {
    call_entry(&mut *store)?;
    while exp.get_state.call(&mut *store, ())? == ASYNCIFY_UNWINDING {
        exp.stop_unwind.call(&mut *store, ())?;
        let memory = mem(&mut *store, instance)?;
        let mut b = bridge.lock().unwrap();
        if let Some(env_ptr) = b.pending_setjmp.take() {
            b.capture_buffer(&mut *store, &memory, exp, env_ptr)?;
            drop(b);
            exp.start_rewind.call(&mut *store, exp.data_addr)?;
            call_entry(&mut *store)?;
        } else if let Some((env_ptr, _)) = b.pending_longjmp {
            b.restore_buffer(&mut *store, &memory, exp, env_ptr)?;
            drop(b);
            exp.start_rewind.call(&mut *store, exp.data_addr)?;
            call_entry(&mut *store)?;
            // pending_longjmp consumed inside host_setjmp on rewind.
        } else {
            drop(b);
            return Err(anyhow!(
                "asyncify unwind with no pending setjmp/longjmp/fork cause"
            ));
        }
    }
    Ok(())
}
```

- [ ] **Step 7: Wire the bridge into `kernel_host_interface.rs` — `UserState`, imports, driver**

In `kernel_host_interface.rs`:
1. Add `pub asyncify: std::sync::Arc<std::sync::Mutex<crate::asyncify_bridge::AsyncifyBridge>>` to `UserState` (default-construct it everywhere a `UserState{...}` literal is built — `instantiate_with_pid_raw` ~3320, `instantiate_fork_child` ~838, the thread path ~745; grep `UserState {` for all sites).
2. In `register_yurt_thread_imports` (next to `host_fork` @ 3548), register `host_setjmp(env: i32) -> i32` and `host_longjmp(env: i32, val: i32)` via `linker.func_wrap("yurt", ...)`. Each closure: pull `asyncify` arc + the instance's memory + lazily-built `AsyncifyExports` out of `caller.data()`, call `bridge.host_setjmp(...)` / `host_longjmp(...)`. Because `AsyncifyExports` needs the instantiated `Instance`, build it once in the driver (Step 7.3) and stash an `Option<AsyncifyExports>` in `UserState`; the import closures read it.
3. Change the user-process entry from a bare `f.call(&mut store, ())` (`run_start` @ 3179-3185) to: if the module exports `asyncify_get_state`, build `AsyncifyExports::from_instance`, init the header (`reset_buffer_header`), stash exports in `UserState`, then call `drive_with_asyncify(... call_entry = |s| _start.call(s,()))`. If not asyncify, keep the existing direct call (lean modules unaffected).

> Step-7 sub-task (the one integration unknown in T1.5): wasmtime's `func_wrap` closure receives `Caller<'_, UserState>` and cannot call other exports of the same instance re-entrantly *from inside the import*. The chosen design (verified against the spawn-pump pattern this repo already uses — free fns over `&Store`/`&Instance`, see `drain_and_run_pending_spawns` @ 3432) keeps ALL asyncify export calls (`start_unwind` etc.) in the **driver** and the **import handlers only mutate `pending_*` then call `start_unwind` via the exports stashed in `UserState`**. `start_unwind` from inside the import is permitted (it does not re-enter wasm; it flips asyncify state and the guest then unwinds out normally). Confirm by reading how `host_thread_join`'s EAGAIN-retry closure (@ 3493-3524) already calls back into kernel state — same borrow shape.

- [ ] **Step 8: Run the setjmp integration test; iterate to green**

Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity setjmp_longjmp_runs_through_rust_host`
Expected: PASS (setjmp returns 0 then 42; exit 0). If it traps, add `eprintln!` of `get_state` at each pump iteration and compare against the TS `wrapExport` control flow (448-483) — the order is: call → state==1 → stop_unwind → branch → start_rewind → call again.

- [ ] **Step 9: Run the full Rust suite + clippy; re-enable the legacy Deno setjmp tests in CI**

Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity` (all green) and `cargo clippy -p yurt-runtime-wasmtime`.
Then re-enable the legacy tests: locate them — `grep -rn "setjmp\|longjmp" packages/**/__tests__/*_test.ts` — and add the setjmp/longjmp test file(s) to the unconditional run list in `.github/workflows/guest-compat.yml` (the `deno test ... abi_test.ts` step @ ~183 already runs the asyncify setjmp-canary cases `abi_test.ts:544-617`; if the legacy pending tests live in a separate file currently excluded, add that file to the same step's command). Verify locally:
Run: `deno test --no-check --allow-read --allow-env --allow-run packages/kernel/src/__tests__/abi_test.ts --filter "setjmp"`
Expected: setjmp/longjmp cases PASS.

- [ ] **Step 10: Commit + push**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
cargo fmt -p yurt-runtime-wasmtime
git add packages/runtime-wasmtime/src/asyncify_bridge.rs packages/runtime-wasmtime/src/kernel_host_interface.rs packages/runtime-wasmtime/src/lib.rs packages/runtime-wasmtime/tests/fixture_parity.rs .github/workflows/guest-compat.yml
git commit -m "feat(fork T1.5): port async-bridge.ts setjmp/longjmp machinery to the Rust host

Independently retires the pending-on-impl legacy Deno setjmp/longjmp tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin claude/fork-impl
```

---

## Task 3 (spec T2a): Fork core — Rust asyncify snapshot/rewind + parked-continuation registry

**Co-equal high-unknown pole.** This is the deepest task. It begins with an explicit, deliverable-producing **spike** (per the spec's "spike-then-sequence" mandate) because the Rust re-entrant continuation drive has no existing analogue. The spike's output is a committed design note + final signatures — not a placeholder; subsequent steps are written against it.

**Reference:** `async-bridge.ts` `hostFork` (284-302), `snapshotForkContinuation` (363-390), `restoreForkSnapshot` (304-319), `startForkRewind` (321-324), `wrapExport` fork branch (454-463); `loader.ts` `forkChildFromSnapshot` (634-886, esp. the `void childPromise; return childPid` parent-immediate / parked-child shape @ 884). Kernel (unchanged, just called): `prepare_fork`/`commit_fork`/`rollback_fork` (`kernel.rs:830-902`), the `waitpid → -EAGAIN` linchpin (`dispatch/process.rs:1185-1229`). The broken code to replace: `host_fork`/`instantiate_fork_child`/`snapshot_user_memory`/`call_run` (`kernel_host_interface.rs:209-223, 813-870, 3548-3616`).

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-fork-rust-driver-spike-notes.md` (Step 1 deliverable)
- Modify: `packages/runtime-wasmtime/src/asyncify_bridge.rs` (fork half)
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs` (`host_fork`, parked registry, drive)

- [ ] **Step 1: SPIKE — resolve the re-entrant fork-drive mechanism; write the design note**

Time-box: produce `docs/superpowers/plans/2026-05-18-fork-rust-driver-spike-notes.md` answering, with a verified code sketch for each:
  1. **Parent-immediate, child-parked:** `host_fork` (import closure) must, on the unwind it triggers, hand a *snapshot* to a registry and let the **parent** rewind and continue (returning `child_pid`), with the **child** parked. Confirm the mechanism: `host_fork` sets `pending_fork=true` + captures memory/SP, calls `start_unwind`; the **driver** (Step from T1.5 `drive_with_asyncify`, fork branch) sees `pending_fork`, builds the snapshot, calls `forkController` equivalent = a host fn that (a) `prepare_fork`→`child_pid`, (b) materializes the child instance fully from the snapshot (memory + asyncify header + restore), (c) `commit_fork`, (d) inserts the *already-live* child into a parked registry keyed by `child_pid` (L2: pointer-insert, no commit→instantiate window), (e) returns `child_pid`; then the driver sets `pending_fork_return=child_pid`, `start_rewind`, re-invokes entry → parent's `host_fork` returns `child_pid`.
  2. **Parked registry type:** define `struct ParkedChild { store: Store<UserState>, instance: Instance, exp: AsyncifyExports }` and where it lives — on the engine (`CachedProcessEngine`-equivalent) NOT in `ProcessForkState` (kernel unchanged). Resolve the `Store<UserState>` ownership/lifetime (the spawn pump owns child `UserProcess` values in a local; the parked registry must own them across host_wait calls — put it in the `KernelHostInterface`/engine struct as `parked: Mutex<HashMap<u32, ParkedChild>>`).
  3. **Re-entrant drive at `-EAGAIN`:** the parked child is driven by `run_pending_spawns()` equivalent. Confirm `drain_and_run_pending_spawns` (@ 3432) is extended (NOT copied — its run-to-completion payload is wrong for fork) to also: for each parked child pid whose parent is at a `-EAGAIN` wait point, resume it via `start_rewind`+drive until it next unwinds (re-park) or exits (`record_exit` + remove from registry). Nested fork = the parked child's own `host_fork` re-enters the same path (re-entrant).
  4. **Linchpin assertion:** confirm the `waitpid → -EAGAIN` path (`dispatch/process.rs:1212`) returns `-EAGAIN` (not `-ECHILD`) for a committed-but-unpumped child — write the exact unit assertion.
  5. **Lean guest → `-ENOSYS`:** a lean module has no `asyncify_get_state` export; `host_fork` for it returns `-(ENOSYS)` (38) — confirm the weak `yurt_process.c:262` stub means lean guests never even import `host_fork`, so the import-not-present case is the real path; the `-ENOSYS` return is the belt-and-suspenders for a mixed module.

Acceptance: the note contains a compiling type sketch for `ParkedChild`, the registry field, the extended-pump signature, and the `host_fork` driver-branch pseudocode, each cross-checked against a named existing pattern in `kernel_host_interface.rs`. Commit the note.

- [ ] **Step 2: Un-ignore the T1 oracle as this task's RED gate**

Edit `fixture_parity.rs`: remove `#[ignore = ...]` from `fork_twice_real_continuation_oracle` is NOT done yet (keeps CI green); instead this task drives it explicitly. Confirm RED:
Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_twice_real_continuation_oracle -- --ignored`
Expected: FAIL (rebuild: 1 line).

- [ ] **Step 3: Add the fork half to `asyncify_bridge.rs` (failing unit test first)**

Add a unit test asserting `AsyncifyForkSnapshot` round-trips, then implement. Port `async-bridge.ts` 73-82 (`AsyncifyForkSnapshot`), `hostFork` (284-302), `snapshotForkContinuation` (363-390), `restoreForkSnapshot` (304-319), `startForkRewind` (321-324):

```rust
/// async-bridge.ts AsyncifyForkSnapshot (73-82).
#[derive(Clone)]
pub struct AsyncifyForkSnapshot {
    pub memory_bytes: Vec<u8>,
    pub memory_pages: u32,
    pub stack_pointer: Option<i32>,
    pub data_addr: i32,
    pub data_size: i32,
    pub jmp_buf_states: Vec<(i32, JmpBufState)>, // empty until T2b
}
```

Add to `AsyncifyBridge`: `pub pending_fork: bool`, `pub pending_fork_return: Option<i32>`, `pub pending_fork_memory: Option<Vec<u8>>`, `pub pending_fork_sp: Option<i32>`, and methods `host_fork`, `snapshot_fork_continuation`, `restore_fork_snapshot`, `start_fork_rewind` — each a line-by-line port of the cited TS (the `getState()===2` rewind branch returns `pending_fork_return ?? -11`; the unwind branch sets `pending_fork`, slices memory, calls `start_unwind`). Keep `jmp_buf_states` captured/restored but it will be empty until T2b (basic fork needs no setjmp).

Run the unit test: `cargo test -p yurt-runtime-wasmtime asyncify_bridge` → PASS.

- [ ] **Step 4: Add the fork branch to `drive_with_asyncify` + the parked registry**

Extend `drive_with_asyncify` (from T1.5) with the `pending_fork` branch (mirror `wrapExport` 454-463): build snapshot, call the injected `fork_controller(snapshot) -> i32`, set `pending_fork_return`, `start_rewind`, re-invoke entry. Add to the host-interface engine struct: `parked: std::sync::Mutex<std::collections::HashMap<u32, ParkedChild>>` with `ParkedChild` as resolved in Step 1.

- [ ] **Step 5: Replace `host_fork` + `instantiate_fork_child` + delete the `call_run` child drive**

In `kernel_host_interface.rs`:
- `host_fork` import closure: keep the `forced_fork_return` early-return guard; keep `prepare_fork` on the no-asyncify-export → return `-(ENOSYS)`; otherwise set `caller.data().asyncify.lock().pending_fork=true` + capture SP and call `start_unwind`. Remove the synchronous `instantiate_fork_child(...).call_run()...record_exit` block (the rebuild).
- The driver's fork branch (Step 4 controller): `prepare_fork(parent)→child_pid`; materialize the child instance fully from the snapshot (reuse the `instantiate_fork_child` linker setup but: restore memory **and** asyncify header, set `restore_fork_snapshot(snapshot, 0)`, do NOT `call_run`); `commit_fork`; insert `ParkedChild` into `parked` (L2: child fully materialized BEFORE commit per spec step 5/8 — order: prepare → materialize → commit → registry-insert); return `child_pid`. On any pre-commit failure → `rollback_fork`.
- Extend `drain_and_run_pending_spawns` (rename concept to `drain_and_drive_pending` or add a sibling `drive_parked_children`) so a parent at `-EAGAIN` triggers: for each parked child, `start_rewind` + `drive_with_asyncify` until it re-unwinds (re-park, leave in registry) or exits (`record_exit`, remove). Do NOT use the spawn pump's run-to-completion path.

- [ ] **Step 6: Drive the oracle green**

Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_twice_real_continuation_oracle -- --ignored`
Expected: PASS — two lines, parent + `fork-twice child rc=0 sentinel=42`.
Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_exec` (add an analogous `fork_exec` oracle mirroring Step 1.7's structure, asserting parent+child roles and child exit 7 reaped).
Then confirm the **characterizing** test now fails (expected — the rebuild is gone):
Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_twice_characterizes_current_host_fork`
Expected: FAIL. Update it: replace its body with a one-line `// SUPERSEDED by fork_twice_real_continuation_oracle (T2a); see T4.` and `#[ignore]`, OR delete it and note "replaced in T4". (T4 owns the final oracle; do not leave a red test.)

- [ ] **Step 7: Assert the linchpin invariant + lean `-ENOSYS` + multithreaded `-EAGAIN`**

Add unit tests in `fixture_parity.rs`:
- `committed_unpumped_child_waitpid_is_eagain` — fork, parent `waitpid` before any drive → kernel returns `-EAGAIN` (not `-ECHILD`). (Drive via the `child-exit7`-style fixture; assert the wait rc.)
- `lean_module_fork_returns_enosys` — build a NON-asyncify fixture that calls `host_fork` (or asserts the weak stub path); expect `-38`.
- preserve the existing shared-memory/threads `-EAGAIN` guards: run the existing tests that cover `snapshot_user_memory` shared-memory and `prepare_fork` `threads.len()>1` (grep for them) — they must stay green (T2a must not regress them).

Run all: `cargo test -p yurt-runtime-wasmtime --test fixture_parity` → all green (except characterizing, now ignored).

- [ ] **Step 8: clippy + commit + push**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
cargo clippy -p yurt-runtime-wasmtime && cargo fmt -p yurt-runtime-wasmtime
git add -A packages/runtime-wasmtime docs/superpowers/plans/2026-05-18-fork-rust-driver-spike-notes.md
git commit -m "feat(fork T2a): real asyncify fork continuation — parked-child registry + re-entrant drive

Replaces the broken memory-only rebuild. Parent resumes immediately;
child parked and driven at the parent's -EAGAIN points. No kernel change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin claude/fork-impl
```

---

## Task 4 (spec T2b): `jmpBufStates` capture/restore across fork

Depends on **T1.5 + T2a**. Small given both: T2a already carries a (empty) `jmp_buf_states` field through the snapshot; T1.5 already implements `capture_buffer`/`restore_buffer`. T2b just ensures the parent's live `jmp_buf_states` map is serialized into the snapshot and rebuilt into the parked child so pre-fork setjmp frames survive.

**Reference:** `async-bridge.ts` `snapshotForkContinuation` 381-388 (`jmpBufStates: Array.from(...)`), `restoreForkSnapshot` 304-314 (rebuild `new Map(...)`). **Oracle:** `abi_test.ts:640` ("preserves pre-fork continuation frames in children") — cases `child-longjmp-prefork`, `child-nested-longjmp-prefork`, `child-wait-longjmp-prefork` on `fork-canary.wasm`.

**Files:** Modify `packages/runtime-wasmtime/src/asyncify_bridge.rs`; add a Rust oracle in `fixture_parity.rs`.

- [ ] **Step 1: Failing Rust oracle — longjmp across fork on the Rust host**

Add to `fixture_parity.rs` (build `fork-canary.wasm` via `make -C abi all copy-fixtures`; it is the asyncify continuation build):

```rust
#[test]
fn fork_canary_longjmp_across_fork_rust_host() {
    // T2b oracle: the Rust host must preserve pre-fork setjmp frames in
    // the forked child (jmpBufStates carried in the snapshot). Mirrors
    // abi_test.ts:640. Byte-parity: assert the exact stdout the TS host
    // yields per case.
    for (case, expect) in [
        ("child-longjmp-prefork", "fork-child-longjmp-ok"),
        ("child-nested-longjmp-prefork", "fork-child-nested-longjmp-ok"),
        ("child-wait-longjmp-prefork", "fork-child-wait-longjmp-ok"),
    ] {
        let wasm = read_platform_fixture("fork-canary.wasm");
        let mk = fresh_kernel_host_interface();
        let mut user = mk
            .spawn_user_process_argv(&wasm, &["fork-canary", "--case", case])
            .unwrap();
        let _ = user.run_start();
        let _ = mk.run_pending_spawns(); // drive parked child
        let out = String::from_utf8_lossy(
            &user.captured_stdout().unwrap()).to_string();
        assert_eq!(out.trim(), expect, "case {case}");
        assert_eq!(user.last_exit().unwrap_or(-1), 0, "case {case}");
    }
}
```

> Sub-task: if `spawn_user_process_argv` does not exist, use the argv-passing entry the existing argv fixtures use (grep `fixture_parity.rs` for how `spawn-wait`/`--case` fixtures pass argv; reuse verbatim).

- [ ] **Step 2: Run it; verify it fails (jmp_buf_states not carried across fork)**

Run: `make -C abi all copy-fixtures && cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_canary_longjmp_across_fork_rust_host`
Expected: FAIL — child loses pre-fork setjmp frame (wrong stdout / non-zero exit).

- [ ] **Step 3: Serialize/restore `jmp_buf_states` in the fork snapshot**

In `snapshot_fork_continuation`: populate `jmp_buf_states: self.jmp_buf_states.iter().map(|(k,v)| (*k, v.clone())).collect()` (port `async-bridge.ts` 381-388). In `restore_fork_snapshot`: `self.jmp_buf_states = snapshot.jmp_buf_states.iter().cloned().collect()` (port 304-314). Confirm the parked-child materialization (T2a Step 5) calls `restore_fork_snapshot` AFTER `initFromInstance`-equivalent so the child's bridge has the parent's map.

- [ ] **Step 4: Run the oracle; iterate to green; full suite + clippy**

Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity fork_canary_longjmp_across_fork_rust_host` → PASS (all 3 cases).
Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity` (all green) + `cargo clippy -p yurt-runtime-wasmtime`.

- [ ] **Step 5: Commit + push**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
cargo fmt -p yurt-runtime-wasmtime
git add packages/runtime-wasmtime/src/asyncify_bridge.rs packages/runtime-wasmtime/tests/fixture_parity.rs
git commit -m "feat(fork T2b): carry jmpBufStates across fork — pre-fork setjmp frames survive in child

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin claude/fork-impl
```

---

## Task 5 (spec T3): JS host parity — port the bridge into `kernel-host-interface-js`

Logically independent of T2a/T2b *code* but parity-locked to it. The JS host (`packages/kernel-host-interface-js/mod.ts`) currently has no `host_setjmp`/`host_longjmp`/`host_fork`. Port the SAME `async-bridge.ts` machinery into the JS host engine so the JS `Runner` produces byte-identical output to the Rust host.

**Reference (the JS host already imports nothing of this):** `async-bridge.ts` (the whole `AsyncifyAsyncBridge`), `loader.ts` `forkChildFromSnapshot` 634-886. **Integration points:** `mod.ts` `buildUserYurtImports` (1633-1641 — where `host_*` imports register), `CachedProcessEngine` (2036-2070), `runCachedChild` (2378-2449), `runPendingSpawns` (2462-2479).

**Files:** Modify `packages/kernel-host-interface-js/mod.ts` (+ a new sibling module `packages/kernel-host-interface-js/asyncify-bridge.ts` if `mod.ts` is large — grep its line count; if >2000, create the sibling).

- [ ] **Step 1: Failing JS host test — setjmp-canary through the JS Runner**

Add to `packages/kernel-host-interface-js/__tests__/` (this dir runs in the `kernel-host-interface-js` job, gated `YURT_ENABLE_WASM_KERNEL_CI`; that is acceptable for T3 since T4 adds the unconditional Rust oracle and parity-differ already runs gated):

```typescript
import { assertEquals } from "jsr:@std/assert";
// ... import the JS host engine / Runner the existing tests in this dir use
Deno.test("JS host runs setjmp-canary with POSIX semantics", async () => {
  const wasm = await Deno.readFile(
    new URL("../../kernel/src/platform/__tests__/fixtures/setjmp-canary.wasm", import.meta.url),
  );
  const out = await runFixtureThroughJsHost(wasm, []); // helper per existing tests
  assertEquals(out.stdout.trim(), "setjmp-canary longjmp=42"); // same literal as T1.5 Step 3
  assertEquals(out.exitCode, 0);
});
```

> Sub-task: model `runFixtureThroughJsHost` on the existing spawn/wait E2E in this dir (the merged #129/#206 `spawn_wait_test.ts` / runner tests) — reuse their engine bootstrap verbatim.

- [ ] **Step 2: Run it; verify it fails**

Run: `deno test --no-check --allow-read --allow-env --allow-run packages/kernel-host-interface-js/__tests__/<newfile>_test.ts`
Expected: FAIL — `host_setjmp` import missing / unresolved.

- [ ] **Step 3: Port the bridge into the JS host**

`async-bridge.ts` is itself TS and slated for deletion with `packages/kernel/`. Copy the `AsyncifyAsyncBridge` class (and `AsyncifyForkSnapshot`/`AsyncifyForkController` interfaces) into `packages/kernel-host-interface-js/asyncify-bridge.ts` (self-contained — strip the `AsyncBridge` interface coupling; keep `initFromInstance`, `hostSetjmp`, `hostLongjmp`, `hostFork`, `captureBuffer`, `restoreBuffer`, `resetBufferHeader`, `snapshotForkContinuation`, `restoreForkSnapshot`, `startForkRewind`, `wrapExport` verbatim — they are runtime-agnostic). This is a copy-port, not a redesign; keep symbol names identical for parity auditing.

- [ ] **Step 4: Wire it into `buildUserYurtImports` + the engine entry path**

In `mod.ts`: in `buildUserYurtImports` (1633), add `host_setjmp`/`host_longjmp`/`host_fork` bound to a per-process `AsyncifyAsyncBridge` instance. In `runCachedChild` (2378), if the module exports `asyncify_get_state`, init the bridge (`initFromInstance` via `yurt_asyncify_buf_addr/size` like `loader.ts` `initAsyncifyBridge` 991-1026) and run `_start` through `bridge.wrapExport(...)` instead of the bare `start()` call (2440). Set the fork controller to materialize a parked child + drive it from `runPendingSpawns` (2462) — mirror `loader.ts` `forkChildFromSnapshot` parent-immediate/`void childPromise` shape and T2a's parked-registry semantics (NOT run-to-completion).

- [ ] **Step 5: Green the setjmp test, then add the JS fork parity test**

Run the setjmp test → PASS. Add `JS host fork-twice yields parent+child` and `JS host fork-canary longjmp-across-fork` tests asserting the EXACT same literals as the Rust oracles (Tasks 1/3/4). Run them → PASS.

- [ ] **Step 6: Lint + commit + push**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
deno fmt packages/kernel-host-interface-js && deno lint packages/kernel-host-interface-js
git add packages/kernel-host-interface-js
git commit -m "feat(fork T3): port AsyncifyAsyncBridge (setjmp/longjmp/fork) into the JS host

Byte-parity-locked to the Rust host (Tasks T1.5/T2a/T2b).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin claude/fork-impl
```

---

## Task 6 (spec T4): Cross-host parity oracle + edges + a NEW unconditionally-CI'd Rust fork oracle

Depends on **T1 + T2a + T3** (core parity) and additionally **T1.5 + T2b** (the longjmp-across-fork sub-oracle). Replaces the characterizing test with the real cross-host oracle and closes the CI-dark gap (M1: `sandbox-wasm-kernel_test.ts:179` is in NO workflow).

**Files:** Modify `packages/runtime-wasmtime/tests/fixture_parity.rs`; `.github/workflows/guest-compat.yml`; `packages/runner/` E2E (mirror the merged spawn-wait E2E).

- [ ] **Step 1: Promote the oracle — remove the characterizing test, make the real oracle the canonical one**

In `fixture_parity.rs`: delete `fork_twice_characterizes_current_host_fork` (its `#[ignore]` stub from T2a Step 6); remove `#[ignore]` from `fork_twice_real_continuation_oracle` and `fork_exec`/`fork_canary_longjmp_across_fork_rust_host` so they run by default. Run: `cargo test -p yurt-runtime-wasmtime --test fixture_parity` → all green, no ignored fork tests.

- [ ] **Step 2: Add the JS-Runner side of the cross-host oracle (byte-identical assertion)**

Add a `packages/runner/__tests__/fork_parity_test.ts` (mirror the merged `spawn_wait_test.ts`) that runs `fork-twice` + `fork-exec` through the JS `Runner.runArgv` and asserts the SAME byte stream the Rust oracle asserts. The two assertions (Rust `fixture_parity.rs` + JS runner test) must use the identical expected literals — extract them to a shared comment block in both for auditing.

- [ ] **Step 3: Add edge tests — vfork, -EAGAIN (shared-mem / threaded), -ENOSYS (lean)**

In `fixture_parity.rs`: `vfork_aliases_fork` (the `yurt_fork.c` `vfork` → `fork`); `fork_shared_memory_returns_eagain` and `fork_multithreaded_parent_returns_eagain` (reuse the existing guard tests if present — grep; else add, asserting `-EAGAIN`); `lean_fork_enosys` (from T2a Step 7, keep). Run → all green.

- [ ] **Step 4: Add the NEW unconditionally-CI'd Rust fork oracle to a workflow run list (M1)**

`rust.yml` runs `cargo test --tests` only when Rust changed (change-gated, acceptable — fork code is Rust). But the spec requires an **unconditionally-running** fork oracle. Add to `.github/workflows/guest-compat.yml` a NEW step OUTSIDE the `YURT_ENABLE_WASM_KERNEL_CI` gate (next to the unconditional `abi_test.ts` step ~183):

```yaml
      - name: Rust fork continuation oracle (unconditional)
        run: |
          set -euxo pipefail
          make -C abi all copy-fixtures
          cargo test -p yurt-runtime-wasmtime --test fixture_parity \
            fork_twice_real_continuation_oracle fork_exec \
            fork_canary_longjmp_across_fork_rust_host
```

Verify the YAML parses and the step has no `if:` gate. (This is the test that, per M1, must be in an actual workflow run list — not merely authored.)

- [ ] **Step 5: Re-point / retire `sandbox-wasm-kernel_test.ts:179`**

That test is CI-dark and JSPI-gated. Either (a) add `packages/kernel/src/__tests__/sandbox-wasm-kernel_test.ts` to the gated kernel-wasm job's run list AND keep the new unconditional Rust oracle as the real gate, or (b) leave it as documented-dark and rely on the Step-4 oracle. Choose (a) only if `HAS_JSPI` is satisfiable in that job; otherwise (b). Document the choice in the commit message. The non-negotiable is Step 4's unconditional oracle exists and is wired.

- [ ] **Step 6: Full cross-host run + commit + push**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
cargo test -p yurt-runtime-wasmtime --test fixture_parity
deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run packages/runner/__tests__/fork_parity_test.ts
cargo fmt -p yurt-runtime-wasmtime && deno fmt packages/runner
git add packages/runtime-wasmtime/tests/fixture_parity.rs packages/runner .github/workflows/guest-compat.yml
git commit -m "feat(fork T4): cross-host fork parity oracle + edges + unconditional CI oracle (closes M1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin claude/fork-impl
```

---

## Task 7 (spec T5): Annotate #170 with the file-scoped keep-until-T4 list

Fork no longer blocks Phase 4 globally; only specific files must survive until this PR's T4 lands. Record the precise interlock so #170 (delete `packages/kernel/`) does not delete the fork reference prematurely.

**Files:** none in-repo; update the #170 issue body via `gh`.

- [ ] **Step 1: Verify the file-scoped list against the now-merged work**

Confirm each still exists and is the source of the ported logic: `packages/kernel/src/async-bridge.ts` (ported in T1.5/T3); `packages/kernel/src/process/loader.ts` (`forkChildFromSnapshot` shape, ported in T2a/T3); `packages/kernel/src/process/module-profile.ts` (`importsFork`→`requiresAsyncify` rule — quote it in the annotation); the oracles `abi_test.ts:620/:640`, `sandbox-wasm-kernel_test.ts:179`, `busybox-conformance_integration_test.ts:110`. Confirm `manager.ts` has **zero** fork refs (it does — do not list it).

- [ ] **Step 2: Post the interlock annotation to #170**

```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
gh issue comment 170 --body "$(cat <<'EOF'
**Fork interlock (PR #224, spec rev8 T5).** Real fork() now lives in the Rust + JS hosts (T1.5/T2a/T2b/T3) and is cross-host-verified (T4). The TS kernel fork machinery has been *ported out*, not just referenced. Files that were the porting source — safe to delete with the rest of `packages/kernel/` once PR #224 is merged (T4 green):
- `packages/kernel/src/async-bridge.ts` — ported to `runtime-wasmtime/src/asyncify_bridge.rs` (T1.5/T2a/T2b) and `kernel-host-interface-js/asyncify-bridge.ts` (T3).
- `packages/kernel/src/process/loader.ts` — `forkChildFromSnapshot` parent-immediate/parked-child shape ported into both hosts.
- `packages/kernel/src/process/module-profile.ts` — `importsFork → requiresAsyncify` rule; equivalent gate now host-side (asyncify-export detection).
- Oracles `abi_test.ts:620/:640`, `busybox-conformance_integration_test.ts:110` keep running via guest-compat.yml; `sandbox-wasm-kernel_test.ts:179` superseded by the unconditional Rust oracle in guest-compat.yml.
- NOT `manager.ts` (zero fork refs).

#170 is unblocked re: fork once #224 merges; the file-scoped list above is the only fork-specific constraint.
EOF
)"
```

- [ ] **Step 3: Final whole-PR verification + handoff**

Run the full local gate and confirm PR #224 CI:
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-forkimpl
cargo test -p yurt-runtime-wasmtime --test fixture_parity
cargo clippy -p yurt-runtime-wasmtime && cargo clippy -p yurt-kernel-wasm --target wasm32-wasip1
cargo fmt --check
deno fmt --check packages/kernel-host-interface-js packages/runner
gh pr checks 224
```
Expected: all green. Then use **superpowers:finishing-a-development-branch**.

---

## Self-Review

**1. Spec coverage (rev8 sections → tasks):**
- Two-libc / 99-1 model → preserved (T2a Step 5 lean→`-ENOSYS`; no ABI change). ✓
- Host architecture steps 1-8 (prepare→materialize→commit→park; L2 no-window) → T2a Steps 1,5. ✓
- Execution model (parent-immediate, parked re-suspendable child, re-entrant nested) → T2a Steps 1,4,5. ✓
- Step-5 entry-primitive (re-enter same `_start` with rewind set, H2) → T1.5 `drive_with_asyncify` re-invokes the same entry; T2a fork branch uses `start_rewind`+re-invoke. ✓
- F1 4-part snapshot incl. host `jmpBufStates` → T2b. ✓
- H1 resolution (T1.5 bounded port, no setjmp dep for T2a, retires legacy tests) → Task 2 explicitly. ✓
- H3 named cooperative divergence (parent forks, exits without wait) → **GAP found**: no task adds the H3 fixture. **Fix:** added below.
- M1 CI-dark → T4 Step 4 (unconditional oracle). ✓
- M2 live oracle from day one → T1 Step 7. ✓
- T1 critical path / asyncify harness → Task 1. ✓ T5 interlock → Task 7. ✓

**Gap fix (H3) — appended to Task 6 as Step 3b:**

- [ ] **Task 6 Step 3b: H3 divergence fixture — parent forks, works, exits WITHOUT wait**

Add `fork_no_wait_h3` to `fixture_parity.rs` + a `test-fixtures/wasm/fork-nowait/` crate: parent `fork()`s, the child has an observable side effect (writes a file to the kernel ramfs / prints a sentinel), parent does work and `exit`s **without `wait`**. Assert the spec-ratified behavior: under the cooperative model the child does NOT run (documented divergence) — assert the side effect is ABSENT and add a `// H3: documented out-of-scope divergence (spec rev8 boundary contract)` comment, OR if the team elects parity, drive parked children at process-exit and assert PRESENT. Default to the documented-divergence assertion (matches spec rev8). Run → green. Fold into Task 6 Step 6's commit.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The two spike-style steps (T2a Step 1, and the byte-parity literal sub-tasks) each specify a concrete deliverable + acceptance check + named existing pattern to copy — not placeholders. Code blocks present for every code step. ✓

**3. Type consistency:** `AsyncifyBridge`, `AsyncifyExports`, `AsyncifyForkSnapshot`, `JmpBufState`, `ParkedChild`, `drive_with_asyncify`, `ensure_fixture_built_asyncify`, `read_platform_fixture`, `fork_twice_real_continuation_oracle` — used consistently across Tasks 1-6. `host_setjmp/host_longjmp/host_fork` import names match `abi/src/yurt_setjmp.c`/`yurt_fork.c` verbatim. ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-fork-continuation-impl.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, spec + code-quality review between tasks, fast iteration. Best fit here: tasks are well-bounded and the high-unknown ones (T2a) front-load a spike.
2. **Inline Execution** — execute tasks in this session via executing-plans, batch with checkpoints.
