# Conformance Spec Schema

Each Tier 1 symbol has a behavioral spec at
`abi/conformance/<symbol>.spec.toml`. The driver
(`yurt-conf` via `yurt-toolchain`'s `spec` and `trace` modules) reads each
spec, iterates its cases, runs the named canary once per case as
`<canary> --case <name>`, captures one JSONL trace line on stdout, and
diffs the trace against `expected.*` fields.

## spec.toml shape

```toml
# Required: which canary executes the cases. The C canary lives at
# abi/conformance/c/<canary>.c; the Rust canary lives
# at abi/conformance/rust/<canary>/.
canary = "dup2-canary"

# Required: human-readable summary of what this symbol must do.
summary = "Renumber a guest-visible file descriptor."

[[case]]
# Required: case identifier. Must be unique within the spec, must match
# /^[a-z][a-z0-9_]*$/, and is what the canary receives via --case.
name = "happy_path"

# Optional: human-readable inputs. Documentation only — the canary
# hardcodes the actual call inputs keyed by `name`. The spec lists them
# so a reader can see what the case does without reading C code.
inputs = "dup2(1, 2)"

# At least one expected.* field is required.
expected.exit = 0
expected.stdout = "dup2-ok"

[[case]]
name = "invalid_fd"
inputs = "dup2(999, 2)"
expected.exit = 1
expected.errno = 9   # EBADF
```

## Allowed `expected.*` fields

| Field            | Type    | Meaning                                                  |
|------------------|---------|----------------------------------------------------------|
| `expected.exit`  | integer | Exact exit code the canary must report.                  |
| `expected.stdout`| string  | Exact stdout (one line, no trailing newline) the canary must print after JSONL parsing. The trace's `stdout` field. |
| `expected.errno` | integer | Numeric errno value the canary captured (POSIX numbers). |
| `expected.note`  | string  | Free-form description of the expected side effect; not diffed by the driver, surfaced in failure messages for human readers. |

Unknown `expected.*` fields are a parse error: the schema is closed.

## JSONL trace shape

The canary, invoked as `<canary> --case <name>`, prints exactly one
line to stdout, terminated by `\n`. The line is a JSON object with:

| Field    | Type    | Required | Notes                                                    |
|----------|---------|----------|----------------------------------------------------------|
| `case`   | string  | yes      | Echoes `--case` argument so the driver can validate.     |
| `exit`   | integer | yes      | Exit code the canary intends to report. The driver also captures the process exit code separately and asserts they agree. |
| `stdout` | string  | no       | Single observable line the canary "produced". Empty if the case is errno-only. |
| `errno`  | integer | no       | Captured `errno` after a failing call. Omit on success.  |

Trace lines do not contain newlines inside the JSON (canaries serialize
with no embedded `\n`). Stderr is not part of the trace.

## Diff rules

- For each `[[case]]` in the spec, the driver runs `<canary> --case <case.name>`.
- The captured stdout must be exactly one JSONL line whose `case` field equals `case.name`.
- For each `expected.<field>` present in the spec, the trace line's `<field>` must be present and equal.
- `expected.exit` is also asserted against the process exit code.
- `expected.note` is never diffed; surfaced only in failure messages.
- A case with no matching trace line is a failure (driver records "missing trace").
- Extra fields in the trace (beyond `case`/`exit`/`stdout`/`errno`) are ignored — forward-compatible.

## Canary CLI contract

```
<canary>                       # smoke mode: prints "<concept>-ok" on success (preserved
                               # so the kernel E2E suite at
                               # packages/kernel/src/__tests__/abi.test.ts
                               # keeps passing unchanged).
<canary> --case <name>         # spec-driven mode: emits one JSONL trace line.
<canary> --list-cases          # prints supported case names, one per line, on stdout.
                               # Used by the driver to detect spec/canary drift early.
```

Unknown `--case` values cause the canary to exit 2 with a message on
stderr. The driver surfaces this as "case not implemented in canary".

## Toolchain note — editor diagnostics are non-authoritative (#127)

All C/H under `abi/` (canaries in `abi/conformance/c/`, the libc shim in
`abi/src/`, headers in `abi/include/`) target **`wasm32-wasip1` via
`yurt-cc`/wasi-sdk** — that is the only authoritative compiler, and CI
uses it. An editor's host `clang` on a non-Linux dev machine (e.g.
macOS) checks these against the wrong libc/headers and emits noise:
`'yurt_abi.h' file not found` (it lives at `abi/include/yurt_abi.h`),
`Unknown attribute 'import_module'` (a wasm attribute), wrong-arity
`sendfile` (macOS ships the 6-arg BSD form; Linux/WASI is 4-arg), and
undeclared `setresuid`/`cuserid`/`SOCK_CLOEXEC`/`SO_PEERCRED` (Linux/
WASI symbols absent from host libc). **These are not defects** — the
sources are correct for their target.

`abi/compile_flags.txt` makes `clangd`-based editors check against the
real target (`--target=wasm32-wasip1 -Iinclude -D_GNU_SOURCE`),
clearing the dominant classes (missing `yurt_abi.h`, wrong attribute/
arity). If your editor still flags WASI-sysroot-only symbols, add a
local `--sysroot=<your wasi-sdk>/share/wasi-sysroot` to your editor
config — it is install-specific and intentionally not hard-coded here.
Bottom line: trust `yurt-cc`/CI, not host-clang, for `abi/` C.
