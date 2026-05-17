# Design — `recvmsg` SCM_RIGHTS `MSG_CTRUNC` parity

**Date:** 2026-05-17 · **Branch:** `feat/scm-rights-ctrunc` · **Base:** `fix/scm-rights-rlimit-truncate` (#145) · **Stack:** #76 ← #135 ← #145 ← this

## Problem

When the kernel drops received SCM_RIGHTS fds (receiver at `RLIMIT_NOFILE`, or
the sender sent more fds than the kernel/guest buffer holds), the guest's
`recvmsg` returns the surviving data and fds but **never sets `MSG_CTRUNC`**.
After #145 the kernel reports the *honest delivered* fd count, so the loss is
no longer dangerous (no phantom fd) but is now **silent**: a guest cannot
distinguish "sender sent 0 fds" from "fds were dropped." Linux sets
`MSG_CTRUNC` in `msg_flags` whenever ancillary data was truncated; we do not.

This also subsumes the pre-existing **#133 / M2** doesn't-fit phantom-count
concern: the kernel ancillary header currently overloads one `count` field
(sometimes "sent", sometimes "installed"). This design replaces it with one
coherent contract and a lost-information bit, reconciling #133/M2.

## Goals

- Full Linux `MSG_CTRUNC` parity for `recvmsg`/SCM_RIGHTS: any ancillary fd
  truncation (RLIMIT refusal, kernel `fit` cap, guest control buffer too
  small, no control buffer) sets `msg->msg_flags |= MSG_CTRUNC`.
- One coherent kernel→host ancillary contract; eliminate the #133/M2
  phantom-count overload.
- No `host_socket_recvmsg` import-signature change (minimize parity churn
  across the C decl, Rust/Deno/JS host shims, TS kernel, contract toml,
  conformance harness).

## Non-goals

- No change to data-path semantics, errno mapping, or the `recvmsg` request
  encoding.
- No new ancillary types (SCM_CREDENTIALS etc.) — SCM_RIGHTS only.
- `msg_controllen` accounting beyond what the existing C shim already does.

## Contract change (kernel ↔ host, binary, no JSON)

The recvmsg response is `response[0..data_cap]` = data, then an **ancillary
trailer** at `response[data_cap..]`.

- **Before:** `[count:u32][fd0:u32][fd1:u32]…` — `count` ambiguous
  (`rights.len()` on doesn't-fit, `installed` after #145's RLIMIT path).
- **After:** `[delivered_fd_count:u32][ancillary_flags:u32][fd0:u32]…`
  - `delivered_fd_count` — number of fd words actually installed **and**
    serialized into the trailer. Always exact and safe (the #145 contiguous
    prefix). This is what hosts copy to the guest.
  - `ancillary_flags` — bitfield. `SCM_TRUNCATED = 0x1` set iff the sender's
    original `rights.len()` exceeded `delivered_fd_count` (fds were lost for
    *any* reason). All other bits reserved, written `0`, ignored on read.

Trailer is now **8 bytes** + `delivered_fd_count*4`.

### Hard invariant (fd-capacity)

Hosts MUST size the kernel response so the ancillary region holds exactly
`fds_cap` fd slots: `response_len = data_cap + 8 + fds_cap*4`. The kernel's
install ceiling is `fit = (ancillary_len - 8) / 4`, so `fit == fds_cap` by
construction and therefore **`delivered_fd_count <= fds_cap` always holds**.

This is a correctness invariant, not a best-effort bound: if a host let the
kernel install more fds than it can return to the guest, those extra fds
would be live in the receiving process's fd table but unknown to the guest —
orphaned, unclosable, leaking kernel objects. The host-side
`delivered_fd_count > fds_cap` branch (below) is **fail-safe defensive
decoding only** and is unreachable in a correctly-sized host.

## Components & data flow

### 1. Kernel — `install_fd_rights_truncated` + `sys_socket_recvmsg` (`packages/kernel-wasm/src/dispatch/socket.rs`)

- `out.len() < 8` → `-EINVAL` (was `< 4`); drop all rights first (unchanged).
- `fit = (out.len() - 8) / 4`; fd words at `out[8 + index*4 ..]`.
- Reuse #145's `installed` contiguous-prefix logic unchanged.
- `delivered = installed`; `truncated = (rights_len > delivered)` where
  `rights_len` is the sender's original count (`rights.len()` before the
  install loop consumes it).
- Write header: `out[0..4] = delivered`, `out[4..8] = if truncated { SCM_TRUNCATED } else { 0 }`.
- Return ancillary byte length `8 + delivered*4` (was `4 + …`).
- `sys_socket_recvmsg` `MSG_PEEK` early-return writes the **full zero
  header**: `delivered=0, flags=0` (8 bytes), no fds.
- `#133/M2 reconciliation:` the doesn't-fit path no longer writes
  `rights.len()`; it writes `delivered` + `SCM_TRUNCATED`. The
  sent-vs-delivered count is now expressed as the flag, not a phantom count.

### 2a. Trailer-reading host interfaces (3) — read the new kernel.wasm trailer

`packages/runtime-wasmtime/src/kernel_host_interface.rs` (Rust Wasmtime),
`packages/kernel-host-interface-deno/wasm-kernel-imports.ts` (Deno),
`packages/kernel-host-interface-js/sys_shim.ts` (JS). Each:

- Response sizing constant `+4 → +8`.
- Read `delivered = trailer[0..4]`, `flags = trailer[4..8]`.
- `copy_fds = min(delivered, fds_cap)` (min is defensive per the invariant).
- `truncated = (flags & SCM_TRUNCATED) != 0 || delivered > fds_cap`.
- Copy `copy_fds` fd words to the guest `fds_ptr`.
- Write `n_fds_ptr = copy_fds | (truncated ? YURT_RECVMSG_CTRUNC_BIT : 0)`.
- Return `rc` (data byte count) unchanged.

### 2b. Legacy TS-kernel host import (1, architecturally distinct)

`packages/kernel/src/host-imports/kernel-imports.ts` `host_socket_recvmsg`
is the **legacy TS kernel's own** recvmsg — it does **not** call kernel.wasm
`sys_socket_recvmsg` or read the binary trailer; it `recvAsync`s and dups
fds from the sender directly. It already computes its own truncation
(`anc.fds.slice(0, fdsCap)`, then closes the excess sender dups) but writes
only the raw `nFds`. Without this it silently drops `MSG_CTRUNC` on the
direct TS-kernel / Sandbox path. Change: when it dropped sender fds
(`anc.fds.length > toReceive.length`, **or** `fdsPtr == 0 && anc.fds.length
> 0`), OR `YURT_RECVMSG_CTRUNC_BIT` into the value written at `nFdsPtr`.
This is the only edit here — the trailer contract (§1) does not apply to
this path. (`packages/kernel/src/process/loader.ts` only wires the import
name; no logic change.)

### 3. Constants

- Kernel trailer: `SCM_TRUNCATED: u32 = 0x1` (ancillary_flags bit0).
- Host→C packing: `YURT_RECVMSG_CTRUNC_BIT = 0x4000_0000` (bit30).
  - **Invariant documented at the constant:** the low bits are the fd count,
    `count <= 64` (the shim/`fds_cap` hard cap), bit30 signals control
    truncation. Bit31 is deliberately avoided: the guest reads `n_fds` into a
    signed C `int` gated by `if (n_fds > 0)`; bit31 would make it negative.

### 4. Guest C shim — `recvmsg` (`abi/src/yurt_socket.c`)

- After `yurt_host_socket_recvmsg`:
  `int ctrunc = n_fds & YURT_RECVMSG_CTRUNC_BIT; n_fds &= ~YURT_RECVMSG_CTRUNC_BIT;`
- Existing data-scatter and SCM_RIGHTS cmsg-writing logic unchanged (operates
  on the now-masked `n_fds`).
- After the existing `msg->msg_flags` computation:
  `if (ctrunc) msg->msg_flags |= MSG_CTRUNC;`
- The existing shim `MSG_CTRUNC` paths (delivered doesn't fit user
  `msg_controllen`; fds arrived with no control buffer) are **retained but
  become defensive**: under the fd-capacity invariant the kernel
  `SCM_TRUNCATED` bit is the primary, sufficient signal (e.g. no-control-
  buffer now yields `delivered=0` + the bit, so the old `n_fds > 0` path no
  longer fires). The paths are additive, never contradictory — `MSG_CTRUNC`
  is set if *any* of them trips.

## Edge cases

| Case | delivered | flags | guest n_fds | msg_flags |
|---|---|---|---|---|
| No truncation | N (=sent) | 0 | N | (unchanged) |
| RLIMIT dropped all | 0 | SCM_TRUNCATED | 0 \| bit30 | MSG_CTRUNC |
| RLIMIT dropped some | k | SCM_TRUNCATED | k \| bit30 | MSG_CTRUNC |
| Sender sent > `fit` (= guest `fds_cap`; doesn't-fit, #133/M2) | fit | SCM_TRUNCATED | fit \| bit30 | MSG_CTRUNC |
| No control buffer, sender sent ≥1 (`fds_cap=0` → `fit=0`) | 0 | SCM_TRUNCATED | 0 \| bit30 | MSG_CTRUNC |
| MSG_PEEK | 0 | 0 | 0 | (unchanged) |

Note: "guest control buffer too small for the sender's fds" is **not** a
separate row — because the guest derives `max_fds` (→ `fds_cap`) from
`msg_controllen`, that case *is* the "sender sent > `fit`" row (`fit ==
fds_cap`). The host-side `delivered > fds_cap` branch and the C shim's
existing `CMSG_SPACE(n_fds) > orig_controllen` branch are both defensive,
**unreachable under the fd-capacity invariant**, and retained only to fail
safe (set `MSG_CTRUNC`, never UB) rather than as normal-operation paths.

## Parity & conformance

- `abi/contract/*.toml` — update any documented recvmsg ancillary layout /
  field names (`fd_count` → `delivered_fd_count` + `ancillary_flags`).
- Deno parity (`wasm-kernel-imports_test.ts`) must stay green.
- `abi/conformance/c/unix-canary.c` — **the existing cases do not currently
  assert `mhdr.msg_flags & MSG_CTRUNC`** (`scm_rights_truncation` only checks
  one fd works; `recvmsg_ctrunc_tiny_ctrl` accepts *either* `MSG_CTRUNC`
  *or* `msg_controllen == 0`). Relying on them as-is would let the headline
  parity regress while conformance stays green. **Required, in scope:**
  tighten these (weak-assertion enshrined-bug update, #135 precedent) —
  `scm_rights_truncation` must send more fds than `fds_cap` and assert
  `MSG_CTRUNC` is set with the surviving fd usable; add/strengthen a case
  asserting `MSG_CTRUNC` for the RLIMIT-drop path. `recvmsg_ctrunc_tiny_ctrl`
  keeps its dual-accept only for the genuine tiny-ctrl POSIX case, and gains
  an explicit `MSG_CTRUNC`-required assertion for the fd-loss case.

## Testing (TDD, red → green)

Kernel unit (`packages/kernel-wasm/src/dispatch/tests.rs`):

- New: RLIMIT-drop → trailer `delivered==0`, `flags==SCM_TRUNCATED`.
- New: doesn't-fit (sender > fit) → `delivered==fit`, `flags==SCM_TRUNCATED`.
- New: clean transfer → `flags==0`, `delivered==sent`.
- New: MSG_PEEK → 8-byte zero header.
- **Enshrined-bug-test updates** (explicit, per the #135 EROFS precedent):
  - `socket_recvmsg_with_tiny_rights_buffer_returns_data_and_truncates_rights`
    (#133/M2): now asserts `delivered==0` + `SCM_TRUNCATED` instead of the
    phantom `count==1`.
  - `recvmsg_scm_rights_at_rlimit_does_not_deliver_phantom_fd` (#145): header
    offsets shift 4→8; assert the flag.
  - `socket_sendmsg_recvmsg_transfers_fd_rights`: header offset shift, flags==0.

Host-shim level (required — one stale `+4` or raw-count write must be
caught *directly* at the shim, not only via end-to-end conformance):

- Rust Wasmtime (`kernel_host_interface.rs`): unit/integration test that the
  request response buffer is sized `data_cap + 8 + fds_cap*4` and that a
  trailer with `SCM_TRUNCATED` (and a `delivered > fds_cap` synthetic) packs
  `YURT_RECVMSG_CTRUNC_BIT` into `n_fds_ptr`, with `copy_fds` correct.
- Deno (`wasm-kernel-imports.ts`) and JS (`sys_shim.ts`): equivalent tests
  for the `+8` sizing and the bit-pack/`min` decode (these run in the Deno
  fast tier; JS path covered by its harness).
- Legacy TS kernel (`kernel-imports.ts`): test that dropping sender fds
  (`anc.fds.length > fdsCap`, and the `fdsPtr == 0` case) sets the bit at
  `nFdsPtr`.

Guest-visible: the tightened `unix-canary.c` cases (see Parity &
conformance) assert `MSG_CTRUNC` end-to-end via the guest-compat job; Deno
parity (`wasm-kernel-imports_test.ts`) green.

## Risks

Broadest blast radius of the series: kernel↔host binary contract + 3
trailer-reading host shims + the independent legacy TS-kernel import +
guest C + parity/conformance. Mitigations: reserved-bit (no import
signature change); the conformance suite already encodes the target
`MSG_CTRUNC` semantics; strict TDD; the fd-capacity invariant prevents the
only correctness-critical failure mode (orphaned installed fds).

## Out of scope / follow-ups

- SCM_CREDENTIALS / other ancillary types.
- `MSG_TRUNC` (data truncation) — separate flag, not addressed here.
