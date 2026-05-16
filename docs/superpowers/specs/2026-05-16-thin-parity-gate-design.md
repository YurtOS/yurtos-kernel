# Thin Parity Gate (slice B0) — Design

## Goal

Make TS-vs-Rust kernel behavior **objectively measurable** so every later
parity slice has a zero-diff signal. Two deliverables:

1. A `YURT_KERNEL=ts|wasm|both` selection used by a **parity differ** that
   runs the existing `abi/conformance/*.spec.toml` corpus through one or
   both kernels and, in `both` mode, fails on any observable divergence.
2. Vendor + wire the **Open POSIX Test Suite** under `abi/conformance/posix/`
   (smoke subset green here; full corpus is the B5 gate).

This slice adds **no kernel syscall behavior**. It is harness + CI only.

## Non-goals

- No new `METHOD_SYS_*` / no kernel-wasm dispatch changes.
- Not the full POSIX corpus green (that is B5). B0 lands the harness and a
  curated smoke subset.
- No fixing of diffs the differ exposes — exposed diffs become matrix rows
  / slice work, not B0 scope.

## Existing seam (verified on `main` @ 7bccd04)

- Conformance driver contract (`abi/conformance/SCHEMA.md`): a canary is run
  `<canary> --case <name>` and prints exactly one JSONL trace line
  `{case, exit, stdout?, errno?}`; the driver diffs it against `expected.*`
  and also asserts the process exit code equals `exit`.
- Canaries already build to wasm via `make -C abi` (C at
  `abi/conformance/c/<canary>.c`, Rust at `abi/conformance/rust/<canary>/`).
- Both kernels are reachable from a single Deno test:
  `Sandbox.create({ kernelImpl: "ts" })` vs
  `Sandbox.create({ kernelImpl: "wasm", wasmKernelBytes, wasmHostImports })`,
  each exposing `run()/runArgv() → RunResult { exitCode, stdout, stderr }`.
- The pattern already exists:
  `packages/kernel/src/__tests__/sandbox-wasm-kernel_test.ts`
  `runWithBothKernels()` + `expectSameRunResult()`. B0 generalizes it over
  the whole spec corpus rather than hand-picked argv.
- TS-only conformance runner today: `packages/kernel/src/__tests__/abi_test.ts`
  (`sandbox.run("<canary> --case <name>")`). No kernel parameterization yet.

## Architecture

A single Deno test module — `packages/kernel/src/__tests__/parity-differ_test.ts`
— is the gate. Pure orchestration over the existing seam; no new kernel code.

```
YURT_KERNEL ∈ {ts, wasm, both}        (default: both)
        │
        ▼
parity-differ_test.ts
  ├─ enumerate abi/conformance/*.spec.toml  → {canary, cases[]}
  ├─ enumerate abi/conformance/posix/manifest.toml → POSIX smoke list
  ├─ for each (canary, case):
  │     run "<canary> --case <name>" through selected kernel(s)
  │     parse observable result:
  │       • spec mode  → JSONL trace {case,exit,stdout?,errno?} + proc exit
  │       • posix mode → raw {exitCode, stdout, stderr} graded by suite codes
  │  └─ both? assert ts-result deep-equals wasm-result; else just record
  └─ emit a scoreboard (per-area PASS/FAIL/UNSUPPORTED/diff counts)
```

### Result model

```
ParityCase = {
  suite: "conformance" | "posix",
  canary: string, case: string, area: string,
  ts?:  Observed,   // present unless YURT_KERNEL=wasm
  wasm?: Observed,  // present unless YURT_KERNEL=ts
  verdict: "pass" | "fail" | "unsupported" | "diff" | "single"
}
Observed = { exitCode: number, stdout: string, stderr: string,
             trace?: {case,exit,stdout?,errno?} }  // trace only in spec mode
```

- `both` + identical → `pass` (or `unsupported` if suite code = 4 on both).
- `both` + differ → `diff` (the gate **fails** the test, prints a minimal
  diff: which field, ts vs wasm).
- `ts`/`wasm` single mode → `single`; never fails on divergence (no peer),
  used for triage / scoreboard, not as the merge gate.

### POSIX suite integration

- Vendor `github.com/bytecodealliance/open-posix-test-suite` (WASI fork)
  under `abi/conformance/posix/upstream/` (pinned commit recorded in
  `abi/conformance/posix/PINNED`). Secondary cross-check
  `emscripten-core/posixtestsuite` is documented but not vendored in B0.
- `abi/conformance/posix/manifest.toml` selects the **B0 smoke subset**
  (a few `conformance/interfaces/` tests in already-implemented areas, e.g.
  a `pthread_self`, a `sigemptyset`, a `clock_gettime`) plus per-test
  `expected_code` and an optional `unsupported_reason`.
- Build: a `make -C abi posix-smoke` target compiles the manifest's tests
  to `wasm32-wasip1` using the existing toolchain. Full-corpus build is B5.
- Grading uses the suite's standard result codes: PASS=0, FAIL=1,
  UNRESOLVED=2, UNSUPPORTED=4, UNTESTED=5, HUNG=6. A test whose manifest
  `expected_code = 4` with a written `unsupported_reason` is an allowed
  tracked exception; an unexplained non-PASS fails the gate.

### CI wiring

`.github/workflows/guest-compat.yml`: add a step after the Rust kernel
smoke step, gated by `vars.YURT_ENABLE_WASM_KERNEL_CI == '1'`:

```yaml
- name: Parity differ (TS vs Rust) + POSIX smoke
  if: ${{ vars.YURT_ENABLE_WASM_KERNEL_CI == '1' }}
  run: |
    set -euxo pipefail
    make -C abi posix-smoke
    YURT_KERNEL=both deno test --no-check \
      --allow-read --allow-env --allow-run \
      packages/kernel/src/__tests__/parity-differ_test.ts
```

Fast tier is unchanged (this is slow-tier only — it builds wasm).

## Testing (TDD order)

1. **Red:** differ harness asserting `both`-equality over a 2-spec subset
   (`dup2`, `identity`) with the POSIX path stubbed — fails (module absent).
2. **Green:** implement enumeration + dual-kernel run + JSONL parse +
   deep-equal; subset passes (or surfaces a real, documented diff →
   recorded as a matrix row, not silenced).
3. **Red:** POSIX smoke manifest with one `pthread`/`sigsetops` test;
   `make -C abi posix-smoke` target missing → fails.
4. **Green:** vendor pinned upstream, add `manifest.toml` + make target,
   differ runs the smoke test through both kernels.
5. CI step added; full `abi/conformance/*.spec.toml` corpus run in `both`
   — any diff is reported (expected: some `partial` rows diverge; those
   are logged as the B1+ worklist, the gate is allowed a documented
   baseline allowlist that only ever shrinks).

Determinism: no time/network/hostname dependence in the differ itself;
canaries already isolate these.

## Open question resolved

The gate must not be permanently red just because `partial` rows diverge
today. Resolution: B0 ships a **baseline allowlist**
(`abi/conformance/parity-baseline.toml`) of currently-known divergent
(canary, case) pairs, each with the owning slice. The gate fails on any
diff **not** in the allowlist and on any allowlisted pair that starts
passing (forces allowlist shrinkage). Slices delete entries as they fix
rows. Empty allowlist == full parity for the spec corpus.
