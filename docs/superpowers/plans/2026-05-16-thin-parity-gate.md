# Thin Parity Gate (slice B0) — Implementation Plan

Spec: `docs/superpowers/specs/2026-05-16-thin-parity-gate-design.md`
Branch: `parity-b0-thin-gate` (off `main`). Slice PR off `main`.
Tracking: issue #52 (B0 checkbox); matrix row flip recorded on umbrella PR #51.

TDD, AGENTS.md loop. Fast tier untouched; gate is slow-tier only.

## Tasks

1. **Differ skeleton (red→green)**
   - `packages/kernel/src/__tests__/parity-differ_test.ts`.
   - Read `YURT_KERNEL` (default `both`). Enumerate `abi/conformance/*.spec.toml`
     (reuse the TOML parse already used by `abi_test.ts`; check its import).
   - Reuse `createTsSandbox`/`createWasmSandbox`/`runWithBothKernels` shape
     from `sandbox-wasm-kernel_test.ts` — extract shared helper into
     `packages/kernel/src/__tests__/_parity_harness.ts` if it is currently
     test-private (verify; do not duplicate).
   - Start with a 2-spec allowlist (`dup2`, `identity`); deep-equal the
     JSONL trace + process exit between kernels. Red first (module absent),
     then green.

2. **Baseline allowlist**
   - `abi/conformance/parity-baseline.toml`: `(canary, case) → {slice, reason}`.
   - Gate fails on un-allowlisted diff AND on an allowlisted pair that now
     matches (forces shrinkage). Unit-test the allowlist logic itself.

3. **Full conformance corpus in `both`**
   - Run every `abi/conformance/*.spec.toml`. Populate the baseline with the
     real current divergences, each tagged to its owning slice (B1/B2/B3…).
   - Output the per-area scoreboard artifact.

4. **POSIX suite vendor + smoke**
   - Vendor `bytecodealliance/open-posix-test-suite` at a pinned commit →
     `abi/conformance/posix/upstream/`; record `abi/conformance/posix/PINNED`.
   - `abi/conformance/posix/manifest.toml`: B0 smoke subset (≈3 tests in
     done/implemented areas: a pthread, a sigsetops, a clock) with
     `expected_code` + optional `unsupported_reason`.
   - `make -C abi posix-smoke`: build manifest tests to `wasm32-wasip1`
     (reuse existing toolchain/Make patterns; do not invent a new builder).
   - Differ `posix` mode: raw `{exitCode,stdout,stderr}` graded by suite
     codes; smoke subset green through both kernels.

5. **CI wiring**
   - `guest-compat.yml`: add the gated step (spec in design doc). Verify
     fast tier unaffected.

6. **Verification + PR**
   - Local: `deno fmt`/`deno lint`/`deno check` on new TS;
     `YURT_KERNEL=both deno test --no-check … parity-differ_test.ts`;
     `make -C abi posix-smoke`; `cargo fmt`/`clippy` if any Rust touched
     (expected none). Confirm fast tier (`cargo test --tests`,
     `packages/**/*_test.ts`) unchanged & green.
   - Open focused B0 PR off `main`; on merge tick #52 B0 and set the
     matrix `Verified@` for gate-infra (umbrella PR #51).

## Risks

- The shared harness in `sandbox-wasm-kernel_test.ts` may be test-private /
  not importable cleanly — extracting it is in scope; do not fork it.
- `make -C abi` toolchain may not trivially target arbitrary upstream POSIX
  C; B0 keeps the smoke subset tiny and in already-working areas. Build
  generality is a B5 problem.
- Running the full corpus in `both` will surface many diffs — expected;
  they populate the baseline, they do not block B0 (B0 = the mechanism,
  not zero diffs).
