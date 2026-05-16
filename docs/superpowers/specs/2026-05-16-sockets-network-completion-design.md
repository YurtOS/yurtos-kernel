# Sockets / Network Completion (slice B3) — Design

Sub-goal PR of the full-parity initiative (tracking #52, umbrella #57). Own PR
off `main` (B0=#53, B1=#54, B2=#55, this=B3). Same discipline: kernel-side gaps
land as TDD sub-slices, each `cargo test`/fmt/clippy verified, additive (zero
regression); guest/adapter halves + matrix `done` flips are measured against
B0's gate (approach C). Method-id block: **`0x1_0080–0x1_008F`** (per the
canonical partition).

## Grounded gap analysis (verified on `origin/main`)

- **`shutdown(fd, how)` — absent.** No `METHOD_SYS_*`, no dispatch arm (early
  exploration flagged "TS still owns"). `SocketEntry` has no half-close state.
  Clean additive: add `shutdown_flags: u8` (SHUT_RD=bit0 / SHUT_WR=bit1), set by
  `shutdown`, enforced in recv/send only when set — so workloads that never
  `shutdown` are unaffected (no regression by construction).
- **`SO_*` socket options beyond `TCP_NODELAY`** — advisory only;
  `SO_REUSEADDR`/`SO_KEEPALIVE`/`SO_LINGER`/`SO_PEERCRED` not modelled.
- **AF_UNIX `SO_PEERCRED`** — `socket_info` returns placeholder creds.
- **Non-blocking I/O + async poll bridge** — TCP `POLLIN` returns 0; recv may
  block TS-side. Cross-boundary (AsyncBridge) → gate-sequenced.
- **AF_INET6** (maximal) — zero support; sockaddr_in6 + routing.

## Scope corrections (parity-verified — explicit supersession)

These supersede earlier bullets in this spec/plan; recorded explicitly rather
than changed silently (initiative discipline). Driven by reading the TS kernel
this slice must stay parity-identical to.

- **B3.1 data model: `Kernel::socket_shutdown: BTreeMap<u64,u8>`, not
  `SocketKind`/`SocketEntry.shutdown_flags`.** A side map keyed by socket id is
  reclaimed at true socket destruction (`socket_dec_ref` `refs==0`, so dup'd fds
  don't prematurely drop it) and on `reset_for_tests`. Functionally equivalent
  to the planned per-entry field, avoids touching ~15 `SocketEntry` construction
  sites, and the half-close semantics are unchanged. **Landed (`0ea6f9f`).**
- **B3.2: `SO_*` advisory get/set round-trip is DROPPED — it would break the
  B0 parity gate.** TS `host_socket_option` (kernel-imports.ts:4022) does *not*
  store advisory option values: set is a silent no-op (`return 0`), get returns
  `-95` (EOPNOTSUPP). The current Rust `sys_socket_option` already matches this
  exactly. Persisting them on `SocketEntry` (as the original bullet proposed)
  would make Rust diverge from TS — a gate regression, not a parity gain. The
  parity hard-rule (mirror TS / B0 zero-diff) overrides the plan wording here.
  **B3.2's real deliverable is SO_PEERCRED**, a genuine gap: `host_socket_peercred`
  exists in the TS kernel (kernel-imports.ts:3388) but is absent from both
  `yurt_abi.toml` and kernel.wasm.
- **B3.2 known simplification (tracked, not silent):** kernel.wasm's
  `UnixListener` does not track the listener-owning pid, so a connected pair gets
  the *connecting* process's creds on both ends. This makes the server fd's
  `SO_PEERCRED` correct (the security-relevant direction — servers authenticate
  clients) but the client fd reports the connector rather than the server
  process. Closing the asymmetry needs listener-owner-pid plumbing; tracked as a
  B3 follow-up + matrix/baseline row, not a silent gap.

## Sub-slices (each: TDD red→green → commit on the B3 PR)

1. **B3.1 shutdown** — `SocketEntry.shutdown_flags`;
   `METHOD_SYS_SOCKET_SHUTDOWN`; SHUT_RD ⇒ subsequent AF_UNIX recv returns 0
   (EOF), SHUT_WR ⇒ send → `-EPIPE`; `-ENOTSOCK` non-socket fd, `-EINVAL` bad
   `how`. Additive (only active once `shutdown` is called).
2. **B3.2 SO_PEERCRED** — capture peer pid/uid/gid on `SocketKind::UnixStream`
   at socketpair / AF_UNIX connect (connector's pid + euid/egid); new
   `METHOD_SYS_SOCKET_PEERCRED` (`0x1_0081`): request u32 fd, response 12 bytes
   (pid/uid/gid i32 LE), `0` on any socket fd (zeros for non-unix, mirroring TS
   `?? 0`), `-ENOTSOCK`/`-EBADF` guards. ABI declarations
   (`host_socket_peercred` / `sys_socket_peercred`) added here; host-adapter
   pointer marshalling is cross-boundary → gate-sequenced with B3.3. Advisory
   `SO_*` round-trip dropped (see Scope corrections — parity).
3. **B3.3 non-blocking + async poll bridge** — cross-boundary; defined contract;
   gate-sequenced.
4. **B3.4 AF_INET6** — sockaddr_in6 parse + registry; larger. Split:
   - **B3.4a (done, cargo-unit-testable):** kernel-side `socket(AF_INET6)`
     acceptance + `sockaddr_in6` (28-byte, family 10) recognition. Closes a
     real parity gap — TS `host_socket_open` never validated the domain, so
     `socket(AF_INET6,…)` succeeds there while the Rust kernel returned
     EAFNOSUPPORT. AF_INET6 now allocates an Open socket like AF_INET;
     connect/bind forward the v6 sockaddr to the host seam
     (`kh::socket_connect`, unchanged). `inet_sockaddr_ok(domain,addr)`
     keeps family↔domain matched so the v4 path is unchanged (additive).
   - **B3.4b (cross-boundary, gate-sequenced):** actual IPv6 routing in the
     host adapter / loopback registry; measured against B0.
5. **DNS resolve remains out of this slice** — no `METHOD_SYS_DNS_RESOLVE` and
   no `kh_dns_resolve` kernel-host import. POSIX resolver behavior needs a
   separate design if it becomes a requirement.

B3.1–B3.2 are cargo-unit-testable kernel state. B3.3–B3.4 are
cross-boundary/larger → measured against B0.

## Scope notes / tracked seams (PR #58 review)

- **`shutdown` is enforced kernel-side for every socket kind, but the
  FIN is not forwarded to the host adapter.** The `socket_shutdown_bits`
  checks sit at the *top* of `socket_send_id` / `socket_recv_id` /
  `sendto` / `recvfrom`, **before** the `SocketKind::Host` arm — so a
  shut-down Host (TCP) socket *does* observe `SHUT_WR` → `-EPIPE` and
  `SHUT_RD` → EOF locally (it is **not** a no-op). What is *not* done is
  propagating the half-close to the underlying host socket: `kh::socket_*`
  is never asked to `shutdown()` the real fd, so the remote TCP peer is
  not sent a FIN. That host-FIN propagation is the tracked seam — it
  belongs with the cross-boundary B3.3 host-I/O work and is measured
  against the TS kernel via the B0 differ (not asserted verified here).
- **Pre-connect `shutdown()` cannot poison a later host connection.**
  Bits recorded on an unconnected `Open` socket are cleared when it is
  converted to `Host` by `connect`/`listen` (`socket_shutdown_clear`),
  so a stale `SHUT_*` never reaches the live host socket. A `SHUT_RD`
  EOF on an AF_UNIX stream also does not transfer or drain queued
  `SCM_RIGHTS` (recvmsg returns EOF without popping the ancillary
  queue). Both are locked by review-P2 regression tests.
- **Intentional POSIX-vs-TS divergence — B0-gate status (PR #58 review
  #1).** `shutdown(SHUT_WR)` now gives the AF_UNIX peer EOF after drain
  (POSIX-correct); the legacy TS kernel does not. Verified: the only
  shutdown conformance canary (`std-net-shutdown-canary`) is TCP-local
  (`connect(:9).shutdown(Both)`, no peer read) and there is **no
  `.spec.toml` case exercising the AF_UNIX peer-EOF path**, so the B0
  differ does **not** observe this divergence — the gate is *not*
  red-risked by this slice today, and `parity-baseline.toml` correctly
  has no row (its schema forbids phantom rows: an allowlisted pair that
  starts matching also fails). **Action for whoever adds an AF_UNIX
  shutdown-peer-EOF conformance case** (B5 hardening or a later slice):
  it WILL diverge TS-vs-Rust; that `(canary, case)` must ship with a
  `parity-baseline.toml [[divergence]]` row in the same PR
  (`slice = B6`, reason = "Rust is POSIX-correct; TS half-close is
  buggy — retired with the TS kernel"). Recvfrom is now consistent with
  recv for this (review-P2, regression-tested).

## Non-goals (B3)

- TCP backend rewrite (loopback registry stays the adapter).
- Honoring O_NONBLOCK in the blocking I/O path (that is the AsyncBridge / B3.3 /
  gate-sequenced concern).

## Testing

Per sub-slice: kernel `#[cfg(test)]` red→green via the `dispatch()` harness;
conformance canary added so the B0 differ locks TS-vs-Rust; matrix `Verified@`
on gate-green. Additive only.

## Dependency / sequencing

Rebases onto `main` after B0 (#53) is CI-green. Kernel-side sub-slices proceed
now validated by Rust unit tests (per execute-the-plan direction); never
self-merged — prepared for human review.
