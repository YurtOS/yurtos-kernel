# Guest Compatibility Conformance Tree

This tree hosts the paired C/Rust canaries and their behavioral specs. It is
introduced in Step 1 of the kernel ABI runtime migration. See
[`docs/superpowers/specs/2026-04-19-ABI-runtime-design.md`](../../../docs/superpowers/specs/2026-04-19-ABI-runtime-design.md),
§Conformance Testing.

Current contents:

- `c/` — C canaries covering compile/link precedence and selected behavior.
- `rust/` — Rust canaries for the runtime surface that is wired through
  `cargo-yurt` and the Yurt-built standard library.
- `*.spec.toml` — behavioral traces for deterministic cases that should be
  stable across the C and Rust frontends.
- `scripts/open-posix-harness.ts` — an opt-in runner for a curated subset of
  Bytecode Alliance's `open-posix-test-suite`. The upstream checkout and built
  wasm outputs live under ignored `test-fixtures/open-posix-*` paths.

Specs are intentionally selective. A symbol can be Tier 1 signature-covered
without a TOML spec when its behavior depends on host process state, networking,
or follow-up kernel work that is not deterministic enough for the trace harness.

Run the external POSIX subset manually with:

```bash
deno run -A scripts/open-posix-harness.ts
```

The default subset is intentionally small and pthread-focused:
`pthread_self/1-1`, `pthread_equal/1-1`, and `pthread_create/1-1`. Expand it
only when the corresponding kernel surface has deterministic behavior and
failures are actionable.
