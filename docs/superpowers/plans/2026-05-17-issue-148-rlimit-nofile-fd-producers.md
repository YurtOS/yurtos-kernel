# Issue #148 — Enforce RLIMIT_NOFILE / EMFILE across fd-producing syscalls

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bound every automatic fd-allocation path in the wasm kernel by the caller's `RLIMIT_NOFILE` soft limit and return `-EMFILE` on exhaustion (no panic, no unbounded growth), with correct kernel-object rollback.

**Architecture:** Add one `Process::lowest_free_fd_in_limit()` helper mirroring the merged F_DUPFD fix (PR #147 / #140: read `rlimits[RLIMIT_NOFILE]` soft, `fd_table.lowest_free_fd_below(0, soft)`). Replace each in-scope `FdTable::lowest_free_fd()` (which panics via `.expect("fd table exhausted")`) with the helper; on `None` release any already-created kernel object and return `-EMFILE`.

**Tech Stack:** Rust, `yurt-kernel-wasm` crate, `cargo test -p yurt-kernel-wasm`.

**Context for reviewers (dependency note):** The fd-limit cluster's foundational PR #135 (`fix/110-emfile-erofs`) was **closed, never merged**; #143's fix (PR #145) is stranded on that dead base. On `main` only #140 landed (PR #147). So #148's `lowest_free_fd()` sites are still unbounded on `main`. `F_DUPFD` (#140/#147, `dispatch/mod.rs:dup_min_fd`) and `recvmsg`/SCM_RIGHTS (`socket.rs:install_fd_rights_truncated`, tracked by #143) are **explicitly out of scope** and left untouched.

---

## In-scope sites & rollback

| # | Site | Syscall | Pre-created object | Rollback on EMFILE |
|---|------|---------|--------------------|--------------------|
| 1 | `dispatch/fs.rs` ~182 | open → Directory | none (path snapshot) | none |
| 2 | `dispatch/fs.rs` ~217 | open → File | `create_ofd` refs=1 | `k.ofd_dec_ref(ofd_id)` |
| 3 | `dispatch/mod.rs` ~390 | `dup` | `inc_entry_ref` | `if let Some(h)=close_entry(k,entry){kh::socket_close(h);}` |
| 4 | `dispatch/mod.rs` ~674 | `pipe` read end | `create_pipe` (r=1,w=1) | `pipe_dec_ref(id,Read); pipe_dec_ref(id,Write)` |
| 5 | `dispatch/mod.rs` ~682 | `pipe` write end | read_fd installed | remove read_fd; `close_entry`(read); `pipe_dec_ref(id,Write)` |
| 6 | `dispatch/socket.rs` `install_socket_fd` | `accept` (host) | `create_socket` refs=1 | `if let Some(h)=k.socket_dec_ref(id){kh::socket_close(h);}` |
| 7 | `dispatch/socket.rs` `install_socket_id_fd` | `accept`(unix)@543, `socket`@955 | id created by caller refs=1 | `if let Some(h)=k.socket_dec_ref(id){kh::socket_close(h);}` |
| 8 | `dispatch/socket.rs` ~1213 | `socketpair` left | `create_*_pair` (l,r refs=1) | dec left_id; dec right_id |
| 9 | `dispatch/socket.rs` ~1215 | `socketpair` right | left_fd installed | remove left_fd; `close_entry`(left); dec right_id |

---

## Task 1: `Process::lowest_free_fd_in_limit` helper

**Files:** Modify `packages/kernel-wasm/src/kernel.rs` (impl `Process`), Test `packages/kernel-wasm/src/dispatch/tests.rs`.

- [ ] **Step 1:** Add to `impl Process`:

```rust
/// Lowest free fd within this process's `RLIMIT_NOFILE` soft limit,
/// or `None` when the soft limit is reached (callers map to
/// `-EMFILE`). Mirrors the F_DUPFD bound (#140 / PR #147). A missing
/// limit slot is treated as unbounded.
pub fn lowest_free_fd_in_limit(&self) -> Option<u32> {
    let soft = self.rlimits[RLIMIT_NOFILE]
        .map(|(soft, _)| soft)
        .unwrap_or(u64::MAX);
    self.fd_table.lowest_free_fd_below(0, soft)
}
```

- [ ] **Step 2..N:** Per-site failing test → implement → green (Tasks 2-6). One commit at the end (single logical change; pre-push runs `cargo test --tests`).

## Task 2: open/openat (sites 1,2) — `dispatch/fs.rs`

- [ ] Failing test `open_past_rlimit_nofile_is_emfile`: lower NOFILE to a small soft via `METHOD_SYS_SETRLIMIT`, open files until `-EMFILE`; assert no panic, freed slot reused, per-process.
- [ ] Implement: replace both `let fd = p.fd_table.lowest_free_fd();` with
  `let Some(fd) = p.lowest_free_fd_in_limit() else { return -(abi::EMFILE as i64); };`
  For the File site, the rollback path releases the OFD:
  ```rust
  let ofd_id = k.create_ofd(mount_id, inode, writable);
  let Some(fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
      k.ofd_dec_ref(ofd_id);
      return -(abi::EMFILE as i64);
  };
  k.process_mut(caller_pid).fd_table.install(fd, crate::kernel::FdEntry::File { ofd_id });
  ```
- [ ] Run `cargo test -p yurt-kernel-wasm open_past_rlimit` → PASS.

## Task 3: dup (site 3) — `dispatch/mod.rs:dup_fd`

- [ ] Failing test `dup_past_rlimit_nofile_is_emfile` (incl. socket-entry dup rollback leaves refcount intact).
- [ ] Implement:
  ```rust
  inc_entry_ref(k, &entry);
  let Some(newfd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
      if let Some(h) = close_entry(k, entry) { kh::socket_close(h); }
      return -(abi::EMFILE as i64);
  };
  k.process_mut(caller_pid).fd_table.install(newfd, entry);
  newfd as i64
  ```
- [ ] Green.

## Task 4: pipe (sites 4,5) — `dispatch/mod.rs:pipe`

- [ ] Failing test `pipe_past_rlimit_nofile_is_emfile`: at soft limit (no free fd) and at exactly-one-free-fd (read installs, write fails) — assert `-EMFILE`, pipe object freed (no leak), no half-open fd left.
- [ ] Implement (read end fails → dec both ends; write end fails → remove read_fd + close_entry + dec write end). Code:
  ```rust
  let id = k.create_pipe();
  let Some(read_fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
      k.pipe_dec_ref(id, crate::kernel::PipeEnd::Read);
      k.pipe_dec_ref(id, crate::kernel::PipeEnd::Write);
      return -(abi::EMFILE as i64);
  };
  k.process_mut(caller_pid).fd_table.install(read_fd,
      crate::kernel::FdEntry::Pipe { id, end: crate::kernel::PipeEnd::Read });
  let Some(write_fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
      if let Some(e) = k.process_mut(caller_pid).fd_table.remove(read_fd) { close_entry(k, e); }
      k.pipe_dec_ref(id, crate::kernel::PipeEnd::Write);
      return -(abi::EMFILE as i64);
  };
  k.process_mut(caller_pid).fd_table.install(write_fd,
      crate::kernel::FdEntry::Pipe { id, end: crate::kernel::PipeEnd::Write });
  ```
- [ ] Green.

## Task 5: socket/accept (sites 6,7) — `dispatch/socket.rs`

- [ ] Failing tests `socket_past_rlimit_nofile_is_emfile`, `accept_past_rlimit_nofile_is_emfile` (unix-stream accept path, deterministic without host).
- [ ] Change helper signatures to `-> Result<u32, i64>`, rollback inside:
  ```rust
  fn install_socket_fd(k,caller_pid,handle,domain,sock_type) -> Result<u32,i64> {
      let id = k.create_socket(handle, domain, sock_type);
      install_socket_id_fd(k, caller_pid, id)
  }
  fn install_socket_id_fd(k,caller_pid,id) -> Result<u32,i64> {
      let Some(fd) = k.process_mut(caller_pid).lowest_free_fd_in_limit() else {
          if let Some(h) = k.socket_dec_ref(id) { kh::socket_close(h); }
          return Err(-(abi::EMFILE as i64));
      };
      k.process_mut(caller_pid).fd_table.install(fd, FdEntry::Socket { id });
      Ok(fd)
  }
  ```
  Update 3 call sites (543, 559, 955): `match install_…(…) { Ok(fd)=>fd as i64, Err(rc)=>rc }`.
- [ ] Green.

## Task 6: socketpair (sites 8,9) — `dispatch/socket.rs:sys_socketpair`

- [ ] Failing test `socketpair_past_rlimit_nofile_is_emfile` (both: no free fd, and exactly-one-free).
- [ ] Implement two-fd alloc with rollback (left fails → dec both ids; right fails → remove left_fd + close_entry + dec right_id). Mirror Task 4 shape.
- [ ] Green.

## Task 7: Verify + commit + PR

- [ ] `cargo fmt --all`, `cargo clippy -p yurt-kernel-wasm --all-targets -- -D warnings` (kernel-wasm is not CI-clippy-gated — gate locally), `cargo test -p yurt-kernel-wasm`.
- [ ] Single squashed commit `fix(posix): enforce RLIMIT_NOFILE/EMFILE across fd producers (#148)`.
- [ ] Push, open PR (base `main`), do **not** merge. Note #143/#140 out-of-scope + the dead-#135-stack context.

## Self-review

- Spec coverage: acceptance list (open/pipe/socket/accept/socketpair/dup bounded + EMFILE + no panic + explicit-fd EINVAL preserved) — every bullet maps to Tasks 2-6. F_DUPFD/SCM_RIGHTS explicitly excluded per issue.
- No placeholders: all code shown.
- Type consistency: helper name `lowest_free_fd_in_limit` used identically everywhere; socket helpers uniformly `Result<u32, i64>`.
