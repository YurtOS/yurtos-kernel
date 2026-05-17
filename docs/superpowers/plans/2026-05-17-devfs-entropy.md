# devfs entropy (`kh_random` → /dev/urandom + METHOD_SYS_GETRANDOM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Rust kernel a real CSPRNG via a host `kh_random` import, exposed as `/dev/urandom`+`/dev/random` and `METHOD_SYS_GETRANDOM`, closing #95.

**Architecture:** One host-agnostic `kh_random(out_ptr,len)` import (mirrors `kh_now_realtime`); a single safe `fill_random` wrapper; `DevBackend` nodes + a syscall both call it; each host (native test stub / runtime-wasmtime / kernel-host-interface-js) supplies its platform CSPRNG. No kernel-held RNG state ⇒ snapshot-replay-safe by construction.

**Tech Stack:** Rust (`yurt-kernel-wasm`, `yurt-runtime-wasmtime`), TypeScript/Deno (`kernel-host-interface-js`), TOML ABI contract.

**Spec:** `docs/superpowers/specs/2026-05-17-devfs-entropy-design.md`

**Conventions (verified in-tree):** errno via `use crate::abi;` → `-(abi::EINVAL as i64)`; arg decode `request[0..4].try_into().expect("4 bytes")`; native stubs `#[cfg(not(target_arch = "wasm32"))]`; tests gated `let _g = crate::kernel::TestGuard::acquire();`; test shorthand `dispatch(method, pid, &req, &mut resp)` (`dispatch/mod.rs:242`). errno consts present: `EIO=5`, `EINVAL=22`, `EBADF=9`, `EFAULT=14`. Max ABI id in use = `0x1_009F` ⇒ **`0x1_00A0` is free**.

---

### Task 1: `kh_random` import + native stub + safe `fill_random` wrapper

**Files:**
- Modify: `packages/kernel-wasm/src/kh.rs` (extern block ~line 12; native stubs ~line 98; safe wrappers ~line 450)

- [ ] **Step 1: Write the failing test**

Append to the test module of `packages/kernel-wasm/src/kh.rs` (create `#[cfg(test)] mod tests { use super::*; … }` at end of file if absent):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_random_fills_buffer_with_entropy() {
        let mut a = [0u8; 64];
        let mut b = [0u8; 64];
        fill_random(&mut a).expect("entropy available in native test stub");
        fill_random(&mut b).expect("entropy available in native test stub");
        // Real CSPRNG: an all-zero 64-byte draw is astronomically unlikely,
        // and two draws must differ.
        assert!(a.iter().any(|&x| x != 0), "buffer left all-zero");
        assert_ne!(a, b, "two draws were identical");
    }

    #[test]
    fn fill_random_empty_is_ok() {
        fill_random(&mut []).expect("empty fill is a no-op success");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p yurt-kernel-wasm --lib kh::tests::fill_random 2>&1 | tail -5`
Expected: FAIL — `cannot find function fill_random in this scope`.

- [ ] **Step 3: Add the import declaration**

In `packages/kernel-wasm/src/kh.rs`, inside the `#[cfg(target_arch = "wasm32")] #[link(wasm_import_module = "kh")] extern "C" {` block, immediately after the `fn kh_now_realtime(out_ptr: *mut u64) -> i32;` line, add:

```rust
    fn kh_random(out_ptr: *mut u8, len: usize) -> i32;
```

- [ ] **Step 4: Add the native stub**

Immediately after the existing `#[cfg(not(target_arch = "wasm32"))] unsafe fn kh_now_realtime(...) { … }` block, add:

```rust
#[cfg(not(target_arch = "wasm32"))]
unsafe fn kh_random(out_ptr: *mut u8, len: usize) -> i32 {
    // Native unit-test entropy: real OS CSPRNG via /dev/urandom (std-only,
    // no extra crate dep) so distinctness assertions are meaningful. The
    // wasm hosts supply their own platform CSPRNG (runtime-wasmtime uses
    // the `getrandom` crate; kernel-host-interface-js uses Web Crypto).
    use std::io::Read;
    if len == 0 {
        return 0;
    }
    let buf = std::slice::from_raw_parts_mut(out_ptr, len);
    match std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)) {
        Ok(()) => 0,
        Err(_) => -crate::abi::EIO,
    }
}
```

- [ ] **Step 5: Add the safe wrapper**

After `pub fn now_realtime_ns() -> Result<u64, i32> { … }` in `packages/kernel-wasm/src/kh.rs`, add:

```rust
/// Fill `buf` with cryptographically secure random bytes from the host.
///
/// The single entropy entry point: `DevBackend` (`/dev/urandom`,
/// `/dev/random`) and `sys_getrandom` both call this, so all buffer
/// handling stays in safe Rust (AGENTS.md). There is intentionally no
/// kernel-held RNG state — every call is a fresh host draw, which is why
/// snapshot/restore cannot replay entropy.
pub fn fill_random(buf: &mut [u8]) -> Result<(), i32> {
    if buf.is_empty() {
        return Ok(());
    }
    let rc = unsafe { kh_random(buf.as_mut_ptr(), buf.len()) };
    if rc == 0 {
        Ok(())
    } else {
        Err(rc)
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p yurt-kernel-wasm --lib kh:: 2>&1 | tail -5`
Expected: PASS (`fill_random_fills_buffer_with_entropy`, `fill_random_empty_is_ok`).

- [ ] **Step 7: Commit**

```bash
git add packages/kernel-wasm/src/kh.rs
git commit -m "feat(#95): kh_random import + native /dev/urandom stub + fill_random wrapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `DevBackend` `/dev/urandom` + `/dev/random`

**Files:**
- Modify: `packages/kernel-wasm/src/vfs.rs` (consts ~545; `DevBackend` impl 562-601; tests mod 849+)

- [ ] **Step 1: Write the failing test**

In the `#[cfg(test)] mod tests` of `packages/kernel-wasm/src/vfs.rs` (after `use super::*;`), add:

```rust
#[test]
fn devbackend_urandom_and_random_yield_entropy() {
    let mut dev = DevBackend::new();
    for name in [b"/urandom".as_slice(), b"/random".as_slice()] {
        let inode = dev.open(name, 0).expect("node exists");
        let mut a = [0u8; 48];
        let mut b = [0u8; 48];
        assert_eq!(dev.read(inode, 0, &mut a), 48, "fills whole buffer");
        assert_eq!(dev.read(inode, 0, &mut b), 48);
        assert!(a.iter().any(|&x| x != 0), "all-zero draw");
        assert_ne!(a, b, "identical draws");
        // Writes are swallowed like /dev/null; size is 0.
        assert_eq!(dev.write(inode, 0, b"discard me"), 10);
        assert_eq!(dev.size(inode), Some(0));
    }
    // Unknown /dev/* still unmapped.
    assert_eq!(dev.open(b"/nope", 0), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p yurt-kernel-wasm --lib vfs::tests::devbackend_urandom 2>&1 | tail -5`
Expected: FAIL — `dev.open(b"/urandom", 0)` returns `None` → `expect("node exists")` panics.

- [ ] **Step 3: Add the inode constants**

In `packages/kernel-wasm/src/vfs.rs`, after `const DEV_ZERO_INODE: u64 = 2;` (line 546) add:

```rust
const DEV_URANDOM_INODE: u64 = 3;
const DEV_RANDOM_INODE: u64 = 4;
```

- [ ] **Step 4: Wire `open`, `read`, `write`, `size`**

In `impl VfsBackend for DevBackend`:

`open` match — add after `b"/zero" => Some(DEV_ZERO_INODE),`:
```rust
            b"/urandom" => Some(DEV_URANDOM_INODE),
            b"/random" => Some(DEV_RANDOM_INODE),
```

`read` match — add a new arm before the `_ =>` fallback:
```rust
            DEV_URANDOM_INODE | DEV_RANDOM_INODE => {
                // /dev/random == /dev/urandom (modern Linux semantics;
                // matches packages/kernel/src/vfs/dev-provider.ts). Never
                // short. `&self` is fine: fill_random holds no RNG state.
                match crate::kh::fill_random(buf) {
                    Ok(()) => buf.len() as i64,
                    Err(_) => -(crate::abi::EIO as i64),
                }
            }
```

`write` match — extend the swallow arm:
```rust
            DEV_NULL_INODE | DEV_ZERO_INODE | DEV_URANDOM_INODE | DEV_RANDOM_INODE => {
                payload.len() as i64
            }
```

`size` match — extend the zero arm:
```rust
            DEV_NULL_INODE | DEV_ZERO_INODE | DEV_URANDOM_INODE | DEV_RANDOM_INODE => Some(0),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p yurt-kernel-wasm --lib vfs::tests::devbackend_urandom 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel-wasm/src/vfs.rs
git commit -m "feat(#95): DevBackend /dev/urandom + /dev/random via fill_random

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `METHOD_SYS_GETRANDOM` ABI + dispatch + handler

**Files:**
- Modify: `abi/contract/yurt_abi_methods.toml` (append a `[method.sys_getrandom]` block)
- Modify: `packages/kernel-wasm/src/dispatch/mod.rs` (match arm in `dispatch_with_context`; handler fn near `pread_fd` ~803)
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

In `packages/kernel-wasm/src/dispatch/tests.rs` add:

```rust
fn gr_req(len: u32, flags: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(8);
    v.extend_from_slice(&len.to_le_bytes());
    v.extend_from_slice(&flags.to_le_bytes());
    v
}

#[test]
fn getrandom_fills_response_and_validates_args() {
    let _g = crate::kernel::TestGuard::acquire();

    // Happy path: 32 bytes, no flags.
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    assert_eq!(dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(32, 0), &mut a), 32);
    assert_eq!(dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(32, 0), &mut b), 32);
    assert!(a.iter().any(|&x| x != 0));
    assert_ne!(a, b);

    // GRND_NONBLOCK|GRND_RANDOM accepted (no-ops).
    let mut c = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(16, 0b11), &mut c), 16);

    // Unknown flag bit -> -EINVAL.
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(8, 0b100), &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );

    // Short request (<8 bytes) -> -EINVAL.
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &[0u8; 4], &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );

    // Response smaller than len -> -EINVAL (subtraction-form guard; #65).
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(64, 0), &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );

    // Width-aware C1 (#65): u32::MAX len must not wrap/panic; clean -EINVAL.
    assert_eq!(
        dispatch(METHOD_SYS_GETRANDOM, 1, &gr_req(u32::MAX, 0), &mut [0u8; 8]),
        -(crate::abi::EINVAL as i64)
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p yurt-kernel-wasm --lib dispatch::tests::getrandom 2>&1 | tail -5`
Expected: FAIL — `cannot find value METHOD_SYS_GETRANDOM` (constant not generated yet).

- [ ] **Step 3: Append the ABI contract entry**

Add to the end of `abi/contract/yurt_abi_methods.toml`:

```toml
[method.sys_getrandom]
id = 0x1_00A0
kind = "syscall"
doc = "POSIX getrandom(buf, buflen, flags). Request: u32 len LE + u32 flags LE (8 bytes). Response buffer receives `len` cryptographically secure random bytes from the host CSPRNG. flags: GRND_NONBLOCK (0x1) and GRND_RANDOM (0x2) are accepted and are no-ops (entropy is always ready; never blocks, no separate pool); any other bit -> -EINVAL. Returns `len` on success; -EINVAL for unknown flags, a request shorter than 8 bytes, or a response buffer smaller than `len`; -EIO if the host entropy source fails. Length is bounded with the subtraction form (issue #65 class). getentropy() is a thin guest-libc wrapper over this method, not a separate id."
```

- [ ] **Step 4: Add the dispatch arm and handler**

In `packages/kernel-wasm/src/dispatch/mod.rs`, in the `match method_id` of `dispatch_with_context`, add next to the other `METHOD_SYS_*` arms (e.g., after the `METHOD_SYS_PREAD => pread_fd(...)` line):

```rust
        METHOD_SYS_GETRANDOM => sys_getrandom(request, response),
```

Then add the handler near `pread_fd`:

```rust
/// POSIX getrandom(2). See `[method.sys_getrandom]` in
/// `abi/contract/yurt_abi_methods.toml` for the wire contract.
fn sys_getrandom(request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let len = u32::from_le_bytes(request[0..4].try_into().expect("4 bytes")) as usize;
    let flags = u32::from_le_bytes(request[4..8].try_into().expect("4 bytes"));
    // Only GRND_NONBLOCK (0x1) and GRND_RANDOM (0x2) are defined; both are
    // no-ops here. Reject unknown bits.
    if flags & !0b11 != 0 {
        return -(abi::EINVAL as i64);
    }
    // Subtraction-form bound (issue #65 class): never `4 + len`. `usize`
    // is 32-bit on wasm32; an oversized/wrapped `len` fails this guard
    // rather than slicing out of bounds.
    if response.len() < len {
        return -(abi::EINVAL as i64);
    }
    match crate::kh::fill_random(&mut response[..len]) {
        Ok(()) => len as i64,
        Err(_) => -(abi::EIO as i64),
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p yurt-kernel-wasm --lib dispatch::tests::getrandom 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add abi/contract/yurt_abi_methods.toml packages/kernel-wasm/src/dispatch/mod.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(#95): METHOD_SYS_GETRANDOM 0x1_00A0 (C1-safe, width-aware test)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: runtime-wasmtime host `kh_random`

**Files:**
- Modify: `packages/runtime-wasmtime/Cargo.toml` (add `getrandom`)
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs` (`register_kh_imports`, after the `kh_now_realtime` `func_wrap`)

- [ ] **Step 1: Add the dependency**

In `packages/runtime-wasmtime/Cargo.toml` under `[dependencies]` (after the `reqwest` line) add:

```toml
getrandom = "0.2"
```

- [ ] **Step 2: Register the host import**

In `packages/runtime-wasmtime/src/kernel_host_interface.rs`, inside `fn register_kh_imports`, immediately after the closing `)?;` of the `"kh_now_realtime"` `linker.func_wrap(...)` call, add:

```rust
    linker.func_wrap(
        KH_NAMESPACE,
        "kh_random",
        |mut caller: Caller<'_, KernelStoreData>, out_ptr: u32, len: u32| -> i32 {
            // Entropy is not privacy-sensitive (unlike the kh_now_realtime
            // clock gate) — ungated. OS CSPRNG via the `getrandom` crate
            // (already in the dep tree through rustls-tls for fetch()).
            let len = len as usize;
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(m) => m,
                None => return -(EFAULT as i32),
            };
            let mut buf = vec![0u8; len];
            if getrandom::getrandom(&mut buf).is_err() {
                return -(EIO as i32);
            }
            if memory.write(&mut caller, out_ptr as usize, &buf).is_err() {
                return -(EFAULT as i32);
            }
            0
        },
    )?;
```

(If `EIO` is not already imported in this file, add it to the existing `use` that brings in `EFAULT`/`EACCES` — same module path.)

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build -p yurt-runtime-wasmtime 2>&1 | tail -5`
Expected: builds clean (wasmedge/wasmer stubs untouched).

- [ ] **Step 4: Commit**

```bash
git add packages/runtime-wasmtime/Cargo.toml packages/runtime-wasmtime/src/kernel_host_interface.rs Cargo.lock
git commit -m "feat(#95): runtime-wasmtime kh_random host import (getrandom crate)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: kernel-host-interface-js `kh_random` (browser/Deno: Web Crypto)

**Files:**
- Modify: `packages/kernel-host-interface-js/mod.ts` (`khImports`, after `kh_now_realtime` ~line 2233)

- [ ] **Step 1: Add the import**

In `packages/kernel-host-interface-js/mod.ts`, in the `khImports` object, immediately after the `kh_now_realtime: (outPtr: number): number => { … },` entry, add:

```ts
      kh_random: (outPtr: number, len: number): number => {
        // Platform CSPRNG via Web Crypto — Deno, Node (globalThis.crypto),
        // and browsers. Never /dev/random (browsers have none). Web Crypto
        // caps at 65536 bytes per call, so chunk; mirrors the TS kernel's
        // packages/kernel/src/vfs/dev-provider.ts.
        if (len === 0) return 0;
        try {
          const view = new Uint8Array(memoryRef.memory!.buffer, outPtr, len);
          for (let off = 0; off < len; off += 65536) {
            crypto.getRandomValues(
              view.subarray(off, Math.min(off + 65536, len)),
            );
          }
          return 0;
        } catch {
          return -EIO;
        }
      },
```

- [ ] **Step 2: Type-check**

Run: `deno check packages/kernel-host-interface-js/mod.ts 2>&1 | tail -5`
Expected: no errors. (Confirm `EIO` is in scope in this module — `EACCES`/`EBADF` already are; if not, add it to the same errno const block.)

- [ ] **Step 3: Commit**

```bash
git add packages/kernel-host-interface-js/mod.ts
git commit -m "feat(#95): kernel-host-interface-js kh_random via Web Crypto (browser-safe)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: parity matrix row + B0 fixture note

**Files:**
- Modify: `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md`

- [ ] **Step 1: Add the matrix row**

Add a row to the table in `docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md` (in the `fs`/`fd` area, matching the existing column structure):

```
| fs | host_random / /dev/urandom | METHOD_SYS_GETRANDOM (0x1_00A0) + DevBackend /dev/urandom,/dev/random via kh_random | kernel-wasm DevBackend + kh_random | all KH adapters (wasmtime: getrandom crate; js: Web Crypto) | partial | getrandom dispatch tests, DevBackend entropy tests, B0 /dev/urandom fixture (TS parity exists via dev-provider.ts) |
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-15-rust-kernel-parity-matrix-design.md
git commit -m "docs(#95): parity matrix row for devfs entropy

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Full verification + PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Full kernel-wasm suite + lint**

Run:
```bash
cargo test -p yurt-kernel-wasm --lib 2>&1 | tail -3
cargo fmt -- --check 2>&1 | tail -2
cargo clippy -p yurt-kernel-wasm --all-targets -- -D warnings 2>&1 | tail -3
```
Expected: all tests pass (baseline was 394; now 394 + new tests, 0 failed); fmt clean; clippy clean.

- [ ] **Step 2: Host build**

Run: `cargo build -p yurt-runtime-wasmtime 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin worktree-fix-95-devfs-entropy
```

- [ ] **Step 4: Open the PR (do not self-merge)**

```bash
gh pr create -R YurtOS/yurtos-kernel --base main \
  --title "fix(#95): devfs entropy — kh_random → /dev/urandom + METHOD_SYS_GETRANDOM" \
  --body "$(cat <<'EOF'
Closes #95. Part of the missing-POSIX-surface sweep (#83), parity tracker #52.

Design: docs/superpowers/specs/2026-05-17-devfs-entropy-design.md
Plan: docs/superpowers/plans/2026-05-17-devfs-entropy.md

## What
- `kh_random(out_ptr,len)` host import (mirrors `kh_now_realtime`) + native `/dev/urandom` test stub + single safe `fill_random` wrapper.
- `DevBackend` serves `/dev/urandom` + `/dev/random` (== urandom, modern Linux; matches the TS `dev-provider.ts` so the B0 differ is zero-diff).
- `METHOD_SYS_GETRANDOM` `0x1_00A0` (append-only); C1-safe (#65) with a width-aware regression test.
- Host impls: runtime-wasmtime via the `getrandom` crate (already in the rustls/fetch dep tree, ungated); kernel-host-interface-js via Web Crypto (browser-safe — never `/dev/random`).
- `getentropy()` is a guest-libc wrapper over this method, not a 2nd ABI id.

## Security
No kernel-held RNG state — every draw is a fresh host call, so snapshot/restore & export/import_state cannot replay entropy (structural, not added code).

## Verification
- `cargo test -p yurt-kernel-wasm --lib` green (+ DevBackend entropy, getrandom dispatch incl. width-aware C1 test)
- `cargo fmt --check`, `cargo clippy -D warnings` clean
- `cargo build -p yurt-runtime-wasmtime` clean
- B0 `/dev/urandom` fixture is a follow-up slow-tier item (TS parity already exists)

Prepared CI-green for human review — not self-merged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Report** the PR URL and CI status to the user. Do not merge.

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — `kh_random`+stub+wrapper → T1; `DevBackend` nodes → T2; `METHOD_SYS_GETRANDOM`/ABI/C1 → T3; runtime-wasmtime host → T4; JS Web Crypto host → T5; parity matrix → T6; tests/fmt/clippy/PR → T7. Security property is structural (no state) — asserted by the snapshot reasoning, no task needed; the non-replay *fixture* is explicitly deferred to the B0 slow-tier in T7 (TS parity exists), consistent with #52's gate model.

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has an expected result. Two "if not in scope, add to the existing errno `use`" notes (T4 `EIO`, T5 `EIO`) are conditional house-keeping, not placeholders — the symbol and its source module are named.

**Type consistency:** `kh_random(*mut u8, usize) -> i32` consistent across kh.rs decl/stub and both hosts (`u32,u32 -> i32` at the wasm boundary, which is how `usize`/ptr lower on wasm32 — matches `kh_now_realtime`'s `u32 -> i32`). `fill_random(&mut [u8]) -> Result<(),i32>` used identically in T2/T3. `sys_getrandom(&[u8], &mut [u8]) -> i64` matches the `dispatch_with_context` arm and the `pread_fd` shape. `METHOD_SYS_GETRANDOM` generated from `[method.sys_getrandom]` by `build.rs` (`METHOD_<UPPER(name)>`), used in T3 tests/arm.
