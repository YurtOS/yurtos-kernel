# Plan: #174 — clear yurt-shell-exec clippy/rustc warning debt

## Goal

`cargo clippy -p yurt-shell-exec --all-targets -- -D warnings` clean, with **zero
behavior change** (test fixture; mechanical only). No new tests — the existing
`yurt-shell-exec` suite is the regression guard (must stay green).

## Baseline (red)

55 warnings on `main` (3 lib + 55 lib-test, 3 dup):

| Count | Lint | Location |
| --- | --- | --- |
| 35 | unused variable `exit_code` | `executor.rs` tests |
| 10 | unused variable `run` | `executor.rs` tests |
| 1 | unused import `std::io::Write` | `wheel.rs:120` |
| 2 | `unnecessary_cast` (`i32`->`i32`) | `test_support.rs:371` |
| 2 | `type_complexity` | `expand.rs:948`, `test_support.rs:45` |
| 2 | `if_same_then_else` | `builtins.rs:3183`, `:3204` |
| 2 | `doc_lazy_continuation` | `executor.rs:417`, `:418` |
| 1 | `unnecessary_get_then_check` | `builtins.rs:3601` |

## Approach

1. **rustfix the machine-applicable bulk** — `cargo clippy --fix -p yurt-shell-exec
   --all-targets`: prefixes the 45 unused `exit_code`/`run` bindings with `_`,
   drops the dead `use std::io::Write`, removes the redundant `as i32`, rewrites
   `get("ll").is_none()` → `!contains_key("ll")`. All MachineApplicable, intent-
   preserving (the issue triaged these as intentionally-unused).
2. **`doc_lazy_continuation`** (`executor.rs:417`) — the two lines are a return-
   value paragraph after a `*` arg list; insert one blank `///` line to make it
   its own paragraph (clippy's own suggested resolution).
3. **`type_complexity`** — introduce transparent `type` aliases (no caller
   churn): `CmdSubExec` for `dyn Fn(&mut ShellState,&str)->String` (`expand.rs`),
   `SpawnHandler` for `Box<dyn Fn(&str,&[&str],&str)->MockSpawnOutput>`
   (`test_support.rs`).
4. **`if_same_then_else`** — both test closures are
   `if cmd.contains("echo") { RunResult::empty() } else { RunResult::empty() }`;
   `contains` is side-effect-free so collapse to `RunResult::empty()` and
   `_`-prefix the now-unused `cmd` param. Behavior-identical.

## Verify (green)

- `cargo clippy -p yurt-shell-exec --all-targets -- -D warnings` → clean
- `cargo test -p yurt-shell-exec` → all green (proves no behavior change)
- `cargo fmt --all -- --check` → clean
- `git diff` review: only `_`-prefixes, alias defs, one blank doc line, one
  collapsed `if` per closure — no logic touched.

Out of scope: adding `exit_code` assertions to the tests (would change test
semantics; the issue explicitly scopes these as intentionally-unused).
