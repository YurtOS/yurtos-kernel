# CI and Local Gates — Design

**Date:** 2026-05-07
**Status:** Draft, pending implementation plan
**Replaces:** the current single-workflow CI (`.github/workflows/guest-compat.yml`) as the *only* automated quality gate, and the absence of any local hooks.

## Motivation

Today the only automated gate is `guest-compat.yml`, which builds the toolchain, ABI canaries, Rust-std canaries, and BusyBox fixture, then runs an enumerated set of Deno tests. Notably absent across the whole repo:

- No `cargo test`, `cargo clippy`, or `cargo fmt --check` in CI.
- No `deno fmt --check`, `deno lint`, or `deno check` in CI.
- No precommit or prepush hooks of any kind.
- No partition between fast and slow tests, so "run the tests locally" today either means "all of them, slowly" or "the ones I happen to remember."

The result is that style, lint, and basic-correctness regressions reach `main` regularly and are caught (if at all) by humans during review. Contributors also can't tell what "ready to push" looks like without reading CI configuration.

This spec adds three things:

1. **Local hooks** — a fast `pre-commit` (format + lint) and a fast-tier `pre-push` (format + lint + fast tests).
2. **Slow/fast test partition** — a convention so CI and `pre-push` can run the fast tier quickly and the slow tier on a separate trigger.
3. **CI workflows** — split per concern. A new Rust workflow, a new Deno workflow, and a small extension to `guest-compat.yml` for ABI signature checks. Existing `guest-compat.yml` behavior is preserved.

The bar is set by what these gates enforce. CLAUDE.md's build/test cheatsheet will reference them rather than inventing a separate bar.

## Scope

### In scope

- Adopt the **`pre-commit`** framework (the Python-based one, not git's built-in `pre-commit` hook name) as the single source of truth for local hooks. Configured via `.pre-commit-config.yaml` at the repo root. Stock hooks where they exist; thin shell wrappers where they don't.
- **`pre-commit` stage hooks (run on `git commit`):**
  - `cargo fmt --check` (Rust formatting).
  - `cargo clippy --all-targets -- -D warnings` (Rust lint).
  - `deno fmt --check` (Deno/TS formatting).
  - `deno lint` (Deno/TS lint).
  - Generic hygiene: trailing whitespace, end-of-file fixer, large-file guard, merge-conflict marker check (the standard `pre-commit-hooks` repo).
- **`pre-push` stage hooks (run on `git push`):**
  - Everything `pre-commit` runs (re-run, in case the index drifted since last commit).
  - `cargo test` for the host-targeted Rust crates listed in `default-members` (excludes wasm-only canary crates).
  - `deno test --no-check` over the **fast** TS test tier (see partition below). Permission flags scoped to `--allow-read --allow-write --allow-env --allow-net --allow-run` to match CI.
- **Slow/fast test partition** — *the* design lever for keeping `pre-push` under ~60 seconds:
  - **Rust:** mark slow tests with the standard `#[ignore]` attribute. `cargo test` runs the fast tier by default; `cargo test -- --include-ignored` (or `-- --ignored`) runs the slow tier. This is the cargo-builtin convention; no extra plumbing.
  - **TypeScript / Deno:** mark slow tests with the filename suffix `*_integration_test.ts` (mirroring Deno stdlib's existing convention for tiered tests). `deno test packages/**/*_test.ts` runs the fast tier; `deno test packages/**/*_integration_test.ts` runs the slow tier. The current Deno test files use the suffix `*.test.ts` rather than `_test.ts`; migration is part of this spec (see "Migration" below).
  - **C / ABI conformance** — already a slow tier today (`yurt-conf`, `make -C abi all`). Stays out of `pre-push`. CI handles it via `guest-compat.yml`.
- **GitHub Actions workflows.** Add two new files and extend one existing file:
  - `.github/workflows/rust.yml` — new. Jobs: `fmt-check`, `clippy`, `test` (fast tier; runs `cargo test` over `default-members`). Triggered on `pull_request` and pushes to `main`.
  - `.github/workflows/deno.yml` — new. Jobs: `fmt-check`, `lint`, `check` (`deno check` over `packages/**/*.ts`), `test-fast` (fast tier; the existing CI test commands minus anything that requires the canary build). Triggered on `pull_request` and pushes to `main`.
  - `.github/workflows/guest-compat.yml` — extend. Add an `abi-check` job that runs `make -C abi check` for signature/header consistency, separated from the heavy canary build so its failure is legible. Existing canary/fixture jobs preserved unchanged. The full Deno tests currently in `guest-compat.yml` are the canonical **slow** TS tier in CI; this spec does not move them.
- **Test classification pass.** As part of this work, every existing test gets classified as fast or slow. Fast = no wasm build, no external network, no spawning real subprocesses, completes under ~2 seconds. Slow = anything else. Misclassification is a defect to be fixed when noticed; the spec doesn't enumerate every test.
- **Documentation** — add `docs/contributing/gates.md` with the canonical list of commands and the slow/fast policy. CLAUDE.md §4 will reference it.

### Out of scope

- Replacing `guest-compat.yml`'s canary/fixture build. It works; this spec only adds an `abi-check` sibling job.
- A unified local task runner (e.g. `just`, `make`-everything). Each ecosystem keeps its native tooling; hooks just invoke the right tool.
- Coverage reporting, mutation testing, or any quality gate beyond format / lint / typecheck / test.
- Performance benchmarks or regression gates. Out of scope; tracked separately.
- A `pre-rebase` or `commit-msg` hook. Not needed for the stated problem.
- Migrating existing tests to use new frameworks or restructuring test directories. The slow/fast partition is the only test-side change here.
- Adding hooks for languages not yet in the repo (Go etc.). When a language arrives, it gets added to this design.
- Bypass policy beyond what `pre-commit` provides natively (`SKIP=<hook>` env var, `--no-verify`). Don't bypass casually; the existing CLAUDE.md non-negotiables apply.

## Architecture

### Components

1. **`.pre-commit-config.yaml`** at repo root. The single configuration file for all local hooks. References `pre-commit-hooks` (generic), `rust-pre-commit` or local shell wrappers (Rust), and local shell wrappers (Deno; no upstream hook repo for it).
2. **`.github/workflows/rust.yml`** — Rust CI. Jobs run in parallel: `fmt-check`, `clippy`, `test`. Cached via `Swatinem/rust-cache@v2` (already used by `guest-compat.yml`).
3. **`.github/workflows/deno.yml`** — Deno CI. Jobs run in parallel: `fmt-check`, `lint`, `check`, `test-fast`.
4. **`.github/workflows/guest-compat.yml`** — extended with an `abi-check` job for signature/header consistency. The heavy canary/fixture jobs are unchanged.
5. **`scripts/install-hooks.sh`** — one-liner wrapper that runs `pre-commit install --install-hooks --hook-type pre-commit --hook-type pre-push`. Documented in `docs/contributing/gates.md` and referenced by `scripts/dev-init.sh` so a fresh clone is one command from gated.
6. **`docs/contributing/gates.md`** — canonical command/policy doc.

### Test partition mechanics

**Rust.** A test that is slow (network, spawning subprocesses, building wasm, multi-second compute) gets `#[ignore]` with a one-line `// reason: …` comment above it. `cargo test` runs the fast tier; the slow tier is `cargo test -- --include-ignored`, which CI runs in `guest-compat.yml`-equivalents (existing or new) and `pre-push` does *not* run.

**TypeScript / Deno.** A test that is slow gets moved into a sibling file with suffix `_integration_test.ts`. The fast tier glob is `packages/**/*_test.ts`; the slow tier glob is `packages/**/*_integration_test.ts`. The current Deno test files use the suffix `*.test.ts`; this spec includes the rename to `*_test.ts` so the suffix-based glob discrimination works. The rename is mechanical and is part of the implementation plan.

### Hook orchestration

`pre-commit` runs hooks in the order declared. Hooks are independent and can run in parallel when configured (`pre-commit` does this automatically for hooks without overlapping file targets). Slow hooks (test runs at `pre-push`) are gated by `stages: [pre-push]` so they don't fire on every commit.

### CI parallelism

Each new workflow has independent jobs that run in parallel. Required-status checks are configured to require the new workflows to pass for merge into `main`. Adding the required-check configuration is part of the implementation plan.

## Migration

The existing test file suffix is `*.test.ts`, not `*_test.ts`. The fast/slow partition relies on suffix-based globs, so we migrate to the Deno-stdlib convention as part of this work:

- `*.test.ts` → `*_test.ts` (fast tier, default).
- New convention `*_integration_test.ts` for slow tier.

Test files identified as slow today (network-heavy, spawn-heavy, wasm-build-heavy) are renamed at the same time. The implementation plan enumerates the file moves.

The Rust slow-test pass tags existing slow tests with `#[ignore]`. Initial classification is conservative — when in doubt, mark fast and let `pre-push` time tell us otherwise.

## Error handling

- **Hook failure** is the desired path. The fix is the change that makes the hook pass; do not bypass with `--no-verify` casually. The existing CLAUDE.md non-negotiables apply.
- **CI failure** blocks merge via required-status checks.
- **Hook authoring errors** (e.g. a misconfigured local hook) are the responsibility of the change that introduces them. `pre-commit run --all-files` is the canonical local self-check.

## Testing

- **Hook config**: `pre-commit run --all-files` must pass on a clean checkout of `main` immediately after this work lands. CI gains a job in `deno.yml` that runs this command (as a portable way of validating the hook config without depending on contributors having `pre-commit` installed).
- **Workflow files**: validated by GitHub Actions itself on first push. No additional gating.
- **Slow/fast partition**: a sample contributor flow is documented in `docs/contributing/gates.md` and exercised by the implementation plan.

## Open questions

- Whether to enable `pre-commit.ci` (the hosted bot that auto-applies `pre-commit` fixes). Not blocking; can be turned on later.
- Whether to add a `commit-msg` hook later for conventional-commits enforcement. Out of scope here.
- Whether to add `cargo-deny` or `cargo-audit` as part of the Rust workflow. Defer to a separate spec on supply-chain gates.
