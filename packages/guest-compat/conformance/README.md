# Guest Compatibility Conformance Tree

This tree hosts the paired C/Rust canaries and their behavioral specs. It is
introduced in Step 1 of the guest compatibility runtime migration. See
[`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../../../docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md),
§Conformance Testing.

Current contents (Step 1):

- `c/` — C canaries (migrated from `packages/c-compat/examples/`).
- `rust/` — placeholder. Rust canaries land in Step 3d.

Deferred to Step 3a: `<symbol>.spec.toml` behavioral specs that both
language canaries execute against.
