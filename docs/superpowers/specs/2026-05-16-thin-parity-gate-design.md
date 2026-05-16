# Thin Parity Gate (slice B0) — Design

## Goal

Make TS-vs-Rust kernel behavior **objectively measurable** so every later parity
slice has a zero-diff signal. Two deliverables:

1. A `YURT_KERNEL=ts|wasm|both` selection used by a **parity differ** that runs
   the existing `abi/conformance/*.spec.toml` corpus through one or both kernels
   and, in `both` mode, fails on any observable divergence.
2. Extend the **existing** Open POSIX harness (`scripts/open-posix-harness.ts`
   - `scripts/run-wasm-test-in-sandbox.ts`) with the same `YURT_KERNEL` selector
     so its corpus runs under either kernel (curated-subset parity here; full
     corpus is the B5 gate). No re-vendoring — see "POSIX suite integration".

This slice adds **no kernel syscall behavior**. It is harness + CI only.

## Non-goals

- No new `METHOD_SYS_*` / no kernel-wasm dispatch changes.
- Not the full POSIX corpus green (that is B5). B0 lands the harness and a
  curated smoke subset.
- No fixing of diffs the differ exposes — exposed diffs become matrix rows /
  slice work, not B0 scope.

## Existing seam (verified on `main` @ 7bccd04)

- Conformance driver contract (`abi/conformance/SCHEMA.md`): a canary is run
  `<canary> --case <name>` and prints exactly one JSONL trace line
  `{case, exit, stdout?, errno?}`; the driver diffs it against `expected.*` and
  also asserts the process exit code equals `exit`.
- Canaries already build to wasm via `make -C abi` (C at
  `abi/conformance/c/<canary>.c`, Rust at `abi/conformance/rust/<canary>/`).
- Both kernels are reachable from a single Deno test:
  `Sandbox.create({ kernelImpl: "ts" })` vs
  `Sandbox.create({ kernelImpl: "wasm", wasmKernelBytes, wasmHostImports })`,
  each exposing `run()/runArgv() → RunResult { exitCode, stdout, stderr }`.
- The pattern already exists:
  `packages/kernel/src/__tests__/sandbox-wasm-kernel_test.ts`
  `runWithBothKernels()` + `expectSameRunResult()`. B0 generalizes it over the
  whole spec corpus rather than hand-picked argv.
- TS-only conformance runner today: `packages/kernel/src/__tests__/abi_test.ts`
  (`sandbox.run("<canary> --case <name>")`). No kernel parameterization yet.

## Architecture

A single Deno test module —
`packages/kernel/src/__tests__/parity-differ_test.ts` — is the gate. Pure
orchestration over the existing seam; no new kernel code.

```
YURT_KERNEL ∈ {ts, wasm, both}        (default: both)
        │
        ▼
parity-differ_test.ts          (conformance corpus)
  ├─ enumerate abi/conformance/*.spec.toml  → {canary, cases[]}
  ├─ for each (canary, case):
  │     run "<canary> --case <name>" through selected kernel(s)
  │       via the shared dual-kernel harness
  │  └─ both? evaluateGate(rows, baseline); else just record
  └─ fail on any divergence not in parity-baseline.toml

open-posix-harness.ts          (POSIX corpus, separate driver)
  └─ run curated subset twice (YURT_KERNEL=ts, =wasm) and diff
     PASS/FAIL + observable output, same baseline discipline
```

### Result model (as implemented in `_parity_baseline.ts`)

```
Observed   = { exitCode: number; stdout: string; stderr: string }
ParityRow  = { canary; case; ts?: Observed; wasm?: Observed }
BaselineEntry = { canary; case; slice; reason }   // parity-baseline.toml
GateFailure   = { kind: "unexpected-divergence" | "stale-allowlist-entry";
                  canary; case; slice?; detail }
evaluateGate(rows, baseline) → { failures: GateFailure[] }
```

- `both` + identical, not allowlisted → pass.
- `both` + differ, not allowlisted → `unexpected-divergence` (gate FAILS).
- `both` + differ, allowlisted → tolerated (tracked, owned by a slice).
- `both` + identical, but allowlisted → `stale-allowlist-entry` (gate FAILS; the
  entry must be deleted — allowlist only shrinks).
- single-kernel rows (`ts` or `wasm` only) → ignored (no peer to diff).
- a case whose parity can't be evaluated (harness threw, or its fixture wasn't
  built) → `unestablished-case`: it is **not** silently skipped — it fails the
  gate unless it has a tracked baseline entry. The differ also flags **orphan**
  baseline entries (no matching case) and prints a copy-pasteable
  `[[divergence]]` seed for failures.

> **`ts` / `wasm` modes are inert in B0.** The differ always runs
> `runWithBothKernels` and nulls one side; single-kernel rows are then ignored
> by the gate, so `ts`/`wasm` produce no signal and still need a built
> `kernel.wasm` (+ JSPI). They are not a working triage mode in B0 — the real
> single-kernel triage path is the POSIX runner. Making `ts`/`wasm` reduce
> requirements/runtime is a tracked follow-up.
>
> **The baseline is never auto-populated.** Before `YURT_ENABLE_WASM_KERNEL_CI`
> is treated as a blocking gate, the differ must be run once in capture mode;
> `formatBaselineSeed` emits the exact `[[divergence]]` rows for a human to
> review (set the owning slice) and commit. Empty baseline + gate enforced ==
> full spec-corpus parity is being asserted.

### POSIX suite integration (reuse existing infra — corrected)

The codebase already has the Open POSIX harness; B0 must **extend, not
re-vendor** it:

- `scripts/open-posix-harness.ts` already clones
  `github.com/bytecodealliance/open-posix-test-suite` (the WASI fork), builds a
  curated case list to wasm, runs each via
  `scripts/run-wasm-test-in-sandbox.ts`, and grades PASS/FAIL.
- `.github/workflows/open-posix.yml` already drives a curated subset via
  `workflow_dispatch`.
- **B0's actual POSIX contribution:** add the `YURT_KERNEL=ts|wasm` selector to
  `scripts/run-wasm-test-in-sandbox.ts` (done) so the _same_ harness runs the
  corpus under either kernel. Parity = run the curated subset twice
  (`YURT_KERNEL=ts`, then `=wasm`) and diff PASS/FAIL + observable output,
  reusing the baseline-allowlist discipline.
- No vendoring under `abi/conformance/posix/`, no new `manifest.toml`, no new
  Makefile target — that earlier plan duplicated existing infrastructure and is
  explicitly dropped.
- Grading keeps the suite's standard result codes (PASS=0, FAIL=1, UNRESOLVED=2,
  UNSUPPORTED=4, UNTESTED=5, HUNG=6). A non-PASS is allowed only as a
  written-reason baseline exception tagged to its slice.
- B0 lands the selector + a curated-subset parity invocation; full-corpus green
  remains the B5 gate.

### CI wiring

`.github/workflows/guest-compat.yml`: add a step after the Rust kernel smoke
step, gated by `vars.YURT_ENABLE_WASM_KERNEL_CI == '1'`:

```yaml
- name: Parity gate — TS vs Rust kernel over the conformance corpus (slice B0)
  if: ${{ vars.YURT_ENABLE_WASM_KERNEL_CI == '1' }}
  run: |
    set -euxo pipefail
    cargo build --release -p yurt-kernel-wasm --target wasm32-wasip1
    YURT_KERNEL=both deno test --no-check \
      --allow-read --allow-env --allow-run \
      packages/kernel/src/__tests__/parity-differ_test.ts
```

Canaries/fixtures are already built earlier in the job
(`make -C abi all copy-fixtures`). The POSIX-corpus parity invocation is driven
separately via the existing `open-posix.yml` harness with the new `YURT_KERNEL`
selector (curated subset; full corpus is B5). Fast tier is unchanged — this is
slow-tier only.

## Testing (TDD order — as executed)

1. **Red→Green (done):** `_parity_baseline_test.ts` locks the allowlist rule
   (un-allowlisted divergence fails; allowlisted-but-now-matching fails). 9/9
   green in the fast tier — pure logic, no artifacts.
2. **Done:** `parity-differ_test.ts` enumerates `abi/conformance/*.spec.toml`,
   runs each case through both kernels via the shared harness, applies
   `evaluateGate`. Skips loudly (never false-green) when kernel.wasm / JSPI /
   canaries are absent; verified locally to skip cleanly.
3. **Done:** `YURT_KERNEL=ts|wasm` selector added to
   `scripts/run-wasm-test-in-sandbox.ts`; default `ts` unchanged, `both`
   rejected with guidance. `deno fmt/lint/check` clean.
4. **Done:** `guest-compat.yml` slow-tier step builds kernel.wasm and runs the
   differ in `both` over the full corpus, gated by `YURT_ENABLE_WASM_KERNEL_CI`.
5. **CI-validated (deferred to first slow-tier run):** the full-corpus `both`
   run populates `parity-baseline.toml` with the real current divergences, each
   tagged to its owning slice (B1+). The end-to-end both-kernels execution
   cannot be run without the wasm build, so this step is validated in CI by
   design, not locally.

Determinism: no time/network/hostname dependence in the differ itself; canaries
already isolate these.

## Open question resolved

The gate must not be permanently red just because `partial` rows diverge today.
Resolution: B0 ships a **baseline allowlist**
(`abi/conformance/parity-baseline.toml`) of currently-known divergent (canary,
case) pairs, each with the owning slice. The gate fails on any diff **not** in
the allowlist and on any allowlisted pair that starts passing (forces allowlist
shrinkage). Slices delete entries as they fix rows. Empty allowlist == full
parity for the spec corpus.
