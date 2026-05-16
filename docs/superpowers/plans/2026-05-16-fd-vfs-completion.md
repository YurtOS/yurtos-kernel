# FD/VFS Completion (slice B2) — Plan

Spec: `docs/superpowers/specs/2026-05-16-fd-vfs-completion-design.md` Branch:
`parity-b2-fd-vfs` (own PR off `main`). Tracking: #52 (B2).

TDD, AGENTS.md loop. B2.1–B2.3 cargo-unit-testable without the wasm build;
B2.4–B2.7 larger / gate-sequenced.

## Tasks

- **B2.1 pread/pwrite**: `METHOD_SYS_PREAD`/`METHOD_SYS_PWRITE`; request = u32
  fd + u64 offset (+ payload for pwrite); File-fd only, no cursor advance;
  ESPIPE non-seekable, EBADF unknown. Red `#[cfg(test)]` first.
- **B2.2 dup3**: `METHOD_SYS_DUP3`; (oldfd,newfd,flags); reuse cloexec; EINVAL
  oldfd==newfd / bad flags.
- **B2.3 fcntl flags**: extend the existing fcntl/fd-flags arm with
  F_GETFD/F_SETFD/F_GETFL/F_SETFL backed by OFD/fd-entry state.
- **B2.4 openat / B2.5 ioctl / B2.6 perms / B2.7 YURTFS CoW**: each its own spec
  note + TDD; B2.4+ may need FdEntry::Directory to carry the dir inode;
  gate-sequenced.

## Per sub-slice DoD

`cargo test -p yurt-kernel-wasm --lib` green (additive, no regression) +
`cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` clean;
conformance canary added; B0 differ zero-diff (or baselined) on gate CI-green;
matrix row → done with `Verified@`.

## Risks

- `openat` needs dir-fd path/inode storage on `FdEntry::Directory` — audit
  current Directory variant before B2.4; may split.
- `ioctl` surface is open-ended — scope strictly to what shipping userland
  (busybox/coreutils/cpython) actually issues.
