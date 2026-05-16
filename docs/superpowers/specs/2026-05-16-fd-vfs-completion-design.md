# FD/VFS Completion (slice B2) — Design

Sub-goal PR of the full-parity initiative (tracking #52, umbrella #51). Own PR
off `main` (B0=#53, B1=#54, this=B2). Same discipline as B1: kernel-side gaps
land as TDD sub-slices, each `cargo test`/fmt/clippy verified; the guest/adapter
halves + matrix `done` flips are measured against B0's gate (approach C).

## Grounded gap analysis (verified absent on `origin/main` @ 7bccd04)

`pread`/`pwrite`/`openat`/`dup3`/`ioctl` have **no** `METHOD_SYS_*`, no dispatch
arm. The OFD model is in place: `FdEntry::File { ofd_id }` →
`k.ofd(ofd_id) = {mount_id, inode, offset}`;
`k.vfs.read/write(mount_id,
inode, offset, buf)`; `read_fd`/`write_fd`/`lseek`
advance `ofd.offset`. This makes the positional + flag variants clean additive
deltas.

## Sub-slices (each: TDD red→green → commit on the B2 PR)

1. **B2.1 pread/pwrite** — positional I/O on `File` fds at a caller-supplied
   offset, **without** touching the OFD cursor; `-ESPIPE` for non-seekable fds
   (stdin/stdout/pipe/socket), `-EBADF` unknown fd. Mirrors `read_fd`/`write_fd`
   minus the `ofd.offset +=`.
2. **B2.2 dup3** — `dup2` semantics plus an explicit flags word (`O_CLOEXEC`);
   `-EINVAL` if `oldfd == newfd`, `-EINVAL` for unknown flags. Reuses the
   existing dup/cloexec machinery.
3. **B2.3 fcntl flag completeness** — `F_GETFD`/`F_SETFD` beyond `FD_CLOEXEC`,
   `F_GETFL`/`F_SETFL` status flags surfaced from the OFD.
4. **B2.4 openat** — open relative to a directory fd (`AT_FDCWD` → cwd). Landed
   (path-joined reuse of `sys_open`). **Open bug — issue #59:** dirfd must be
   inode-anchored, not path-snapshot (breaks across rename/unlink). The faithful
   fix is a VFS dir-handle API across every backend (VFS rewrite) — its own
   session, tracked in #59, not patched in B2.
5. **B2.5 ioctl subset** — the calls real userland hits (`FIONREAD`, `FIONBIO`,
   the tty `TIOC*` already partly modelled); unknown → `-ENOTTY`/`-EINVAL` per
   POSIX.
6. **B2.6 mkdir/rmdir/create permission checks**, **B2.7 YURTFS copy-on-write**
   — VFS-semantics, larger; gate-sequenced.

B2.1–B2.3 are pure kernel-state, cargo-unit-testable now (same class as
B1.1/B1.3). B2.4–B2.7 are larger/cross-cutting → measured against B0.
Maximal-scope S3 `VfsBackend` is a tracked later sub-slice.

## Non-goals (B2)

- Network/socket fds (B3), persistence (B4).
- Replacing the flat-ish VFS with the full pluggable backend set beyond what
  already exists (ramfs/tar/proc/dev/overlay) — S3 is later.

## Testing

Per sub-slice: kernel `#[cfg(test)]` red→green via the `dispatch()` harness; a
conformance canary added so the **B0 differ** locks TS-vs-Rust for the row;
matrix `Verified@` on gate-green. Additive only — no existing fd/vfs behavior
changed (regression-free by construction).

## Dependency / sequencing

B2 implementation rebases onto `main` after B0 (#53) is CI-green so each row is
parity-proven, not asserted. Kernel-side sub-slices proceed now validated by
Rust unit tests (per the user's execute-the-plan direction); the gate confirms
them.
