# Local gates and CI

This repo gates on format, lint, and a fast test tier — locally on
`git commit` and `git push`, and in CI on `pull_request` / pushes to
`main`. Slow tests run separately.

## Local

Install the hooks once:

```bash
scripts/install-hooks.sh
```

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
