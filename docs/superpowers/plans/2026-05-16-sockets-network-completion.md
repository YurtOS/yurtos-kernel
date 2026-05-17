# Sockets / Network Completion (slice B3) — Plan

Spec: `docs/superpowers/specs/2026-05-16-sockets-network-completion-design.md`
Branch: `parity-b3-sockets` (own PR off `main`). Tracking #52 / umbrella #57.
Method-id block: `0x1_0080–0x1_008F`.

TDD, AGENTS.md loop. B3.1–B3.2 cargo-unit-testable; B3.3–B3.5 cross-boundary /
gate-sequenced. Never self-merged.

## Tasks

- **B3.1 shutdown** (`0x1_0080`): add `SocketEntry.shutdown_flags: u8` (default
  0 at all construction sites — compiler-enforced via E0063);
  `METHOD_SYS_SOCKET_SHUTDOWN` sets SHUT_RD/SHUT_WR; AF_UNIX recv honors SHUT_RD
  (→0 EOF), send honors SHUT_WR (→ -EPIPE); -ENOTSOCK / -EINVAL guards. Red
  `#[cfg(test)]` first.
- **B3.2 SO_PEERCRED + SO** advisory_*: peer creds captured at unix_connect;
  `SocketEntry` gains an options map; getsockopt/ setsockopt round-trip.
- **B3.3 non-blocking/async poll**, **B3.4 AF_INET6**, **B3.5 DNS**: each its
  own spec note + TDD; cross-boundary; gate-sequenced.

## Per sub-slice DoD

`cargo test -p yurt-kernel-wasm --lib` green (additive, no regression) +
`cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` clean;
conformance canary added; B0 differ zero-diff (or baselined) on gate CI-green;
matrix row → done with `Verified@`. PR marked ready for human review when the
slice's deliverable is complete; never merged by me.

## Risks

- `SocketEntry` has ~15 construction sites; the field add is mechanical but wide
  — rely on `rustc` E0063 to catch every site.
- shutdown behavioral enforcement touches recv/send — scoped so it only changes
  behavior post-`shutdown` (no existing test calls it).
