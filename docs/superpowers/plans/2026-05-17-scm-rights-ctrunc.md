# SCM_RIGHTS MSG_CTRUNC Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `recvmsg` set `MSG_CTRUNC` whenever received SCM_RIGHTS fds were dropped (RLIMIT, kernel `fit`, no/small control buffer), with one coherent kernel ancillary contract.

**Architecture:** Kernel ancillary trailer becomes `[delivered_fd_count:u32][ancillary_flags:u32][fd…]` (`SCM_TRUNCATED=0x1`). The 3 trailer-reading host shims (Rust/Deno/JS) size the response `+8`, decode it, and pack truncation into a reserved bit (`YURT_RECVMSG_CTRUNC_BIT=0x40000000`, bit30) of the existing `n_fds` out-value — no host-import signature change. The legacy TS-kernel import sets the same bit from its own truncation. The guest C shim masks the bit and ORs `MSG_CTRUNC`.

**Tech Stack:** Rust (`wasm32-wasip1` kernel + Wasmtime host), TypeScript/Deno, C (guest libc shim). Spec: `docs/superpowers/specs/2026-05-17-scm-rights-ctrunc-design.md`.

**Worktree:** `.worktrees/scm-rights-ctrunc`, branch `feat/scm-rights-ctrunc`, based on #145 (`fix/scm-rights-rlimit-truncate`). Run all commands from the worktree root.

---

## File Structure

- `packages/kernel-wasm/src/dispatch/socket.rs` — `SCM_TRUNCATED` const; `install_fd_rights_truncated` 8-byte trailer; `sys_socket_recvmsg` MSG_PEEK header.
- `packages/kernel-wasm/src/dispatch/tests.rs` — new trailer tests + 3 enshrined-test updates.
- `packages/runtime-wasmtime/src/kernel_host_interface.rs` — `+8` sizing, decode, bit-pack; `YURT_RECVMSG_CTRUNC_BIT` const + Rust unit test.
- `packages/kernel-host-interface-deno/wasm-kernel-imports.ts` — `+8`, decode, bit-pack.
- `packages/kernel-host-interface-js/sys_shim.ts` — `+8`, decode, bit-pack.
- `packages/kernel/src/host-imports/kernel-imports.ts` — legacy TS kernel: set bit on its own fd-drop.
- `abi/include/yurt_abi.h` — `YURT_RECVMSG_CTRUNC_BIT` C macro.
- `abi/src/yurt_socket.c` — mask bit, set `MSG_CTRUNC`.
- `abi/conformance/c/unix-canary.c` — tighten `scm_rights_truncation` / `recvmsg_ctrunc_tiny_ctrl` to assert `MSG_CTRUNC`.
- `abi/contract/yurt_abi_methods.toml:494` — document the new response layout.

---

## Task 1: Kernel ancillary trailer `[delivered][flags][fd…]`

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch/socket.rs` (`install_fd_rights_truncated` ~285-345; `sys_socket_recvmsg` MSG_PEEK early-return)
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`

- [ ] **Step 1: Write the failing test**

Append to `packages/kernel-wasm/src/dispatch/tests.rs` (after `recvmsg_scm_rights_at_rlimit_does_not_deliver_phantom_fd`):

```rust
/// Spec 2026-05-17-scm-rights-ctrunc: the ancillary trailer is
/// `[delivered:u32][flags:u32][fd…]`; SCM_TRUNCATED (0x1) is set when
/// the sender's rights count exceeded delivered (any cause).
#[test]
fn recvmsg_scm_rights_trailer_signals_truncation_at_rlimit() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut socket_fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut socket_fds),
        8
    );
    let left = u32::from_le_bytes(socket_fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(socket_fds[4..8].try_into().unwrap());
    let mut pipe_fds = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut pipe_fds), 8);
    let pipe_write = u32::from_le_bytes(pipe_fds[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SENDMSG, 1, &socket_sendmsg_req(left, b"x", &[pipe_write]), &mut []),
        1
    );
    crate::kernel::with_kernel(|k| {
        k.process_mut(1).rlimits[7] = Some((7, 1024));
    });
    // data_cap=1, then 8-byte header + room for one fd word.
    let mut recv = [0u8; 1 + 8 + 4];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &socket_recvmsg_req(right, 0, 1), &mut recv),
        1
    );
    assert_eq!(recv[0], b'x');
    let delivered = u32::from_le_bytes(recv[1..5].try_into().unwrap());
    let flags = u32::from_le_bytes(recv[5..9].try_into().unwrap());
    assert_eq!(delivered, 0, "RLIMIT dropped the only fd → delivered 0");
    assert_eq!(flags, 1, "SCM_TRUNCATED must be set");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p yurt-kernel-wasm --tests recvmsg_scm_rights_trailer_signals_truncation_at_rlimit 2>&1 | tail -5`
Expected: FAIL — with the current 4-byte header, `recv[5..9]` (old fd-word region) is not the flags field; `delivered`/`flags` assertions fail.

- [ ] **Step 3: Add the `SCM_TRUNCATED` constant**

In `packages/kernel-wasm/src/dispatch/socket.rs`, immediately above `fn install_fd_rights_truncated`:

```rust
/// `ancillary_flags` bit0 in the recvmsg ancillary trailer: the
/// sender's SCM_RIGHTS count exceeded `delivered_fd_count` (fds were
/// dropped — RLIMIT refusal or kernel `fit`). Canonical definition;
/// host shims hardcode `0x1` with a comment referencing this.
/// (spec 2026-05-17-scm-rights-ctrunc)
const SCM_TRUNCATED: u32 = 0x1;
```

- [ ] **Step 4: Rewrite `install_fd_rights_truncated` for the 8-byte trailer**

Replace the body of `install_fd_rights_truncated` (`packages/kernel-wasm/src/dispatch/socket.rs`). Keep #145's contiguous-prefix install logic; only the header geometry and the trailing write change:

```rust
fn install_fd_rights_truncated(
    k: &mut Kernel,
    caller_pid: u32,
    rights: Vec<FdEntry>,
    out: &mut [u8],
) -> i64 {
    // Trailer: [delivered_fd_count:u32][ancillary_flags:u32][fd…].
    if out.len() < 8 {
        for entry in rights {
            close_entry(k, entry);
        }
        return -(abi::EINVAL as i64);
    }
    let sent = rights.len() as u32;
    let fit = (out.len() - 8) / 4;
    let mut installed = 0u32;
    let mut rlimit_truncated = false;
    for (index, entry) in rights.into_iter().enumerate() {
        if rlimit_truncated || index >= fit {
            // Dropped: hit the fd limit, or no room in the caller
            // buffer. Both now reported via SCM_TRUNCATED below
            // (this reconciles the #133/M2 doesn't-fit phantom count).
            close_entry(k, entry);
            continue;
        }
        let p = k.process_mut(caller_pid);
        match p.fd_table.lowest_free_fd_within(p.nofile_soft_limit()) {
            Some(fd) => {
                k.process_mut(caller_pid).fd_table.install(fd, entry);
                let start = 8 + index * 4;
                out[start..start + 4].copy_from_slice(&fd.to_le_bytes());
                installed += 1;
            }
            None => {
                close_entry(k, entry);
                rlimit_truncated = true;
            }
        }
    }
    let flags = if sent > installed { SCM_TRUNCATED } else { 0 };
    out[0..4].copy_from_slice(&installed.to_le_bytes());
    out[4..8].copy_from_slice(&flags.to_le_bytes());
    (8 + installed as usize * 4) as i64
}
```

- [ ] **Step 5: Update the MSG_PEEK early-return to the 8-byte header**

In `packages/kernel-wasm/src/dispatch/socket.rs`, `sys_socket_recvmsg`, find the MSG_PEEK branch:

```rust
    if flags == MSG_PEEK {
        response[data_cap..data_cap + 4].copy_from_slice(&0u32.to_le_bytes());
        return n;
    }
```

Replace with (full zero header — delivered=0, flags=0):

```rust
    if flags == MSG_PEEK {
        response[data_cap..data_cap + 8].copy_from_slice(&[0u8; 8]);
        return n;
    }
```

- [ ] **Step 6: Update the 3 enshrined-layout kernel tests**

In `packages/kernel-wasm/src/dispatch/tests.rs`:

a) `recvmsg_scm_rights_at_rlimit_does_not_deliver_phantom_fd` — buffer and header offsets shift 4→8, assert the flag. Replace its `recv` buffer and the count assertion:

```rust
    // data_cap=1, then 8-byte header + one fd-word slot.
    let mut recv = [0u8; 1 + 8 + 4];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &socket_recvmsg_req(right, 0, 1), &mut recv),
        1,
        "data must still be delivered"
    );
    assert_eq!(recv[0], b'x', "the data byte must be delivered");
    assert_eq!(
        u32::from_le_bytes(recv[1..5].try_into().unwrap()),
        0,
        "delivered must be 0 (fd dropped at RLIMIT)"
    );
    assert_eq!(
        u32::from_le_bytes(recv[5..9].try_into().unwrap()),
        1,
        "SCM_TRUNCATED must be set"
    );
```

b) `socket_recvmsg_with_tiny_rights_buffer_returns_data_and_truncates_rights` (#133/M2) — it currently asserts the phantom `count==1` with a 4-byte buffer. Update: the ancillary buffer must now be ≥8 bytes (or the call returns `-EINVAL` for `out.len()<8`). Use `recv = [0u8; 1 + 8]` (data_cap=1, 8-byte header, zero fd slots → `fit=0`), and assert `delivered==0`, `flags==1`:

```rust
    let mut recv = [0u8; 1 + 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &socket_recvmsg_req(right, 0, 1), &mut recv),
        1
    );
    assert_eq!(recv[0], b'x');
    assert_eq!(u32::from_le_bytes(recv[1..5].try_into().unwrap()), 0);
    assert_eq!(
        u32::from_le_bytes(recv[5..9].try_into().unwrap()),
        1,
        "#133/M2 reconciled: doesn't-fit now reports delivered=0 + SCM_TRUNCATED, not a phantom count"
    );
```

(Keep the test's later second-recv `-EAGAIN` assertion as-is.)

c) `socket_sendmsg_recvmsg_transfers_fd_rights` — header offsets shift 4→8, expect no truncation. Update its `recv` and assertions:

```rust
    let mut recv = [0u8; 1 + 8 + 4];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &socket_recvmsg_req(right, 0, 1), &mut recv),
        1
    );
    assert_eq!(recv[0], b'x');
    assert_eq!(u32::from_le_bytes(recv[1..5].try_into().unwrap()), 1, "delivered == 1");
    assert_eq!(u32::from_le_bytes(recv[5..9].try_into().unwrap()), 0, "no truncation");
    let received_write = u32::from_le_bytes(recv[9..13].try_into().unwrap());
```

(The rest of that test — using `received_write` to write/read through the pipe — is unchanged.)

- [ ] **Step 7: Add the remaining new trailer tests**

Append to `packages/kernel-wasm/src/dispatch/tests.rs`:

```rust
/// Sender sends more fds than the receiver buffer holds (kernel `fit`
/// truncation): delivered == fit, SCM_TRUNCATED set. (#133/M2 path.)
#[test]
fn recvmsg_scm_rights_trailer_signals_truncation_doesnt_fit() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut sp = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut sp), 8);
    let left = u32::from_le_bytes(sp[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(sp[4..8].try_into().unwrap());
    let mut p1 = [0u8; 8];
    let mut p2 = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut p1), 8);
    assert_eq!(dispatch(METHOD_SYS_PIPE, 1, &[], &mut p2), 8);
    let w1 = u32::from_le_bytes(p1[4..8].try_into().unwrap());
    let w2 = u32::from_le_bytes(p2[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SENDMSG, 1, &socket_sendmsg_req(left, b"y", &[w1, w2]), &mut []),
        1
    );
    // Room for only ONE fd word (fit=1) though two were sent.
    let mut recv = [0u8; 1 + 8 + 4];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &socket_recvmsg_req(right, 0, 1), &mut recv),
        1
    );
    assert_eq!(u32::from_le_bytes(recv[1..5].try_into().unwrap()), 1, "delivered == fit (1)");
    assert_eq!(u32::from_le_bytes(recv[5..9].try_into().unwrap()), 1, "SCM_TRUNCATED set");
}

/// MSG_PEEK writes a full zeroed 8-byte header (delivered=0, flags=0).
#[test]
fn recvmsg_scm_rights_peek_writes_zero_header() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut sp = [0u8; 8];
    assert_eq!(dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut sp), 8);
    let left = u32::from_le_bytes(sp[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(sp[4..8].try_into().unwrap());
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SENDMSG, 1, &socket_sendmsg_req(left, b"z", &[]), &mut []),
        1
    );
    let mut recv = [0xFFu8; 1 + 8];
    // MSG_PEEK == 2 (matches the dispatch constant used elsewhere in this file).
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECVMSG, 1, &socket_recvmsg_req(right, MSG_PEEK, 1), &mut recv),
        1
    );
    assert_eq!(recv[1..9], [0u8; 8], "peek must zero the full 8-byte header");
}
```

(If `MSG_PEEK` is not already in scope in `tests.rs`, use the literal the file already uses for peek — grep `MSG_PEEK` in `dispatch/` for its value and inline it.)

- [ ] **Step 8: Run the kernel suite to verify green**

Run: `cargo test -p yurt-kernel-wasm --tests 2>&1 | tail -3`
Expected: `test result: ok. <N> passed; 0 failed` where `<N> == 399 (#145 baseline) + 3 new` (the 3 enshrined tests were modified, not added).

- [ ] **Step 9: fmt + clippy**

Run: `cargo fmt --all -- --check && cargo clippy -p yurt-kernel-wasm --all-targets -- -D warnings 2>&1 | tail -2`
Expected: no output from fmt; clippy `Finished` with no warnings.

- [ ] **Step 10: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/socket.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "feat(posix): recvmsg ancillary trailer [delivered][flags]; SCM_TRUNCATED (spec)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rust Wasmtime host shim — `+8` sizing, decode, bit-pack

**Files:**
- Modify: `packages/runtime-wasmtime/src/kernel_host_interface.rs` (`sys_socket_recvmsg` func_wrap ~5804-5875; add a module const)
- Test: `packages/runtime-wasmtime/src/kernel_host_interface.rs` (a `#[cfg(test)]` unit test for the decode/pack helper)

- [ ] **Step 1: Extract a pure helper + write the failing test**

Add near the top of `packages/runtime-wasmtime/src/kernel_host_interface.rs` (module scope):

```rust
/// Reserved bit in the `n_fds` out-value telling the guest C shim that
/// SCM_RIGHTS was truncated → it ORs `MSG_CTRUNC`. Bit30 (not bit31:
/// the shim reads `n_fds` into a signed `int` gated by `> 0`). The fd
/// count is hard-capped at 64, so bit30 is unambiguously free.
/// (spec 2026-05-17-scm-rights-ctrunc)
pub(crate) const YURT_RECVMSG_CTRUNC_BIT: u32 = 0x4000_0000;

/// Decode the recvmsg ancillary trailer `[delivered:u32][flags:u32]`
/// and compute `(copy_fds, n_fds_out)` for a guest `fds_cap`.
/// `flags & 0x1` == kernel SCM_TRUNCATED.
pub(crate) fn recvmsg_pack_nfds(delivered: u32, flags: u32, fds_cap: u32) -> (u32, u32) {
    let copy_fds = delivered.min(fds_cap);
    let truncated = (flags & 0x1) != 0 || delivered > fds_cap;
    (copy_fds, copy_fds | if truncated { YURT_RECVMSG_CTRUNC_BIT } else { 0 })
}
```

Add to the `#[cfg(test)] mod tests` in the same file (create the module if absent, at end of file):

```rust
#[cfg(test)]
mod ctrunc_tests {
    use super::recvmsg_pack_nfds;
    #[test]
    fn pack_nfds_signals_truncation() {
        assert_eq!(recvmsg_pack_nfds(0, 1, 4), (0, 0x4000_0000));
        assert_eq!(recvmsg_pack_nfds(2, 1, 4), (2, 2 | 0x4000_0000));
        assert_eq!(recvmsg_pack_nfds(3, 0, 4), (3, 3));
        // defensive: delivered > fds_cap (unreachable under the invariant)
        assert_eq!(recvmsg_pack_nfds(5, 0, 4), (4, 4 | 0x4000_0000));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p yurt-runtime-wasmtime recvmsg_pack_nfds 2>&1 | tail -5` (crate name: confirm via `grep '^name' packages/runtime-wasmtime/Cargo.toml`)
Expected: FAIL to compile — `recvmsg_pack_nfds` not found — then add the helper (Step 1 already wrote it; re-run shows PASS). If Step 1's helper is present, the test should PASS immediately; in that case the failing state is "test module/function absent" — write the test FIRST, run, see the unresolved-import failure, then add the helper.

> Execution note: do Step 1's *test* before Step 1's *helper* to honor red→green. Write the test, run (FAIL: `recvmsg_pack_nfds` unresolved), add the helper, re-run (PASS).

- [ ] **Step 3: Run test to verify it passes**

Run: `cargo test -p yurt-runtime-wasmtime recvmsg_pack_nfds 2>&1 | tail -3`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 4: Wire the helper into the `sys_socket_recvmsg` func_wrap**

In `packages/runtime-wasmtime/src/kernel_host_interface.rs`, `sys_socket_recvmsg`:

Change the response sizing — find:

```rust
            let response_len = match checked_guest_buffer_sum(&[out_cap, 4, fds_bytes]) {
```
to:
```rust
            let response_len = match checked_guest_buffer_sum(&[out_cap, 8, fds_bytes]) {
```

Replace the trailer-decode tail (the block starting `let rights = &response[out_cap_len..];` through the `n_fds_ptr` write) with:

```rust
            let rights = &response[out_cap_len..];
            let delivered = u32::from_le_bytes(rights[0..4].try_into().expect("delivered"));
            let flags = u32::from_le_bytes(rights[4..8].try_into().expect("anc flags"));
            let (copy_fds, n_fds_out) = recvmsg_pack_nfds(delivered, flags, fds_cap);
            if copy_fds > 0
                && memory
                    .write(
                        &mut caller,
                        fds_ptr as usize,
                        &rights[8..8 + copy_fds as usize * 4],
                    )
                    .is_err()
            {
                return -EFAULT;
            }
            if memory
                .write(&mut caller, n_fds_ptr as usize, &n_fds_out.to_le_bytes())
                .is_err()
            {
                return -EFAULT;
            }
            rc
```

- [ ] **Step 5: Build + test**

Run: `cargo build -p yurt-runtime-wasmtime 2>&1 | tail -2 && cargo test -p yurt-runtime-wasmtime recvmsg_pack_nfds 2>&1 | tail -3`
Expected: build `Finished`; test `ok. 1 passed`.

- [ ] **Step 6: fmt + clippy + commit**

Run: `cargo fmt --all -- --check && cargo clippy -p yurt-runtime-wasmtime --all-targets -- -D warnings 2>&1 | tail -2`
Expected: clean.

```bash
git add packages/runtime-wasmtime/src/kernel_host_interface.rs
git commit -m "feat(host): Rust Wasmtime recvmsg reads [delivered][flags], packs CTRUNC bit30

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Deno host shim — `+8` sizing, decode, bit-pack

**Files:**
- Modify: `packages/kernel-host-interface-deno/wasm-kernel-imports.ts` (`host_socket_recvmsg` custom, ~1379-1420)
- Test: `packages/kernel-host-interface-deno/__tests__/wasm-kernel-imports_ctrunc_test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/kernel-host-interface-deno/__tests__/wasm-kernel-imports_ctrunc_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import { recvmsgPackNfds } from "../wasm-kernel-imports.ts";

Deno.test("recvmsgPackNfds signals SCM_RIGHTS truncation via bit30", () => {
  assertEquals(recvmsgPackNfds(0, 1, 4), { copyFds: 0, nFds: 0x40000000 });
  assertEquals(recvmsgPackNfds(2, 1, 4), { copyFds: 2, nFds: 2 | 0x40000000 });
  assertEquals(recvmsgPackNfds(3, 0, 4), { copyFds: 3, nFds: 3 });
  assertEquals(recvmsgPackNfds(5, 0, 4), { copyFds: 4, nFds: 4 | 0x40000000 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check packages/kernel-host-interface-deno/__tests__/wasm-kernel-imports_ctrunc_test.ts 2>&1 | tail -5`
Expected: FAIL — `recvmsgPackNfds` is not exported.

- [ ] **Step 3: Add the exported helper + constant**

At module scope in `packages/kernel-host-interface-deno/wasm-kernel-imports.ts`:

```ts
/** Reserved bit telling the guest C shim SCM_RIGHTS was truncated
 * (→ MSG_CTRUNC). Bit30; fd count hard-capped at 64. Spec
 * 2026-05-17-scm-rights-ctrunc. */
export const YURT_RECVMSG_CTRUNC_BIT = 0x40000000;

export function recvmsgPackNfds(
  delivered: number,
  flags: number,
  fdsCap: number,
): { copyFds: number; nFds: number } {
  const copyFds = Math.min(delivered, fdsCap);
  const truncated = (flags & 0x1) !== 0 || delivered > fdsCap;
  return {
    copyFds,
    nFds: truncated ? (copyFds | YURT_RECVMSG_CTRUNC_BIT) >>> 0 : copyFds,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --no-check packages/kernel-host-interface-deno/__tests__/wasm-kernel-imports_ctrunc_test.ts 2>&1 | tail -3`
Expected: `ok | 1 passed`.

- [ ] **Step 5: Wire into `host_socket_recvmsg`**

In `wasm-kernel-imports.ts` `host_socket_recvmsg` custom body: change the response cap and the trailer decode. Find:

```ts
      const responseCap = (bufCap >>> 0) + 4 + (fdsCap >>> 0) * 4;
```
to:
```ts
      const responseCap = (bufCap >>> 0) + 8 + (fdsCap >>> 0) * 4;
```

Then locate the block after `const rightsStart = bufCap >>> 0;` that reads the count and copies fds (the `nFds`/`copyFds`/`nFdsPtr` writes). Replace it with:

```ts
      const rightsStart = bufCap >>> 0;
      const rv = new DataView(
        out.response.buffer,
        out.response.byteOffset + rightsStart,
        out.response.byteLength - rightsStart,
      );
      const delivered = rv.getUint32(0, true);
      const flags = rv.getUint32(4, true);
      const { copyFds, nFds } = recvmsgPackNfds(delivered, flags, fdsCap >>> 0);
      if (copyFds > 0) {
        const fr = copyOut(
          memBuf,
          fdsPtr,
          out.response.subarray(rightsStart + 8, rightsStart + 8 + copyFds * 4),
        );
        if (fr < 0) return fr;
      }
      const nr = copyOut(memBuf, nFdsPtr, new Uint8Array(new Uint32Array([nFds]).buffer));
      if (nr < 0) return nr;
      return rc;
```

(Match the existing `copyOut` signature/return-checks already used in this function; if the existing code uses a different `u32`-encoding helper for `nFdsPtr`, reuse that helper with `nFds` instead of the `Uint32Array` buffer.)

- [ ] **Step 6: Run the Deno fast tier**

Run: `deno test --no-check 'packages/kernel-host-interface-deno/**/*_test.ts' 2>&1 | tail -5`
Expected: all pass (new ctrunc test + existing).

- [ ] **Step 7: fmt + lint + commit**

Run: `deno fmt packages/kernel-host-interface-deno/ && deno lint packages/kernel-host-interface-deno/ 2>&1 | tail -2`
Expected: formatted; lint clean.

```bash
git add packages/kernel-host-interface-deno/wasm-kernel-imports.ts packages/kernel-host-interface-deno/__tests__/wasm-kernel-imports_ctrunc_test.ts
git commit -m "feat(host): Deno recvmsg reads [delivered][flags], packs CTRUNC bit30

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: JS host shim — `+8` sizing, decode, bit-pack

**Files:**
- Modify: `packages/kernel-host-interface-js/sys_shim.ts` (`sys_socket_recvmsg` ~503-533)
- Test: `packages/kernel-host-interface-js/__tests__/sys_shim_ctrunc_test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/kernel-host-interface-js/__tests__/sys_shim_ctrunc_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import { recvmsgPackNfds } from "../sys_shim.ts";

Deno.test("sys_shim recvmsgPackNfds packs CTRUNC bit30", () => {
  assertEquals(recvmsgPackNfds(0, 1, 4), { copyFds: 0, nFds: 0x40000000 });
  assertEquals(recvmsgPackNfds(2, 1, 4), { copyFds: 2, nFds: 2 | 0x40000000 });
  assertEquals(recvmsgPackNfds(3, 0, 4), { copyFds: 3, nFds: 3 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check packages/kernel-host-interface-js/__tests__/sys_shim_ctrunc_test.ts 2>&1 | tail -5`
Expected: FAIL — `recvmsgPackNfds` not exported from `sys_shim.ts`.

- [ ] **Step 3: Add the exported helper**

At module scope in `packages/kernel-host-interface-js/sys_shim.ts`:

```ts
/** Spec 2026-05-17-scm-rights-ctrunc: CTRUNC reserved bit (bit30). */
export const YURT_RECVMSG_CTRUNC_BIT = 0x40000000;

export function recvmsgPackNfds(
  delivered: number,
  flags: number,
  fdsCap: number,
): { copyFds: number; nFds: number } {
  const copyFds = Math.min(delivered, fdsCap);
  const truncated = (flags & 0x1) !== 0 || delivered > fdsCap;
  return {
    copyFds,
    nFds: truncated ? (copyFds | YURT_RECVMSG_CTRUNC_BIT) >>> 0 : copyFds,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --no-check packages/kernel-host-interface-js/__tests__/sys_shim_ctrunc_test.ts 2>&1 | tail -3`
Expected: `ok | 1 passed`.

- [ ] **Step 5: Wire into `sys_socket_recvmsg`**

In `packages/kernel-host-interface-js/sys_shim.ts` `sys_socket_recvmsg`, change:

```ts
        outCap + 4 + fdsCap * 4,
```
to:
```ts
        outCap + 8 + fdsCap * 4,
```

Replace the decode tail (from `const rights = response.subarray(outCap);` through `return rc;`) with:

```ts
      const rights = response.subarray(outCap);
      const rdv = new DataView(rights.buffer, rights.byteOffset, rights.byteLength);
      const delivered = rdv.getUint32(0, true);
      const flags = rdv.getUint32(4, true);
      const { copyFds, nFds } = recvmsgPackNfds(delivered, flags, fdsCap);
      const fdsRc = copyOut(fdsPtr, rights.subarray(8, 8 + copyFds * 4));
      if (fdsRc < 0) return fdsRc;
      const countRc = copyOut(nFdsPtr, u32(nFds));
      if (countRc < 0) return countRc;
      return rc;
```

(`u32(...)` is the existing LE-encoder already used in this function for `nFdsPtr`.)

- [ ] **Step 6: Fast tier + fmt/lint + commit**

Run: `deno test --no-check 'packages/kernel-host-interface-js/**/*_test.ts' 2>&1 | tail -4 && deno fmt packages/kernel-host-interface-js/ && deno lint packages/kernel-host-interface-js/ 2>&1 | tail -2`
Expected: tests pass; formatted; lint clean.

```bash
git add packages/kernel-host-interface-js/sys_shim.ts packages/kernel-host-interface-js/__tests__/sys_shim_ctrunc_test.ts
git commit -m "feat(host): JS recvmsg reads [delivered][flags], packs CTRUNC bit30

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Legacy TS-kernel import — set bit30 on its own fd-drop

**Files:**
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts` (`host_socket_recvmsg` ~3946-4010)
- Test: `packages/kernel/src/host-imports/__tests__/kernel_imports_recvmsg_ctrunc_test.ts` (new) — if a colocated `__tests__` dir convention differs here, place beside existing kernel-imports tests; grep `kernel-imports` under `packages/kernel` for the established test path.

- [ ] **Step 1: Write the failing test (pure helper)**

Add an exported helper to test in isolation. Create `packages/kernel/src/host-imports/__tests__/kernel_imports_recvmsg_ctrunc_test.ts`:

```ts
import { assertEquals } from "jsr:@std/assert";
import { tsKernelRecvmsgNfds } from "../kernel-imports.ts";

Deno.test("legacy TS kernel sets CTRUNC bit when sender fds dropped", () => {
  // (deliveredCount, senderTotal, fdsPtr) -> nFds out value
  assertEquals(tsKernelRecvmsgNfds(0, 0, 0), 0); // nothing sent
  assertEquals(tsKernelRecvmsgNfds(0, 1, 0), 0x40000000); // no ctrl buf, fds arrived
  assertEquals(tsKernelRecvmsgNfds(1, 3, 123), 1 | 0x40000000); // dropped 2
  assertEquals(tsKernelRecvmsgNfds(2, 2, 123), 2); // all delivered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --no-check packages/kernel/src/host-imports/__tests__/kernel_imports_recvmsg_ctrunc_test.ts 2>&1 | tail -5`
Expected: FAIL — `tsKernelRecvmsgNfds` not exported.

- [ ] **Step 3: Add the exported helper**

At module scope in `packages/kernel/src/host-imports/kernel-imports.ts`:

```ts
/** Spec 2026-05-17-scm-rights-ctrunc: pack the legacy TS-kernel
 * recvmsg `nFds` out-value. `senderTotal` = fds the sender sent;
 * `delivered` = fds installed for the guest. Sets bit30 (CTRUNC)
 * when any were dropped, incl. the no-control-buffer case
 * (`fdsPtr === 0` with fds present). */
export const YURT_RECVMSG_CTRUNC_BIT = 0x40000000;
export function tsKernelRecvmsgNfds(
  delivered: number,
  senderTotal: number,
  fdsPtr: number,
): number {
  const lostToNoBuffer = fdsPtr === 0 && senderTotal > 0;
  const truncated = delivered < senderTotal || lostToNoBuffer;
  return truncated ? (delivered | YURT_RECVMSG_CTRUNC_BIT) >>> 0 : delivered;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --no-check packages/kernel/src/host-imports/__tests__/kernel_imports_recvmsg_ctrunc_test.ts 2>&1 | tail -3`
Expected: `ok | 1 passed`.

- [ ] **Step 5: Use the helper at the `nFdsPtr` write**

In `host_socket_recvmsg` (`kernel-imports.ts`), the code currently dups `toReceive` fds (incrementing `nFds`) and closes `anc.fds.slice(toReceive.length)`. Capture the sender total and route the final count write through the helper. At the point where `nFds` is written to `nFdsPtr` (`view.setInt32(nFdsPtr, nFds, true)` or similar — grep `nFdsPtr` in this function), replace the written value with:

```ts
        const senderTotal = anc ? anc.fds.length : 0;
        view.setInt32(nFdsPtr, tsKernelRecvmsgNfds(nFds, senderTotal, fdsPtr) | 0, true);
```

(If no anc was present, `senderTotal = 0`, `nFds = 0` → writes `0`, unchanged behavior.)

- [ ] **Step 6: Type-check + fast tier + commit**

Run: `deno check 'packages/kernel/**/*.ts' 2>&1 | tail -3 && deno test --no-check 'packages/kernel/**/*_test.ts' 2>&1 | tail -4`
Expected: type-check clean; tests pass.

```bash
git add packages/kernel/src/host-imports/kernel-imports.ts packages/kernel/src/host-imports/__tests__/kernel_imports_recvmsg_ctrunc_test.ts
git commit -m "feat(kernel): legacy TS recvmsg sets MSG_CTRUNC bit on dropped SCM_RIGHTS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Guest C shim — mask bit, set `MSG_CTRUNC`

**Files:**
- Modify: `abi/include/yurt_abi.h` (add macro)
- Modify: `abi/src/yurt_socket.c` (`recvmsg`, ~994-1077)

- [ ] **Step 1: Add the C macro**

In `abi/include/yurt_abi.h`, add (near other yurt ABI macros):

```c
/* recvmsg: host sets this reserved bit in the n_fds out-value when
 * SCM_RIGHTS was truncated; the low bits are the fd count (<=64).
 * Bit30 (not bit31: n_fds is read into a signed int).
 * spec 2026-05-17-scm-rights-ctrunc */
#define YURT_RECVMSG_CTRUNC_BIT 0x40000000
```

- [ ] **Step 2: Mask the bit and set MSG_CTRUNC in `recvmsg`**

In `abi/src/yurt_socket.c`, `recvmsg`, immediately after the `yurt_host_socket_recvmsg(...)` call returns and before `if (rc < 0)`'s `n_fds` is used (i.e., right after the `rc` check, before `ssize_t nbytes = (ssize_t)rc;`), add:

```c
  int ctrunc_signal = (n_fds & YURT_RECVMSG_CTRUNC_BIT) ? 1 : 0;
  n_fds &= ~YURT_RECVMSG_CTRUNC_BIT;
```

Then, in the ancillary-writing block, after `msg->msg_flags = 0;` and the existing fit/no-buffer logic (i.e., just before `(void)flags; return nbytes;`), add:

```c
  if (ctrunc_signal) {
    msg->msg_flags |= MSG_CTRUNC;
  }
```

(The existing `else if (n_fds > 0)` no-control-buffer path still works; with the new contract `n_fds` is 0 there and `ctrunc_signal` carries it instead — both set `MSG_CTRUNC`, additively.)

- [ ] **Step 3: Build the wasm guest libc + canaries**

Run (canonical guest-canary build, from `guest-compat.yml`; requires the WASI SDK + yurt-toolchain already built — `cargo build --release -p yurt-toolchain` first if not):
`make -C abi all copy-fixtures 2>&1 | tail -10`
Expected: builds without error; `abi/src/yurt_socket.c` compiles with the new macro.

- [ ] **Step 4: Commit**

```bash
git add abi/include/yurt_abi.h abi/src/yurt_socket.c
git commit -m "feat(libc): recvmsg sets MSG_CTRUNC from host CTRUNC bit

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Conformance — assert `MSG_CTRUNC` (tighten weak cases)

**Files:**
- Modify: `abi/conformance/c/unix-canary.c` (`case_*` for `scm_rights_truncation` ~890-915 and `recvmsg_ctrunc_tiny_ctrl` ~1163-1215)

- [ ] **Step 1: Strengthen `scm_rights_truncation`**

In `abi/conformance/c/unix-canary.c`, the `scm_rights_truncation` case: it sends fds and `recvmsg`s with a control buffer too small for all of them. After the `recvmsg` succeeds, add an assertion that truncation was flagged:

```c
  if (!(mhdr.msg_flags & MSG_CTRUNC)) {
    emit("scm_rights_truncation", 1, "no-ctrunc", 0, 0);
    return 1;
  }
```

(Place it after the existing fd-usable check, before the success `emit`. Keep the existing checks.)

- [ ] **Step 2: Strengthen `recvmsg_ctrunc_tiny_ctrl`**

In `case_recvmsg_ctrunc_tiny_ctrl`, it currently accepts `MSG_CTRUNC` OR `msg_controllen == 0`. Keep that dual-accept ONLY for the genuine "control buffer < CMSG_LEN(0)" POSIX case it tests. Add a second sub-check (or a sibling case) that sends ≥1 fd into a buffer that can hold the cmsg header but not the fd, and require `MSG_CTRUNC` strictly:

```c
  /* fd-loss must strictly set MSG_CTRUNC (not merely controllen==0) */
  if (!(rmsg2.msg_flags & MSG_CTRUNC)) {
    emit("recvmsg_ctrunc_tiny_ctrl", 1, "fdloss-no-ctrunc", 0, 0);
    return 1;
  }
```

(Construct `rmsg2` mirroring the existing `rmsg` setup but with a control buffer sized `CMSG_SPACE(0)` and one fd sent. Reuse the existing socketpair/sendmsg scaffolding in the function; do not duplicate the whole case if a second `recvmsg` on the same pair suffices.)

- [ ] **Step 3: Build + run the unix-canary conformance**

Rebuild canaries then run the guest-compat suite that drives unix-canary
through the kernel (both from `guest-compat.yml`):

```bash
make -C abi all copy-fixtures 2>&1 | tail -5
deno test --no-check --allow-read --allow-env --allow-run \
  packages/kernel/src/__tests__/abi_test.ts 2>&1 | tail -20
```

Expected: `abi_test.ts` passes; `scm_rights_truncation` and
`recvmsg_ctrunc_tiny_ctrl` report PASS with the new assertions.

- [ ] **Step 4: Commit**

```bash
git add abi/conformance/c/unix-canary.c
git commit -m "test(conformance): unix-canary asserts MSG_CTRUNC on SCM_RIGHTS loss

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: ABI contract doc + full verification + PR

**Files:**
- Modify: `abi/contract/yurt_abi_methods.toml:494`

- [ ] **Step 1: Update the contract doc**

In `abi/contract/yurt_abi_methods.toml`, the `[method.sys_socket_recvmsg]` `doc` string — replace the response description:

old: `Response bytes: data_cap payload area followed by u32 fd_count LE + fd_count*u32 received fd numbers. Return value is payload byte count.`

new: `Response bytes: data_cap payload area followed by u32 delivered_fd_count LE + u32 ancillary_flags LE (bit0 SCM_TRUNCATED) + delivered_fd_count*u32 received fd numbers. Return value is payload byte count.`

- [ ] **Step 2: Full local gate (CI parity)**

Run, expecting each to pass:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings 2>&1 | tail -2
cargo test -p yurt-kernel-wasm --tests 2>&1 | tail -2
cargo test -p yurt-runtime-wasmtime 2>&1 | tail -2
cargo build -p yurt-kernel-wasm --target wasm32-wasip1 2>&1 | tail -2
deno fmt --check 2>&1 | tail -2
deno lint 2>&1 | tail -2
deno check 'packages/**/*.ts' 2>&1 | tail -2
deno test --no-check 'packages/**/*_test.ts' 2>&1 | tail -3
```

Expected: kernel-wasm `ok` (402: 399 + 3 new tests); runtime-wasmtime `ok`; wasm build `Finished`; deno fmt/lint/check clean; deno tests pass.

- [ ] **Step 3: Commit the contract doc**

```bash
git add abi/contract/yurt_abi_methods.toml
git commit -m "docs(abi): recvmsg response = [delivered][ancillary_flags][fds]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: File the tracking issue**

```bash
gh issue create --repo YurtOS/yurtos-kernel \
  --title "feat(posix): recvmsg SCM_RIGHTS MSG_CTRUNC parity (kernel trailer + 4 host surfaces + guest)" \
  --body "Spec: docs/superpowers/specs/2026-05-17-scm-rights-ctrunc-design.md. Completes the SCM_RIGHTS line after #135/#143/#145: a guest could not tell 'sender sent 0 fds' from 'fds dropped'. Adds [delivered][ancillary_flags] kernel trailer (SCM_TRUNCATED), reserved n_fds bit30 across the 3 trailer-reading host shims + the legacy TS-kernel import, guest C shim sets MSG_CTRUNC. Reconciles #133/M2 doesn't-fit phantom count. Part of #52 / #71 / #110.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Note the returned issue number as `<ISSUE>`.

- [ ] **Step 5: Push + open the PR (stacked on #145)**

```bash
git push -u origin feat/scm-rights-ctrunc
gh pr create --repo YurtOS/yurtos-kernel \
  --base fix/scm-rights-rlimit-truncate \
  --head feat/scm-rights-ctrunc \
  --title "feat(posix): recvmsg SCM_RIGHTS MSG_CTRUNC parity (#<ISSUE>)" \
  --body "$(cat <<'BODY'
Closes #<ISSUE>. Stacked on #145 (fix/scm-rights-rlimit-truncate). Merge order #76 → #135 → #145 → this; retarget to main as the stack lands.

Kernel ancillary trailer → [delivered_fd_count:u32][ancillary_flags:u32][fds] (SCM_TRUNCATED=0x1). The 3 trailer-reading host shims (Rust/Deno/JS) size +8, decode, and pack truncation into reserved n_fds bit30 (YURT_RECVMSG_CTRUNC_BIT=0x40000000 — no host-import signature change). The legacy TS-kernel import sets the same bit from its own drop. Guest C shim masks the bit and ORs MSG_CTRUNC. Reconciles the #133/M2 doesn't-fit phantom count. unix-canary scm_rights_truncation / recvmsg_ctrunc_tiny_ctrl tightened to assert MSG_CTRUNC. Spec: docs/superpowers/specs/2026-05-17-scm-rights-ctrunc-design.md.

Verification: cargo test -p yurt-kernel-wasm + -p yurt-runtime-wasmtime, wasm32-wasip1 build, deno fmt/lint/check/test, per-shim unit tests — all green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 6: Watch CI to terminal; fix red per systematic-debugging, else report green.**

---

## Self-Review

**1. Spec coverage:**
- Trailer `[delivered][flags]` + `SCM_TRUNCATED` → Task 1 ✓
- MSG_PEEK 8-byte zero header → Task 1 Step 5 + test Step 7 ✓
- fd-capacity invariant (`+8` sizing per shim) → Tasks 2/3/4 sizing edits + Task 1 `fit=(len-8)/4` ✓
- 3 trailer-reading shims → Tasks 2/3/4 ✓
- Legacy TS-kernel 4th surface → Task 5 ✓
- `YURT_RECVMSG_CTRUNC_BIT` bit30 + signed-int rationale → consts in Tasks 2/3/4/5/6 ✓
- Guest C shim MSG_CTRUNC → Task 6 ✓
- #133/M2 reconciliation + enshrined-test updates → Task 1 Step 6 ✓
- Conformance assertions tightened (finding 2) → Task 7 ✓
- Per-shim host-level tests (finding 3) → Tasks 2/3/4/5 unit tests ✓
- Contract toml → Task 8 ✓
- Defensive `delivered > fds_cap` → encoded in `recvmsg_pack_nfds`/`recvmsgPackNfds` (Tasks 2/3/4) ✓

**2. Placeholder scan:** None. Task 6/7 guest build/run now carry the literal `guest-compat.yml` commands (`make -C abi all copy-fixtures`; `deno test … abi_test.ts`). All code steps contain complete code; no TBD/TODO/"similar to". The Task 5 test-path note ("grep for the established test path") is a placement hint with a concrete default given, not a content gap.

**3. Type consistency:** Helper name `recvmsg_pack_nfds` (Rust) / `recvmsgPackNfds` (TS) / `tsKernelRecvmsgNfds` (legacy TS, different signature by design) and constant `YURT_RECVMSG_CTRUNC_BIT = 0x40000000` are consistent across Tasks 2–6. Trailer offsets (`[0..4]` delivered, `[4..8]` flags, fds at `+8`) consistent in Task 1 (writer) and Tasks 2/3/4 (readers).

---

## Execution Handoff

(Filled by the writing-plans handoff prompt.)
