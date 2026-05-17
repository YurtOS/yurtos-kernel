# devfs entropy: `kh_random` → `/dev/urandom` + `METHOD_SYS_GETRANDOM` (fix #95)

- **Date:** 2026-05-17
- **Issue:** #95 (part of the missing-POSIX-surface tracker #83; parity tracker #52)
- **Branch:** `worktree-fix-95-devfs-entropy` off `origin/main`
- **Status:** design approved (4 review iterations), ready for implementation plan

## Problem

The Rust kernel (`packages/kernel-wasm`) exposes no entropy primitive, and by a
hard architectural invariant (`kernel.rs:16-20`) kernel.wasm imports **only**
`kh_*` — never `wasi_snapshot_preview1::random_get` (that is the whole reason
`BTreeMap` is used over `HashMap`). Guests still require CSPRNG bytes: Rust std
`HashMap`/`RandomState`, musl/glibc `getrandom`/`arc4random`, `getentropy`,
OpenSSL/`ring`, libuuid, Python `os.urandom`/`secrets`, Go. Today there is no
source, so these silently weaken, block, or abort.

The TS kernel already serves `/dev/urandom` + `/dev/random`
(`packages/kernel/src/vfs/dev-provider.ts`, via `crypto.getRandomValues`,
chunked at the Web Crypto 65536-byte cap). The Rust side must reach behavioral
parity so the B0 `YURT_KERNEL=both` differ is a true zero-diff row.

## Goals / non-goals

- **In:** a host-provided `kh_random` import; `/dev/urandom` + `/dev/random`
  devfs nodes; a `METHOD_SYS_GETRANDOM` syscall; native test stub; the real
  `runtime-wasmtime` host implementation; per-host sourcing contract.
- **Out (correctly factored elsewhere):** `getentropy()` is a thin **guest-libc**
  wrapper over `getrandom` (this is how musl implements it) — *not* a second
  kernel method. wasmedge/wasmer host stubs stay `todo!()` (compile-only;
  consistent with holistic M1). No PRNG, no kernel-held RNG state.

## Architecture

One host-agnostic ABI primitive; each host satisfies it with its platform
CSPRNG (the engine-agnostic point of the `kh_*` boundary).

### Component 1 — `kh_random` import (`packages/kernel-wasm/src/kh.rs`)

Mirrors `kh_now_realtime` / `kh_real_read`:

```rust
// in the #[link(wasm_import_module = "kh")] extern block:
fn kh_random(out_ptr: *mut u8, len: usize) -> i32;   // 0 = ok; <0 = -EIO
```

- Native (non-wasm) fallback stub: fill from `std::fs` read of host
  `/dev/urandom`. Std-only (no new crate dep — crate keeps deps to
  `tar`+`ruzstd`), gives genuine non-deterministic per-call bytes so
  `cargo test` distinctness assertions are real.
- One **safe** wrapper, the only entry point callers use (buffer logic in safe
  Rust per AGENTS.md):

  ```rust
  pub(crate) fn fill_random(buf: &mut [u8]) -> Result<(), i32>;
  ```

### Component 2 — host implementations (per-host sourcing contract)

| Host | `kh_random` source |
|---|---|
| kernel-wasm **native test stub** (`cargo test`) | `std::fs` `/dev/urandom` — dep-free, test-only |
| **runtime-wasmtime** (native, real host) | OS CSPRNG via the `getrandom` crate (already transitive through `reqwest`+`rustls-tls`, which the host links for `fetch()` TLS). Registered with `linker.func_wrap` in `kernel_host_interface.rs` beside the other `kh_*`; **ungated** (entropy is not privacy-sensitive like the `kh_now_realtime` clock gate). Standard guest-memory bounds check like the other `kh_real_*` host fns. |
| **kernel-host-interface-js** (Deno / Node / **browser** host running kernel.wasm) | `globalThis.crypto.getRandomValues()` (Web Crypto), chunked ≤65536 — **never `/dev/random`** (browsers have none). |
| wasmedge / wasmer | remain `todo!()` stubs — compile-only. |

### Component 3 — `DevBackend` nodes (`packages/kernel-wasm/src/vfs.rs:548`)

Add `DEV_URANDOM_INODE`, `DEV_RANDOM_INODE` (new constants alongside
`DEV_NULL_INODE`/`DEV_ZERO_INODE`):

- `open`: `b"/urandom" | b"/random" => Some(<inode>)`.
- `read(&self, inode, _offset, buf)`: `fill_random(buf)`, return `buf.len()`
  (never short; `/dev/random` == `/dev/urandom` — modern Linux semantics,
  matches the TS provider). `&self` is fine: `fill_random` needs no `&mut`
  state — this is *why* it is a host call, not backend-owned RNG state.
- `write`: swallow like `/dev/null` (`payload.len()`).
- `size`: `Some(0)`.

### Component 4 — `METHOD_SYS_GETRANDOM`

- `abi/contract/yurt_abi_methods.toml`: append `[method.sys_getrandom]`
  `id = 0x1_00A0`, `kind = "syscall"`, `doc` fully specifying:
  - Request: `u32 len LE` + `u32 flags LE`.
  - `flags`: `GRND_NONBLOCK=0x1`, `GRND_RANDOM=0x2` accepted; documented as
    no-ops (entropy is always ready here — never blocks, no separate pool).
    Unknown bits → `-EINVAL`.
  - Response buffer receives `len` random bytes.
  - Returns `len` on success; `-EINVAL` (unknown flags / request shorter than
    8 bytes / response buffer < `len`); `-EIO` (source failure).
- Dispatch arm in `packages/kernel-wasm/src/dispatch/mod.rs`
  (`METHOD_SYS_GETRANDOM => sys_getrandom(request, response)`); handler calls
  `fill_random`.
- **C1-safe** length decode (#65): subtraction-form guard
  (`request.len() < 8` early return, then no additive `a + len`), plus a
  width-aware regression test (32-bit `usize` on wasm32 vs 64-bit native).

## Data flow

`guest getrandom()/read("/dev/urandom")`
→ `METHOD_SYS_GETRANDOM` dispatch / `DevBackend::read`
→ `fill_random(buf)` (safe Rust)
→ `kh_random(buf.as_mut_ptr(), buf.len())` (host)
→ host platform CSPRNG → bytes in guest memory → returned.

## Security / determinism

There is **no kernel-held RNG state** — every draw is a fresh `kh_random`
host call. Therefore `mcp__sandbox` snapshot/restore and
`export_state`/`import_state` cannot replay entropy: there is nothing to
snapshot. #95's non-replay requirement is satisfied *structurally*, not by
added code. The source is always a real CSPRNG (OS / Web Crypto), never a
constant-seeded PRNG.

## Error handling

- `fill_random` → `Err(-EIO)` on host failure; propagated as `-EIO` from the
  syscall and as `-EIO` (read error) from `DevBackend::read`.
- Syscall arg validation returns `-EINVAL` before any host call.
- Length math uses the subtraction form exclusively (no `a + len`); covered by
  a width-aware test so the #65 class cannot regress invisibly.

## Testing (TDD)

Native lib tests (`cargo test -p yurt-kernel-wasm --lib`):
- `DevBackend`: `/dev/urandom` & `/dev/random` open → inode; `read` fills the
  whole buffer and returns `buf.len()`; two reads of a large buffer differ
  (real bytes via the native stub); `write` swallows; `size == 0`; unknown
  `/dev/*` still `None`.
- `METHOD_SYS_GETRANDOM`: correct length returned; bad-flags → `-EINVAL`;
  short request (<8 bytes) → `-EINVAL`; response-too-small → `-EINVAL`;
  width-aware C1 test (huge `len` does not wrap).
- `fmt`/`clippy` clean (`-D warnings`).

Named wasm fixture (B0 slow-tier, per #52): Rust `HashMap` insert does not
abort; `head -c 32 /dev/urandom | wc -c == 32`; `python -c
'import secrets; print(secrets.token_hex(16))'`; two processes get distinct
bytes; snapshot→restore yields fresh (non-replayed) bytes. B0
`YURT_KERNEL=both` differ: zero TS-vs-Rust diff (TS parity already exists via
`dev-provider.ts`).

Add the matrix row to
`docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md`.

## Acceptance (closes #95)

- [ ] `kh_random` import + native `/dev/urandom` stub + safe `fill_random`
- [ ] runtime-wasmtime host `kh_random` via `getrandom` crate (reuse TLS dep
      tree); wasmedge/wasmer compile
- [ ] kernel-host-interface-js `kh_random` via `crypto.getRandomValues`
      (no `/dev/random`)
- [ ] `DevBackend` `/dev/urandom` + `/dev/random`
- [ ] `METHOD_SYS_GETRANDOM` `0x1_00A0` (append-only) + dispatch + handler,
      C1-safe + width-aware test
- [ ] native tests green; `fmt`/`clippy` clean; matrix row; B0 fixture +
      zero-diff; #95 acceptance list satisfied
