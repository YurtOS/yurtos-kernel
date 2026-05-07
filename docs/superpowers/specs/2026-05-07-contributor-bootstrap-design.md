# Contributor Bootstrap and Guest-Build Activation — Design (short)

**Date:** 2026-05-07
**Status:** Draft, parked. Pick up after the CI/local-gates spec lands so the bootstrap can be verified by `pre-commit run --all-files`.
**Replaces:** the implicit "follow the README and CI workflow to figure out what to install" onboarding flow.

## Motivation

Today a fresh contributor on macOS has no single command to go from clone to "ready to build host + guest + ABI." `scripts/dev-init.sh` only fixes `PATH` and warns if tools are missing; `scripts/install-yurt-toolchain.sh` only installs the yurt host-side toolchain binaries. There is no:

- macOS bootstrap that installs Rust, Deno, `uv`, `wasi-sdk`, Binaryen, etc.
- Way to "enter a guest-build shell" so bare `cc` / `cargo` produce wasm guest output without per-Makefile `CC=yurt-cc` overrides.

This spec covers both. macOS-only initially (matches CLAUDE.md's primary contributor target). Linux is a near-trivial follow-up — `guest-compat.yml` already encodes the Ubuntu equivalents inline.

## Scope

### In scope

- **`scripts/bootstrap-macos.sh`** — idempotent one-shot setup. Installs Homebrew packages, builds the yurt host toolchain, builds the ABI archive, builds canary fixtures. Acceptance: a fresh macOS user can clone the repo, run this, and have all CI gates pass locally.
  - Brew packages: `rustup` (or `rust`), `deno`, `uv`, `binaryen`, `wasi-sdk` (or manual install matching CI version pin).
  - Rust toolchain components matching CI: target `wasm32-wasip1`, component `rust-src`, version pin matching `dtolnay/rust-toolchain` in `guest-compat.yml`.
  - Run `scripts/install-yurt-toolchain.sh`.
  - Run `make -C abi all copy-fixtures`.
  - Run `scripts/build-rust-std.sh` to seed Rust-std canaries.
  - Print a one-line "next step" pointing at `source scripts/activate-guest-build.sh` and `pre-commit run --all-files`.
- **`scripts/activate-guest-build.sh`** — sourceable opt-in shell environment. Mirrors Python venv UX:
  - Exports `CC=yurt-cc`, `AR=yurt-ar`, `RANLIB=yurt-ranlib`, plus any other guest-targeted toolchain vars (`AS`, `LD` if needed).
  - Sets `CARGO_BUILD_TARGET=wasm32-wasip1` so bare `cargo build` from a guest crate directory hits the right target.
  - Prepends `(yurt-guest)` to `PS1`.
  - Defines a `deactivate` function that restores the prior environment (saves and restores prior values; doesn't just `unset`).
  - Idempotent (re-sourcing is a no-op).
- **`docs/contributing/onboarding.md`** — three commands: clone, bootstrap, activate. CLAUDE.md and the new root `README.md` both link here.

### Out of scope

- Linux bootstrap. Tracked as a near-trivial follow-up; same shape, different package manager.
- Windows bootstrap. Not on the contributor map yet.
- `direnv`-style auto-activation. Opt-in only — see "Mindset" below.
- Replacing existing per-Makefile `CC=yurt-cc` overrides. They keep working unconditionally; the activation env is a convenience for ad-hoc guest-build work, not a precondition.
- A `yurt-toolchain shellenv`-style subcommand. Could replace the shell script later; the script form is the lowest-friction MVP.
- Provisioning network access for `wasi-sdk` downloads behind enterprise firewalls. Documentation note only.

## Mindset notes (carry into implementation)

- **Opt-in activation, never default.** The repo has both host code (needs real `cc`) and guest code (needs `yurt-cc`). A globally redirected toolchain breaks host builds silently. Contributors enter the guest-build env with the same intentionality as a Python venv: `source`, do guest work, `deactivate`.
- **Activation is named for what it does, not the project.** The env is "guest build," not "yurt env." This reinforces the host-vs-guest distinction that the rest of the codebase organizes around.
- **The bootstrap pin must track CI.** Whenever `guest-compat.yml` bumps `wasi-sdk`, `binaryen`, or the Rust toolchain, the bootstrap script bumps in the same PR. Drift is a defect.

## Open questions

- Whether `wasi-sdk` should be installed via `brew` (when a tap exists) or via the manual tarball flow `guest-compat.yml` uses. Decide during implementation; pick whichever reproduces the CI version exactly.
- Whether to add a `bootstrap-doctor` subcommand that audits an existing install (versions, PATH, build artifacts) without reinstalling. Useful but not blocking.
- Whether to publish a Homebrew tap for the yurt toolchain itself. Out of scope; tracked separately.
