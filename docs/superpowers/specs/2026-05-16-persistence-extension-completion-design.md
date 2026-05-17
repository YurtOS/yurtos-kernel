# Persistence / Extension Completion (slice B4) — Design

Part of the full-parity initiative (tracking #52, umbrella #57). Own PR off
`main` (`parity-b4-persistence`), same additive-TDD discipline as B1/B2/B3.
Does **not** touch the parity-matrix doc (status routes through #57; avoids the
#56 revert-then-reintroduce trap — see the PR #58 review).

## Grounded gap analysis (verified on `origin/main` @ 2454e59)

The kernel-side persistence/extension surface is **already wired**:

- `sys_idb_get/put/delete/list` dispatch methods exist (`dispatch/mod.rs`,
  ids `0x1_0035–0x1_0038`) and forward to `kh::idb_*`.
- `sys_extension_invoke` dispatch arm exists (forwards to `kh::extension_invoke`).
- The `kh_idb_*` / `kh_extension_invoke` externs + `pub fn` wrappers exist.

The **real gap** (memory `project_kh_idb_kv` says "natives emulate"):

- The native (`#[cfg(not(target_arch="wasm32"))]`) `kh_idb_get/put/delete/list`
  shims are pure `-38` (ENOSYS) stubs with **no `#[cfg(test)]` path** — unlike
  `kh_socket_connect` / `kh_dns_resolve`, which delegate to a `test_support`
  mock. Consequences:
  1. `sys_idb_*` dispatch (request parsing, store/key framing, the list
     `count+entries` encoding, ENOENT/size-truncation) is **not
     cargo-unit-testable** — it can only ever observe `-38`.
  2. A native runtime has **no working durable KV** at the kh boundary,
     contradicting the "natives emulate" model.

`kh_extension_invoke`'s native stub returning `-ENOSYS` is correct (extension
invocation is embedder-defined; there is nothing deterministic to emulate) —
left as-is, not in scope.

## Scope

**B4a (this slice — cargo-unit-testable):** a deterministic in-memory KV
emulation behind the native `kh_idb_*` shims under `#[cfg(test)]`, mirroring the
existing `SOCKET_MOCK` pattern, so:

- `sys_idb_get/put/delete/list` get real round-trip cargo coverage against the
  documented contract (`yurt_abi_methods.toml`):
  - `get` → bytes-written, `-ENOENT` if absent;
  - `put` → `0`;
  - `delete` → `0` whether or not present;
  - `list` → `u32 count_le + (u32 key_len_le + key_bytes)*`, BTreeMap-ordered,
    truncated to `out_cap` (count reflects only what fit).
- the native test runtime has a working durable KV.

Store model: `BTreeMap<store, BTreeMap<key, value>>` (ordered keys → deterministic
`list`), reset between tests like `reset_socket_mock`.

**B4b (cross-boundary, gate-sequenced — not this slice):** the real durable
backend behind the wasm `kh_idb_*` import (browser → IndexedDB, native runtime
→ on-disk/embedder store). That is host-adapter work measured against B0; it
does not block B4a and is not required for the kernel-side parity surface.

## Non-goals (B4)

- New method ids (the `sys_idb_*` ids predate the per-slice partition; nothing
  new is added — no `yurt_abi_methods.toml` change, no matrix-doc change).
- `kh_extension_invoke` native emulation (embedder-defined; `-ENOSYS` stub is
  correct).
- Real persistence across process restarts (B4b / host adapter).

## Testing (TDD order)

Kernel `#[cfg(test)]` red→green via the `dispatch()` harness:

1. put → get round-trips the value; get-missing → `-ENOENT`.
2. delete removes (get → `-ENOENT` after); delete-missing → `0`.
3. list with empty prefix returns all keys (count + framed, ordered);
   list with a prefix filters; list truncates to `out_cap` with a reduced
   count and never a partial entry.
4. store isolation: same key in two stores is independent.
5. input guards already covered by `sys_idb_*` (short request etc.) —
   re-asserted against the working backend.

Additive only; no behavior change for any other syscall. `cargo test
-p yurt-kernel-wasm --lib` + `cargo fmt --check` + `cargo clippy
--all-targets -- -D warnings` green; B0 differ unaffected (test-support only).

## Dependency / sequencing

Independent of B1/B2/B3. B4b is gate-sequenced after the B0 differ can measure
durable-KV parity TS-vs-Rust.
