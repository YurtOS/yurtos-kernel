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

Specs are intentionally selective. A symbol can be Tier 1 signature-covered
without a TOML spec when its behavior depends on host process state, networking,
or follow-up kernel work that is not deterministic enough for the trace harness.
