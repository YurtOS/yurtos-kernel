# Issue #85 — `*at` family via a shared `resolve_at` helper (implementation plan)

> **For agentic workers:** execute slice-by-slice (each slice = its own worktree + PR, TDD, not merged by the agent). Steps use `- [ ]`.

**Goal:** Add the POSIX.1-2008 `*at` family (`unlinkat`, `renameat`/`renameat2`, `fstatat`, `mkdirat`, `fchmodat`, `fchownat`, `linkat`, `symlinkat`, `readlinkat`, `utimensat`/`futimens`, `mkfifoat`) — the actual musl/glibc hot path — on a single correct dirfd resolver.

**Architecture:** Extract the **inode-anchored** dirfd→absolute-path resolution that already lives inline in `sys_openat` into one shared `resolve_at(caller_pid, dirfd, path, at_flags) -> Result<Vec<u8>, i32>`. `sys_openat` becomes a thin caller of it (its body is moved, not rewritten → **zero behavior change**, guarded by the existing openat test suite). Every `*at` variant then resolves via `resolve_at` and delegates to the existing base operation (mirroring how `sys_openat` delegates to `sys_open`).

**Tech stack:** Rust, `yurt-kernel-wasm`, `cargo test -p yurt-kernel-wasm --lib`; ABI in `abi/contract/yurt_abi_methods.toml`.

## Key findings (investigation 2026-05-18)

1. `sys_openat` (`dispatch/fs.rs:244-470`) has the **correct** B2.9 inode-anchored resolution: AT_FDCWD/absolute fast-path → `sys_open`; else snapshot dirfd's dual capability; degraded (`dir_inode==None`) path-snapshot join; inode-anchored `dir_abspath_in` + component walk + `needs_path_resolver` re-delegation through the centralized 40-hop SYMLOOP (`PathResolver::realpath`). **Never duplicate this** — extract it.
2. `sys_faccessat` (`fs.rs:1640`, #86, CLOSED) took the **stale path-snapshot shortcut** (`FdEntry::Directory { path, .. }` join; comment: `#59 limitation`). It is **not rename-stable** — divergent from `sys_openat`. Filed as **#188**; **S0 retrofits it onto `resolve_at`**, fixing it (S0's red→green test pins #188).
3. There is **no** shared dirfd resolver today. #85's central deliverable is creating it.

## Shared helper (S0)

```rust
/// Resolve a `*at` (dirfd, path) pair to an absolute path, using the
/// SAME inode-anchored logic sys_openat uses (rename-stable). `path`
/// absolute or `dirfd==AT_FDCWD` ⇒ cwd-relative (returned as-is for
/// the caller's normalize). Errnos: -EBADF (unknown dirfd), -ENOTDIR
/// (dirfd not a directory), plus ENOENT if the anchored dir was
/// removed. `at_flags` carried for AT_EMPTY_PATH (operate on dirfd
/// itself). Returns the absolute byte path; callers feed it to the
/// existing base op exactly as sys_openat feeds sys_open.
fn resolve_at(caller_pid: u32, dirfd: u32, path: &[u8], at_flags: u32)
    -> Result<Vec<u8>, i32>;
```

S0 = pure refactor: move `sys_openat` lines 263-470 into `resolve_at`; `sys_openat` becomes `let abs = resolve_at(caller_pid, dirfd, path, 0)?; let mut req = flags.to_le_bytes().to_vec(); req.extend_from_slice(&abs); sys_open(caller_pid, &req)`. **Acceptance for S0: every existing `sys_openat` test passes byte-identically** (the safety property), plus `sys_faccessat` reworked to call `resolve_at` (its stale-snapshot bug test goes red→green).

## Per-variant delegation

| `*at` | Base op delegated to | Notes |
|---|---|---|
| `unlinkat(fd,p,flag)` | `unlink` / `rmdir` | `AT_REMOVEDIR (0x200)` ⇒ rmdir |
| `mkdirat(fd,p,mode)` | `mkdir` | |
| `fstatat(fd,p,buf,flag)` | `stat_path` / lstat | `AT_SYMLINK_NOFOLLOW (0x100)` ⇒ no-follow (lstat path, see #134) |
| `fchmodat(fd,p,mode,flag)` | `chmod` | #66 `caller_pid` authority |
| `fchownat(fd,p,u,g,flag)` | `chown` | #66 authority; `AT_EMPTY_PATH (0x1000)` ⇒ op on dirfd |
| `linkat(fd1,n1,fd2,n2,flag)` | `link` | two dirfds (resolve both); `AT_SYMLINK_FOLLOW (0x400)` |
| `symlinkat(target,fd,link)` | `symlink` | `target` verbatim; only `link` via `resolve_at` |
| `readlinkat(fd,p,buf,sz)` | `readlink` | |
| `renameat(f,from,t,to)` / `renameat2(...,flags)` | `rename` | two dirfds; `RENAME_NOREPLACE/EXCHANGE/WHITEOUT` |
| `utimensat(fd,p,ts,flag)` / `futimens` | `utimens` | `futimens` == `utimensat(fd,NULL,…)` + `AT_EMPTY_PATH` |
| `mkfifoat(fd,p,mode)` | `mkfifo` | only if base `mkfifo` exists (else defer w/ #96) |

## ABI

Append-only block of ids **after the current max `0x1_00AE`** in `abi/contract/yurt_abi_methods.toml`, one entry per method documented to the `sys_openat`/`sys_faccessat` standard (full layout + every negated errno). Wire shape per method: `u32 dirfd LE` + op-specific fixed fields + path bytes to end-of-request (mirrors `sys_openat`); `renameat*` = `u32 fromfd LE + u32 tofd LE + u32 flags LE + u32 from_len LE + from bytes + to bytes`. Add the `METHOD_SYS_*` constants + dispatch arms in `dispatch/mod.rs`.

## Cross-cutting requirements

- **#65** C1-safe length math on every request decode (wasm32 `usize` is 32-bit — add explicit 32-bit-bound guard tests; see the usize-width test-gap note).
- **#66** `caller_pid` authority for `fchmodat`/`fchownat`.
- Build on B2.9 (`resolve_at` = the inode-anchored path) — **never** the `FdEntry::Directory { path }` snapshot.
- Never duplicate the 40-hop SYMLOOP — it is reused via the extraction (it stays inside `resolve_at`/`PathResolver`).

## Slice sequence (each = own PR, TDD, not merged by agent)

- [ ] **S0** Extract `resolve_at`; `sys_openat` thin-caller (all openat tests byte-identical); retrofit `sys_faccessat` (fixes the filed stale-snapshot bug) — *foundational, others depend on it.*
- [ ] **S1** `unlinkat` + `mkdirat` (simplest; proves the helper end-to-end).
- [ ] **S2** `fstatat` + `readlinkat` (adds the stat-buf / readlink-buf marshaling; coordinate with #134 no-follow).
- [ ] **S3** `fchmodat` + `fchownat` (+#66 authority).
- [ ] **S4** `linkat` + `symlinkat` (two-dirfd / verbatim-target).
- [ ] **S5** `renameat` + `renameat2` (two dirfds + RENAME_* flags).
- [ ] **S6** `utimensat` + `futimens` (+`mkfifoat` iff base `mkfifo` lands).
- [ ] **S7** Matrix rows (justified **non-corpus** per #52 — the `*at` family postdates the IEEE-2001 corpus), named musl coreutils/busybox fixture, `YURT_KERNEL=both` B0 differ zero-diff.

## Conformance

No `conformance/interfaces/` entry in either vendored suite (corpus is IEEE 1003.1-2001, predating the 2008 `*at` family). Coverage = named musl-libc fixtures exercising `stat`/`unlink`/`rename`/`mkdir` through their `*at` impls + the B0 TS-vs-Rust differ; record a justified non-corpus matrix row (no silent skip) per #52.

## Acceptance (maps #85)

- [ ] ABI blocks appended (append-only, mirrored in toml) + dispatch arms + safe-Rust handlers via the shared `resolve_at`
- [ ] C1-safe length math (#65); `caller_pid` authority (#66) for chmod/chown variants
- [ ] TDD `cargo test -p yurt-kernel-wasm --lib` green; `fmt`/`clippy -p yurt-kernel-wasm` clean
- [ ] matrix rows; named musl fixture; B0 differ zero-diff
- [ ] resolves through the inode-anchored dir handle (S0), not the stale snapshot — and retrofits `sys_faccessat` onto it

## Self-review

Spec coverage: every #85 prototype maps to a slice + delegation row. No placeholders (helper signature + delegation + ABI shape concrete). The S0 "openat tests byte-identical" gate is the regression guard for the risky extraction.
