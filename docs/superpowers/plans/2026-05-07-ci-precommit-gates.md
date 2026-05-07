# CI and Local Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the local hooks (`pre-commit`, `pre-push`) and CI workflows (Rust, Deno) defined in `docs/superpowers/specs/2026-05-07-ci-precommit-gates-design.md`, with a slow/fast test partition that keeps `pre-push` fast.

**Architecture:** The `pre-commit` framework owns local hook orchestration via `.pre-commit-config.yaml`. Pre-commit stage runs format + lint only; pre-push stage adds the fast test tier. Two new GitHub Actions workflows split Rust and Deno gates. Slow tests are tagged: Rust uses `#[ignore]`; Deno uses the filename suffix `_integration_test.ts` (which requires renaming the existing `*.test.ts` files to `*_test.ts` so the suffix-based discrimination works).

**Tech Stack:** `pre-commit` (Python framework), GitHub Actions, `cargo` 1.95.0 (CI pin), `rustfmt`, `clippy`, `deno` v2.x.

**Spec deviation:** the design's `abi-check` extension to `guest-compat.yml` is dropped from this plan because `make -C abi check` does not exist. The ABI signature-check gate is tracked as a separate follow-up (see "Out-of-plan follow-ups" at the bottom).

---

## File Structure

**New files:**
- `.pre-commit-config.yaml` — root hook config.
- `.github/workflows/rust.yml` — Rust CI (fmt, clippy, fast test tier).
- `.github/workflows/deno.yml` — Deno CI (fmt, lint, check, fast test tier, hooks self-check).
- `scripts/install-hooks.sh` — installs `pre-commit` (via `pipx`/`brew`) and runs `pre-commit install --hook-type pre-commit --hook-type pre-push`.
- `scripts/lint-clippy-changed.sh` — wrapper that scopes clippy to crates with changed files (used by precommit hook for speed).
- `docs/contributing/gates.md` — contributor-facing reference for fmt/lint/test commands and slow/fast policy.

**Modified files:**
- `scripts/dev-init.sh` — append a "hooks installed?" check that nudges the contributor to run `scripts/install-hooks.sh`.
- All `packages/**/*.test.ts` files — renamed to `*_test.ts` (mechanical, scripted).

**Out of scope (this plan):**
- `make -C abi check` and the `abi-check` CI job — spec deviation, deferred.
- Bootstrap script (separate spec, parked).

---

### Task 1: Confirm fast tier for `cargo test` is empty-or-quick today

**Goal:** Establish a baseline. We don't want to add a CI job that takes 5 minutes on day one. If the host-side fast tier is too slow, we tag aggressively in Task 9; if it's already fast, we skip aggressive tagging.

**Files:**
- None modified.

- [ ] **Step 1: Time `cargo test` over the workspace default-members**

Run:

```bash
time cargo test --workspace --tests --no-fail-fast 2>&1 | tail -20
```

Expected: completes in under 60 seconds on a developer machine. Record the time in your scratch notes for use in Task 9.

If it takes longer than 90 seconds, plan to tag the slowest test files with `#[ignore]` in Task 9 and re-time. If it doesn't compile at all, fix the build before continuing — but compile errors here are out of scope for this plan and indicate broken `main`.

- [ ] **Step 2: Note any test that hits network, spawns a real subprocess, or builds wasm**

Run:

```bash
grep -rn -E "reqwest::|::spawn\(|TcpStream|Command::new|wasm32-wasip1" $(find . -path '*/tests/*.rs' -o -name '*_test.rs' -not -path './target/*')
```

Record findings — these are the candidates for `#[ignore]` in Task 9.

---

### Task 2: Mechanical rename `*.test.ts` → `*_test.ts`

**Goal:** Adopt the Deno-stdlib filename convention so the slow-tier suffix `_integration_test.ts` is unambiguous.

**Files:**
- All 68 `packages/**/*.test.ts` files renamed to `packages/**/*_test.ts`.
- Any string literal references in code, scripts, or workflows updated.

- [ ] **Step 1: Run the rename via `git mv`**

Run:

```bash
set -euo pipefail
while IFS= read -r -d '' f; do
  new="${f%.test.ts}_test.ts"
  git mv "$f" "$new"
done < <(find packages -type f -name '*.test.ts' -print0)
```

Expected: 68 files moved (count from spec); `git status` shows R-renames.

- [ ] **Step 2: Find and update string-literal references to old names**

Run:

```bash
grep -rn -E "\.test\.ts" .github/ scripts/ packages/ Cargo.toml deno.json 2>/dev/null | grep -v target/ | grep -v node_modules/ | grep -v _test.ts | grep -v '\.git/'
```

For each match, edit the file to use the `_test.ts` name. Common locations:
- `.github/workflows/guest-compat.yml` — explicit test file paths in `deno test` invocations.
- Any `scripts/*.sh` or `scripts/*.ts` that names a specific test file.

- [ ] **Step 3: Run the existing CI test set against renamed files**

Run the exact commands from `.github/workflows/guest-compat.yml`'s "Run … tests" steps with the updated paths:

```bash
deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/fixture-build-smoke_test.ts packages/kernel/src/process/__tests__/module-cache_test.ts
```

Repeat for each of the five `Run …` steps in `guest-compat.yml`. Expected: each invocation completes (pass or fail same as before the rename — a pre-existing failure stays failing; no test should newly fail because of the rename).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(naming): rename *.test.ts to *_test.ts

Adopts the Deno stdlib filename convention so the slow-tier suffix
*_integration_test.ts is unambiguous. Mechanical rename, no behavior
change. Updates string-literal references in CI workflows and scripts."
```

---

### Task 3: Add `.pre-commit-config.yaml`

**Goal:** Wire up the pre-commit framework with the fast-tier hooks (fmt, lint, hygiene).

**Files:**
- Create: `.pre-commit-config.yaml`.

- [ ] **Step 1: Write the config**

Create `.pre-commit-config.yaml`:

```yaml
# yurtos-kernel pre-commit config
# Local hooks orchestrated by https://pre-commit.com.
# Install: scripts/install-hooks.sh
default_install_hook_types: [pre-commit, pre-push]
fail_fast: false

repos:
  # Generic hygiene
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v5.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-merge-conflict
      - id: check-added-large-files
        args: [--maxkb=1024]

  # Local hooks (no upstream repo for these tools)
  - repo: local
    hooks:
      - id: cargo-fmt-check
        name: cargo fmt --check
        entry: cargo fmt --all -- --check
        language: system
        types_or: [rust]
        pass_filenames: false
        stages: [pre-commit]

      - id: cargo-clippy-changed
        name: cargo clippy (changed crates)
        entry: scripts/lint-clippy-changed.sh
        language: system
        types_or: [rust]
        pass_filenames: false
        stages: [pre-commit]

      - id: deno-fmt-check
        name: deno fmt --check
        entry: deno fmt --check
        language: system
        types_or: [ts, tsx, javascript]
        pass_filenames: false
        stages: [pre-commit]

      - id: deno-lint
        name: deno lint
        entry: deno lint
        language: system
        types_or: [ts, tsx, javascript]
        pass_filenames: false
        stages: [pre-commit]

      # Pre-push only
      - id: cargo-test-fast
        name: cargo test (fast tier)
        entry: cargo test --workspace --tests
        language: system
        types_or: [rust]
        pass_filenames: false
        stages: [pre-push]

      - id: deno-test-fast
        name: deno test (fast tier)
        entry: bash -c 'deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run "packages/**/*_test.ts"'
        language: system
        types_or: [ts, tsx, javascript]
        pass_filenames: false
        stages: [pre-push]
```

- [ ] **Step 2: Commit**

```bash
git add .pre-commit-config.yaml
git commit -m "chore(hooks): add pre-commit config

Pre-commit stage: cargo fmt --check, scoped clippy, deno fmt --check,
deno lint, generic hygiene. Pre-push stage: workspace cargo test (fast
tier) and deno test over the *_test.ts glob.

Hook scripts (scripts/install-hooks.sh, scripts/lint-clippy-changed.sh)
land in subsequent commits."
```

---

### Task 4: Add `scripts/lint-clippy-changed.sh`

**Goal:** Scope clippy to crates with staged changes so the precommit hook stays fast on a partial commit. Workspace-wide clippy is the CI bar; this is the local pragmatic version.

**Files:**
- Create: `scripts/lint-clippy-changed.sh`.

- [ ] **Step 1: Write the wrapper**

Create `scripts/lint-clippy-changed.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run cargo clippy scoped to crates that have staged Rust changes.
# Falls back to a full workspace lint if no Rust files are staged
# (e.g. when invoked via `pre-commit run --all-files`).

mapfile -t CHANGED < <(git diff --cached --name-only --diff-filter=ACMRT -- '*.rs' || true)

if [[ ${#CHANGED[@]} -eq 0 ]]; then
  exec cargo clippy --workspace --all-targets -- -D warnings
fi

# Map each changed file to the nearest Cargo.toml directory, dedupe.
declare -A CRATE_DIRS=()
for f in "${CHANGED[@]}"; do
  dir="$(dirname "$f")"
  while [[ "$dir" != "." && "$dir" != "/" ]]; do
    if [[ -f "$dir/Cargo.toml" ]]; then
      CRATE_DIRS["$dir"]=1
      break
    fi
    dir="$(dirname "$dir")"
  done
done

if [[ ${#CRATE_DIRS[@]} -eq 0 ]]; then
  exec cargo clippy --workspace --all-targets -- -D warnings
fi

for dir in "${!CRATE_DIRS[@]}"; do
  pkg="$(awk -F\" '/^name *=/ {print $2; exit}' "$dir/Cargo.toml")"
  if [[ -z "$pkg" ]]; then
    echo "lint-clippy-changed: could not parse package name in $dir/Cargo.toml" >&2
    exit 2
  fi
  echo "→ cargo clippy -p $pkg --all-targets -- -D warnings"
  cargo clippy -p "$pkg" --all-targets -- -D warnings
done
```

- [ ] **Step 2: Make executable and verify it runs**

```bash
chmod +x scripts/lint-clippy-changed.sh
scripts/lint-clippy-changed.sh
```

Expected: exits 0 (clean main) or fails with clippy errors that exist on `main` today. If clippy errors exist on `main`, fix them in a separate commit before continuing — that fix is in scope here because the hook can't go green otherwise.

- [ ] **Step 3: Commit**

```bash
git add scripts/lint-clippy-changed.sh
git commit -m "chore(hooks): scoped clippy wrapper for fast precommit

Maps staged *.rs files to their owning Cargo.toml package and runs
clippy per package with -D warnings. Falls back to --workspace when
no Rust files are staged (covers \`pre-commit run --all-files\`)."
```

---

### Task 5: Add `scripts/install-hooks.sh` and wire into `dev-init.sh`

**Goal:** One command from clone to gated.

**Files:**
- Create: `scripts/install-hooks.sh`.
- Modify: `scripts/dev-init.sh` — append a check that nudges if hooks aren't installed.

- [ ] **Step 1: Write the install script**

Create `scripts/install-hooks.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Install the pre-commit framework and register both pre-commit and
# pre-push hooks. Idempotent.

if ! command -v pre-commit >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install pre-commit
  elif command -v pipx >/dev/null 2>&1; then
    pipx install pre-commit
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user pre-commit
  else
    echo "install-hooks: need one of brew, pipx, or python3 to install pre-commit" >&2
    exit 1
  fi
fi

pre-commit install --hook-type pre-commit --hook-type pre-push
echo "install-hooks: pre-commit and pre-push hooks installed."
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/install-hooks.sh
```

- [ ] **Step 3: Append the nudge to `scripts/dev-init.sh`**

Add to the end of `scripts/dev-init.sh` (it's `source`-d, so don't `exit`):

```bash
# --- Hook check ---
if [[ -f .git/hooks/pre-commit ]] && grep -q "pre-commit.com" .git/hooks/pre-commit 2>/dev/null; then
  : # hooks installed
else
  echo "[dev-init] hint: run scripts/install-hooks.sh to install local gates"
fi
```

- [ ] **Step 4: Run the install script and verify**

```bash
./scripts/install-hooks.sh
ls -1 .git/hooks/pre-commit .git/hooks/pre-push
pre-commit run --all-files
```

Expected: both hook files present; `pre-commit run --all-files` runs every hook end-to-end. Some hooks may fail on existing tree state (formatting drift, lint findings) — those failures are real and need fixing in Task 7.

- [ ] **Step 5: Commit (just the scripts; the broader cleanup is Task 7)**

```bash
git add scripts/install-hooks.sh scripts/dev-init.sh
git commit -m "chore(hooks): install script and dev-init nudge

scripts/install-hooks.sh installs pre-commit (via brew/pipx/pip)
and registers pre-commit and pre-push hooks. dev-init.sh hints when
hooks aren't installed yet."
```

---

### Task 6: Document gates in `docs/contributing/gates.md`

**Goal:** Contributor-facing canonical reference, linked from CLAUDE.md (later) and README.md (later).

**Files:**
- Create: `docs/contributing/gates.md`.

- [ ] **Step 1: Write the doc**

Create `docs/contributing/gates.md`:

```markdown
# Local gates and CI

This repo gates on format, lint, and a fast test tier — locally on
`git commit` and `git push`, and in CI on `pull_request` / pushes to
`main`. Slow tests run separately.

## Local

Install the hooks once:

\`\`\`bash
scripts/install-hooks.sh
\`\`\`

This installs the `pre-commit` framework (via `brew`, `pipx`, or
`pip --user`) and registers both stages.

### `pre-commit` stage (runs on `git commit`)

- Generic hygiene: trailing whitespace, EOF newline, merge-conflict
  markers, large-file guard.
- `cargo fmt --all -- --check`.
- `cargo clippy -p <changed-crate> --all-targets -- -D warnings`
  (scoped to crates with staged changes).
- `deno fmt --check`.
- `deno lint`.

### `pre-push` stage (runs on `git push`)

Everything above, plus:

- `cargo test --workspace --tests` (fast tier — Rust slow tests are
  tagged `#[ignore]` and excluded by default).
- `deno test … "packages/**/*_test.ts"` (fast tier — slow Deno tests
  use the suffix `_integration_test.ts` and are excluded).

### Bypassing

Don't, casually. If a hook is wrong, fix the hook config in a PR.
For genuine emergencies the standard escapes apply (`SKIP=<hook>` env
var, `--no-verify`).

## Slow / fast partition

- **Rust:** `#[ignore]` with a one-line `// reason: …` comment.
  Run the slow tier with `cargo test -- --include-ignored`.
- **TypeScript / Deno:** filename suffix `_integration_test.ts`.
  Run the slow tier with `deno test "packages/**/*_integration_test.ts"`.
- **C / ABI conformance:** already tiered via `make -C abi all` /
  `yurt-conf`. Out of `pre-push` and out of the new Rust/Deno
  workflows; lives in `guest-compat.yml`.

## CI

- `.github/workflows/rust.yml` — `cargo fmt --check`, workspace
  `cargo clippy -- -D warnings`, `cargo test --workspace --tests`.
- `.github/workflows/deno.yml` — `deno fmt --check`, `deno lint`,
  `deno check`, fast-tier `deno test`, plus a self-check job that
  runs `pre-commit run --all-files`.
- `.github/workflows/guest-compat.yml` — toolchain, ABI canaries,
  Rust-std canaries, BusyBox fixture, the Deno tests that depend
  on canary fixtures (the slow Deno tier in CI).
```

- [ ] **Step 2: Commit**

```bash
git add docs/contributing/gates.md
git commit -m "docs(contributing): document local gates and CI tiers"
```

---

### Task 7: Make `pre-commit run --all-files` green on `main`

**Goal:** A new gate that's red on day one is worse than no gate. After installing hooks, fix every existing failure.

**Files:**
- Whatever `pre-commit run --all-files` flags.

- [ ] **Step 1: Run the full hook battery**

```bash
pre-commit run --all-files
```

Expected: some failures. Common ones:
- `trailing-whitespace` / `end-of-file-fixer` — auto-fix; just `git add` the result.
- `cargo fmt --check` — fix with `cargo fmt --all`.
- `cargo clippy -- -D warnings` (in `--all-files` mode this runs `--workspace`) — fix lint findings.
- `deno fmt --check` — fix with `deno fmt`.
- `deno lint` — fix lint findings.

- [ ] **Step 2: Commit auto-fixes (mechanical) separately from manual fixes**

```bash
# After auto-fix passes (whitespace, EOF, fmt), commit those:
git add -A
git commit -m "chore(format): apply pre-commit auto-fixes (whitespace, fmt)"

# Then commit manual lint fixes in a separate, reviewable commit:
git add -A
git commit -m "fix(lint): resolve clippy/deno-lint findings on main"
```

- [ ] **Step 3: Re-run until clean**

```bash
pre-commit run --all-files
```

Expected: every hook passes. If a hook is fundamentally broken (e.g. clippy is too slow to be useful), back off in `.pre-commit-config.yaml` and re-commit — but document the deviation in `docs/contributing/gates.md`.

---

### Task 8: Add `.github/workflows/rust.yml`

**Goal:** Rust gates in CI (fmt, clippy, fast tests).

**Files:**
- Create: `.github/workflows/rust.yml`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/rust.yml`:

```yaml
name: Rust

on:
  pull_request:
  push:
    branches: [main]

jobs:
  fmt-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
        with:
          components: rustfmt
      - run: cargo fmt --all -- --check

  clippy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
        with:
          components: clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo clippy --workspace --all-targets -- -D warnings

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --workspace --tests
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/rust.yml
git commit -m "ci: add Rust workflow (fmt, clippy, fast test tier)"
```

- [ ] **Step 3: Verify on push**

After this commit lands on a branch, push and check the Actions tab. All three jobs should pass given Task 7's cleanup.

---

### Task 9: Tag Rust slow tests with `#[ignore]` (only if Task 1 found offenders)

**Goal:** Keep `cargo test --workspace --tests` under the time budget for `pre-push` and CI. Skip this task entirely if Task 1 showed the suite is already fast.

**Files:**
- Whichever Rust test files Task 1 flagged as slow (network / spawn / wasm-build / multi-second compute).

- [ ] **Step 1: Tag each offender**

For each slow test, add the `#[ignore]` attribute and a one-line reason:

```rust
// reason: spins up a real wasmtime instance and executes a wasm fixture (~3s)
#[ignore]
#[test]
fn end_to_end_run() {
    // …
}
```

- [ ] **Step 2: Re-time and verify**

```bash
time cargo test --workspace --tests
```

Expected: under the budget you set in Task 1 (target: <60s on a developer machine).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(rust): tag slow tests with #[ignore]

Slow tests excluded from \`cargo test\` by default; run them with
\`cargo test -- --include-ignored\`. See docs/contributing/gates.md."
```

---

### Task 10: Tag Deno slow tests via filename suffix (only if any exist)

**Goal:** Same logic, Deno side. The current 68 `*_test.ts` files are *all* assumed fast tier by default. Reclassify only the ones that are unambiguously slow (network-heavy, spawning busybox, building wasm fixtures).

**Files:**
- Each test file identified as slow.

- [ ] **Step 1: Identify slow files**

Likely candidates (audit each — don't blindly rename):

```bash
ls packages/kernel/src/__tests__/ | grep -E "conformance|busybox|coreutils|cpython|curl|jq"
```

The `*-conformance_test.ts` files are the obvious slow tier. Confirm by checking what each does — if it boots a real busybox or runs a coreutils suite, it's slow.

- [ ] **Step 2: Rename slow files**

```bash
git mv packages/kernel/src/__tests__/busybox-conformance_test.ts packages/kernel/src/__tests__/busybox-conformance_integration_test.ts
# …repeat for each confirmed slow file
```

- [ ] **Step 3: Update CI references**

Any explicit reference in `.github/workflows/guest-compat.yml` to a file you renamed must be updated. Grep:

```bash
grep -n integration_test .github/workflows/guest-compat.yml || echo "no references yet"
grep -nF '<old-name>' .github/workflows/
```

- [ ] **Step 4: Verify the fast glob still works**

```bash
deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run "packages/**/*_test.ts" -- --filter '__never_matches__'
```

This is a "list, don't run" check using a non-matching filter — it confirms the glob expansion works and finds files. Expected: completes quickly with "No tests found" (because of the filter), not an error.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(deno): tag slow tests via _integration_test.ts suffix

Slow tests excluded from the *_test.ts fast-tier glob. Run them with
\`deno test 'packages/**/*_integration_test.ts'\`."
```

---

### Task 11: Add `.github/workflows/deno.yml`

**Goal:** Deno gates in CI plus a `pre-commit run --all-files` self-check.

**Files:**
- Create: `.github/workflows/deno.yml`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/deno.yml`:

```yaml
name: Deno

on:
  pull_request:
  push:
    branches: [main]

jobs:
  fmt-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno fmt --check

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno lint

  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno check 'packages/**/*.ts'

  test-fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run 'packages/**/*_test.ts'

  hooks-self-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - uses: dtolnay/rust-toolchain@1.95.0
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-python@v5
        with:
          python-version: '3.x'
      - run: pip install pre-commit
      - run: pre-commit run --all-files --show-diff-on-failure
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deno.yml
git commit -m "ci: add Deno workflow + pre-commit self-check"
```

- [ ] **Step 3: Verify on push**

After this commit lands on a branch, push and check the Actions tab. All five jobs should pass.

---

### Task 12: Make required-status-checks reflect the new workflows

**Goal:** Branch protection on `main` requires the new workflows to pass. Without this, the gates are advisory.

**Files:** none (GitHub branch-protection settings).

- [ ] **Step 1: Update branch protection**

In the GitHub repo's `Settings → Branches → Branch protection rules → main`, add to "require status checks to pass before merging":

- `Rust / fmt-check`
- `Rust / clippy`
- `Rust / test`
- `Deno / fmt-check`
- `Deno / lint`
- `Deno / check`
- `Deno / test-fast`
- `Deno / hooks-self-check`

The existing `Guest Compat Fixtures / build-fixtures` requirement stays.

- [ ] **Step 2: Verify**

Open a throwaway PR that intentionally fails one gate (e.g. add trailing whitespace to a `.rs` file). The PR should be blocked from merging until the gate passes.

- [ ] **Step 3: Note in `docs/contributing/gates.md`**

Append a "Required checks" subsection listing the eight required jobs above so contributors can find what's required without leaving the repo. Commit:

```bash
git add docs/contributing/gates.md
git commit -m "docs(contributing): list required CI status checks"
```

---

## Out-of-plan follow-ups

These were in the spec but are **not** implemented by this plan; track separately:

- `make -C abi check` and a corresponding `abi-check` CI job. Requires defining what's actually checked (signature drift, header consistency). Spawn a small spec for this once the source-of-truth question is answered (`yurt-check` binary? bespoke target?).
- Vendoring superpowers and language skills (separate spec).
- CLAUDE.md §4 update referencing `docs/contributing/gates.md` (resume the CLAUDE.md brainstorm after this plan lands).
- `pre-commit.ci`, `cargo-deny`, `cargo-audit`, conventional-commit hook — listed as open questions in the spec.

---

## Self-Review

**Spec coverage:** Every in-scope item in the spec maps to a task:

- pre-commit framework adoption → Task 3
- pre-commit stage hooks (cargo fmt, clippy, deno fmt, deno lint, hygiene) → Task 3 + Task 4
- pre-push stage hooks (cargo test fast, deno test fast) → Task 3
- Rust slow-test partition (`#[ignore]`) → Task 9
- Deno slow-test partition (`*_integration_test.ts`) → Task 2 (rename) + Task 10
- `*.test.ts` → `*_test.ts` migration → Task 2
- `rust.yml` workflow → Task 8
- `deno.yml` workflow → Task 11
- `guest-compat.yml` extension (`abi-check`) → **deferred**, documented above
- Test classification pass → Task 9 + Task 10
- `scripts/install-hooks.sh` → Task 5
- `dev-init.sh` wiring → Task 5
- `docs/contributing/gates.md` → Task 6 + Task 12 (required-checks list)
- Required-status-checks configuration → Task 12 (added to plan; was implicit in spec's "required-check configuration is part of the implementation plan")

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate handling" — every step has concrete content or explicit deferral.

**Type consistency:** Hook IDs (`cargo-fmt-check`, `cargo-clippy-changed`, `deno-fmt-check`, `deno-lint`, `cargo-test-fast`, `deno-test-fast`) are referenced consistently across `.pre-commit-config.yaml`, `lint-clippy-changed.sh`, and `gates.md`. Workflow names (`Rust / fmt-check` etc.) match between the workflow files and the required-checks list.
