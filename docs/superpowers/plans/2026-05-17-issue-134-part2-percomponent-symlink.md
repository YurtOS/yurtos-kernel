# Issue #134 Part 2 — per-component symlink resolution for stat()/lstat() Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `stat()` and `lstat()` resolve symlinks in every intermediate path component (POSIX), with the terminal differing (stat follows, lstat does not), preserving Part 1 (`lstat` `st_size`), SYMLOOP, `.`/`..`, ENOTDIR/ENOENT, and strengthening per-component `/proc` authorization.

**Architecture:** Approach A from the spec — generalize the existing per-component walk in `path.rs:resolve_realpath` into one shared `resolve_components(follow_terminal, authorize_each)`; `realpath` keeps calling it with the legacy `(true,false)` shape (byte-for-byte unchanged); two new `PathResolver` methods `resolve_stat`/`resolve_lstat` feed `stat_path`/`lstat_path`. Mechanism-independent of #59/PR-63 (base-trait `readlink`/`entry_type` only).

**Tech Stack:** Rust (`yurt-kernel-wasm` crate), `cargo test --lib`, in-tree `#[cfg(test)] mod tests` dispatch-level tests via the `dispatch(METHOD, pid, req, &mut resp)` helper.

**Spec:** `docs/superpowers/specs/2026-05-17-issue-134-part2-percomponent-symlink-design.md`. **Branch/worktree:** `worktree-issue-134-lstat-stsize` (off `main`; Part 1 already committed at `d759965`).

**Conventions (verified in `packages/kernel-wasm/src/dispatch/tests.rs`):**
- `let _g = crate::kernel::TestGuard::acquire();` first line of every test (isolation).
- `dispatch(METHOD_SYS_*, pid, &request, &mut response) -> i64`. Constants in scope via `use super::*;`.
- Make a dir: `dispatch(METHOD_SYS_MKDIR, 1, b"/d", &mut [])` → `0`.
- Register a regular file: request = `(path.len() as u32).to_le_bytes()` ++ path ++ content; `dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut [])`.
- Create a symlink: request = `(target.len() as u32).to_le_bytes()` ++ target ++ link_path; `dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut [])` → `0`.
- stat/lstat 16-byte record: `out[0..8]`=size u64 LE, `out[8..12]`=filetype u32 LE (0 none, 3 dir, 4 file, 6 sock, 7 symlink), `out[12..16]`=mode u32 LE.
- Non-root caller = any pid by default; `make_root(pid)` (helper at `tests.rs:11`) sets euid=0. Populate `/proc/<pid>/cmdline`: `set_argv(&set_argv_req(pid, &[b"/bin/x"]))` (see `proc_other_pid_open_gate_survives_symlink_resolution`, `tests.rs:4842`).
- `abi::EPERM`, `abi::ENOENT`, `abi::ENOTDIR`, `abi::EINVAL` in scope.

**Files:**
- Modify: `packages/kernel-wasm/src/path.rs` — add `resolve_components`; rewire `PathResolver::realpath`; add `PathResolver::resolve_stat`/`resolve_lstat`.
- Modify: `packages/kernel-wasm/src/dispatch/fs.rs` — rewire `stat_path` (drop `normalize_readable_path`+`follow_symlinks`) and `lstat_path` (drop `normalize_readable_path`).
- Test: `packages/kernel-wasm/src/dispatch/tests.rs` — all new tests appended near the existing `lstat_*`/`stat_*`/`realpath_*` tests.

**Gate after every task:** `cargo test --lib -p yurt-kernel-wasm` (0 failed), `cargo fmt -p yurt-kernel-wasm --check` (clean), `cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings` (clean). All run from the worktree root.

---

### Task 1: Realpath characterization (lock current behavior before refactor)

Characterization tests: they must be **GREEN on the unmodified base** and stay green through the refactor. They pin the exact `realpath` behavior the shared-resolver extraction must preserve, including the cross-pid `/proc` post-gate.

**Files:**
- Test: `packages/kernel-wasm/src/dispatch/tests.rs` (append after `realpath_follows_symlink_components_and_parent_traversal`, ~`tests.rs:6274`)

- [ ] **Step 1: Write the characterization test**

```rust
// Issue #134 Part 2: pins realpath's exact pre-refactor behavior so the
// shared-resolver extraction is provably non-regressing. A cross-pid
// /proc intermediate symlink is followed by the lexical walk (no
// per-component gate) and then denied by realpath's single post-gate
// (fs.rs:430). Approach A keeps realpath on (follow_terminal=true,
// authorize_each=false), so this must stay GREEN unchanged.
#[test]
fn realpath_crosspid_proc_symlink_is_post_gated_unchanged() {
    let _g = crate::kernel::TestGuard::acquire();
    // pid 2 exists with a /proc/2/cmdline.
    set_argv(&set_argv_req(2, &[b"/bin/other"]));
    // /tmp/leak -> /proc/2/cmdline (absolute symlink target).
    let target = b"/proc/2/cmdline";
    let mut sreq = (target.len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(target);
    sreq.extend_from_slice(b"/tmp/leak");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    // pid 1 (non-root) realpath through the link → -EPERM (post-gate).
    let mut out = [0u8; 64];
    assert_eq!(
        dispatch(METHOD_SYS_REALPATH, 1, b"/tmp/leak", &mut out),
        -(abi::EPERM as i64),
        "realpath cross-pid /proc symlink must stay post-gated (-EPERM)"
    );
    // pid 2 (owns it) → succeeds.
    make_root(2);
    let n = dispatch(METHOD_SYS_REALPATH, 2, b"/tmp/leak", &mut out);
    assert!(n > 0, "owner/root realpath resolves: {n}");
}
```

- [ ] **Step 2: Run it on the unmodified base — expect PASS**

Run: `cargo test --lib -p yurt-kernel-wasm realpath_crosspid_proc_symlink_is_post_gated_unchanged -- --exact`
Expected: `test result: ok. 1 passed`. (Characterization — it captures current behavior, so it passes now. If it does NOT pass, STOP: the assumption about current behavior is wrong; re-investigate before any refactor.)

- [ ] **Step 3: Commit**

```bash
git add packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "test(#134p2): characterize realpath cross-pid /proc behavior pre-refactor"
```

---

### Task 2: Extract `resolve_components`; rewire `realpath` (behavior-preserving refactor)

Pure refactor: introduce the shared resolver with both knobs; `realpath` calls it as `(follow_terminal=true, authorize_each=false)`. `authorize_each=true` gates the **final path only** here (the regression-safe interim that replicates today's single `normalize_readable_path` gate; Task 5 strengthens it to per-component). No caller uses `authorize_each=true` or `follow_terminal=false` yet.

**Files:**
- Modify: `packages/kernel-wasm/src/path.rs` — replace the free `resolve_realpath` (`path.rs:125-177`) with `resolve_components`; update `PathResolver::realpath` (`path.rs:34-38`).

- [ ] **Step 1: Replace `resolve_realpath` with `resolve_components`**

Delete the entire current `fn resolve_realpath(k: &mut Kernel, cwd: &[u8], path: &[u8]) -> Result<Vec<u8>, i32> { ... }` (`path.rs:125-177`) and put in its place:

```rust
/// Shared per-component path resolver. Walks `path` one component at a
/// time, resolving symlinks at each step, joining relative targets
/// against the resolved-so-far prefix, applying `.`/`..` inline, the
/// 40-hop SYMLOOP limit, and ENOTDIR/ENOENT — using only the base
/// `VfsBackend` `readlink`/`entry_type` methods.
///
/// `follow_terminal`: when false, the terminal component (the one
/// popped when nothing remains pending) is appended to the resolved
/// parent WITHOUT being readlinked — POSIX `lstat` semantics. Every
/// *intermediate* component is still followed. "Terminal" is the live
/// `pending.is_empty()` state at pop time, not a lexical index: an
/// intermediate symlink rewrites `pending`, so the terminal may come
/// from a symlink target.
///
/// `authorize_each`: when true, gate the resolved final path through
/// `can_read_proc_path` (interim: final-path only — Task 5 of the
/// #134 Part 2 plan strengthens this to every component + every
/// symlink target). When false, no gate here (realpath keeps its own
/// post-resolution gate in dispatch).
fn resolve_components(
    k: &mut Kernel,
    caller_pid: u32,
    cwd: &[u8],
    path: &[u8],
    follow_terminal: bool,
    authorize_each: bool,
) -> Result<Vec<u8>, i32> {
    if path.is_empty() || path.contains(&0) {
        return Err(abi::EINVAL);
    }
    let mut pending = split_components(&absolute_from_cwd(cwd, path));
    let mut resolved: Vec<Vec<u8>> = Vec::new();
    let mut hops = 0u32;

    while let Some(component) = pending.pop_front() {
        if component == b"." {
            continue;
        }
        if component == b".." {
            resolved.pop();
            continue;
        }

        let mut candidate_components = resolved.clone();
        candidate_components.push(component.clone());
        let candidate = join_components(&candidate_components);

        // Terminal == popped with nothing left pending. lstat
        // (follow_terminal=false) types the link itself; every
        // intermediate component is still followed.
        let is_terminal = pending.is_empty();
        if follow_terminal || !is_terminal {
            if let Some(target) = k.vfs.readlink(&candidate) {
                hops += 1;
                if hops > 40 {
                    return Err(abi::EINVAL);
                }
                let target_path = if target.starts_with(b"/") {
                    target
                } else {
                    let base = join_components(&resolved);
                    append_rest(base, &std::collections::VecDeque::from([target]))
                };
                pending = split_components(&append_rest(target_path, &pending));
                resolved.clear();
                continue;
            }
        }

        let ty = k.vfs.entry_type(&candidate);
        if ty == 0 {
            return Err(abi::ENOENT);
        }
        if !pending.is_empty() && ty != 3 {
            return Err(abi::ENOTDIR);
        }
        resolved.push(component);
    }

    let final_path = join_components(&resolved);
    if k.vfs.entry_type(&final_path) == 0 {
        return Err(abi::ENOENT);
    }
    if authorize_each {
        // Interim (Task 2): final-path gate — exactly matches today's
        // single normalize_readable_path gate, so stat/lstat wiring in
        // Tasks 3/4 cannot regress direct /proc/<other> access. Task 5
        // moves this to per-component + per-symlink-target.
        k.publish_proc_snapshots();
        if !k.can_read_proc_path(caller_pid, &final_path) {
            return Err(abi::EPERM);
        }
    }
    Ok(final_path)
}
```

- [ ] **Step 2: Rewire `PathResolver::realpath` to the shared resolver**

Replace the body of `pub fn realpath` (`path.rs:34-38`):

```rust
    pub fn realpath(&mut self, raw_path: &[u8]) -> Result<Vec<u8>, i32> {
        let rewritten = proc_self_rewrite(self.caller_pid, raw_path);
        let cwd = self.kernel.process(self.caller_pid).cwd.clone();
        resolve_components(
            self.kernel,
            self.caller_pid,
            &cwd,
            &rewritten,
            /*follow_terminal*/ true,
            /*authorize_each*/ false,
        )
    }
```

- [ ] **Step 3: Run the full suite — expect NO behavior change**

Run: `cargo test --lib -p yurt-kernel-wasm 2>&1 | tail -3`
Expected: `test result: ok. <N> passed; 0 failed` where `<N>` ≥ 409 (the Task-1 characterization test and every existing `realpath_*` test included, all green — the refactor is behavior-preserving).

- [ ] **Step 4: fmt + clippy**

Run: `cargo fmt -p yurt-kernel-wasm --check && cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings 2>&1 | tail -1`
Expected: no fmt diff; clippy `Finished` with no warnings.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel-wasm/src/path.rs
git commit -m "refactor(#134p2): extract resolve_components; realpath uses (true,false) — no behavior change"
```

---

### Task 3: `resolve_stat` + rewire `stat_path` (intermediate symlink resolution for stat)

**Files:**
- Modify: `packages/kernel-wasm/src/path.rs` — add `PathResolver::resolve_stat`.
- Modify: `packages/kernel-wasm/src/dispatch/fs.rs` — rewire `stat_path` (`fs.rs:526-547`).
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`.

- [ ] **Step 1: Write the failing test (stat through an intermediate symlink dir)**

```rust
// Issue #134 Part 2: stat() must resolve symlinks in INTERMEDIATE
// components. /a/symdir -> /real (dir) containing file `f`.
#[test]
fn stat_resolves_intermediate_symlink_directory() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/a", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/real", &mut []), 0);
    let mut reg = (b"/real/f".len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(b"/real/f");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    // /a/symdir -> /real
    let mut sreq = (b"/real".len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/real");
    sreq.extend_from_slice(b"/a/symdir");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/a/symdir/f", &mut out), 16);
    assert_eq!(
        u32::from_le_bytes(out[8..12].try_into().unwrap()),
        4,
        "stat must traverse the intermediate symlink /a/symdir and type /real/f as S_IFREG"
    );
}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cargo test --lib -p yurt-kernel-wasm stat_resolves_intermediate_symlink_directory -- --exact`
Expected: FAIL — current `stat_path` uses lexical `normalize_readable_path` then `follow_symlinks` (terminal-only), so `/a/symdir/f` does not traverse `symdir`; result is `-ENOENT` (left `-2`, right `16`) — i.e. the assert on `dispatch(...) == 16` fails.

- [ ] **Step 3: Add `PathResolver::resolve_stat`**

In `path.rs`, immediately after `pub fn realpath` (before the closing `}` of the `impl<'kernel> PathResolver<'kernel>` block, ~`path.rs:39`), add:

```rust
    /// Resolve for `stat()`: every component followed, including the
    /// terminal symlink chain (POSIX stat). Per-component `/proc`
    /// authorization on.
    pub fn resolve_stat(&mut self, raw_path: &[u8]) -> Result<Vec<u8>, i32> {
        let rewritten = proc_self_rewrite(self.caller_pid, raw_path);
        let cwd = self.kernel.process(self.caller_pid).cwd.clone();
        resolve_components(
            self.kernel,
            self.caller_pid,
            &cwd,
            &rewritten,
            /*follow_terminal*/ true,
            /*authorize_each*/ true,
        )
    }
```

- [ ] **Step 4: Rewire `stat_path`**

In `fs.rs`, replace the `with_kernel(|k| { ... })` body of `pub(super) fn stat_path` (`fs.rs:533-546`) so the function becomes:

```rust
pub(super) fn stat_path(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        // POSIX stat(): resolve symlinks in EVERY component, including
        // the terminal chain (#134 Part 2). resolve_stat subsumes the
        // old normalize_readable_path + follow_symlinks pair.
        let path = match PathResolver::new(k, caller_pid).resolve_stat(request) {
            Ok(path) => path,
            Err(errno) => return -(errno as i64),
        };
        write_stat_record(k, &path, response)
    })
}
```

(`PathResolver` is already imported in `fs.rs` — `use crate::path::PathResolver;` at `fs.rs:3`.)

- [ ] **Step 5: Run the new test + full stat suite — expect PASS**

Run: `cargo test --lib -p yurt-kernel-wasm stat_ -- --nocapture 2>&1 | tail -3`
Expected: `0 failed`. Specifically `stat_resolves_intermediate_symlink_directory` passes and the existing `stat_follows_symlink_to_directory`, `stat_on_dangling_symlink_is_enoent`, `stat_follows_multi_hop_symlink_chain` stay green.

- [ ] **Step 6: Full suite + fmt + clippy**

Run: `cargo test --lib -p yurt-kernel-wasm 2>&1 | tail -3 && cargo fmt -p yurt-kernel-wasm --check && cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings 2>&1 | tail -1`
Expected: `0 failed`; no fmt diff; clippy clean.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel-wasm/src/path.rs packages/kernel-wasm/src/dispatch/fs.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "fix(#134p2): stat() resolves intermediate symlink components"
```

---

### Task 4: `resolve_lstat` + rewire `lstat_path` (intermediate resolution, terminal NOT followed)

**Files:**
- Modify: `packages/kernel-wasm/src/path.rs` — add `PathResolver::resolve_lstat`.
- Modify: `packages/kernel-wasm/src/dispatch/fs.rs` — rewire `lstat_path` (`fs.rs:557-571`).
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`.

- [ ] **Step 1: Write the failing test (lstat: intermediate symlink resolved, terminal symlink NOT followed)**

```rust
// Issue #134 Part 2: lstat() resolves INTERMEDIATE symlink components
// but does NOT follow the terminal symlink. /a/symdir -> /real (dir);
// /real/sl -> /real/target (a symlink). lstat(/a/symdir/sl) must
// traverse symdir but type `sl` itself as S_IFLNK with Part-1 st_size.
#[test]
fn lstat_resolves_intermediate_but_not_terminal_symlink() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/a", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/real", &mut []), 0);
    // /a/symdir -> /real (intermediate symlink, must be followed)
    let mut s1 = (b"/real".len() as u32).to_le_bytes().to_vec();
    s1.extend_from_slice(b"/real");
    s1.extend_from_slice(b"/a/symdir");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &s1, &mut []), 0);
    // /real/sl -> /real/target (terminal symlink, must NOT be followed)
    let tgt = b"/real/target";
    let mut s2 = (tgt.len() as u32).to_le_bytes().to_vec();
    s2.extend_from_slice(tgt);
    s2.extend_from_slice(b"/real/sl");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &s2, &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_LSTAT, 1, b"/a/symdir/sl", &mut out), 16);
    assert_eq!(
        u32::from_le_bytes(out[8..12].try_into().unwrap()),
        7,
        "lstat must follow intermediate /a/symdir but report terminal `sl` as S_IFLNK"
    );
    assert_eq!(
        u64::from_le_bytes(out[0..8].try_into().unwrap()),
        tgt.len() as u64,
        "Part 1 preserved: lstat st_size = terminal symlink target length"
    );
}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cargo test --lib -p yurt-kernel-wasm lstat_resolves_intermediate_but_not_terminal_symlink -- --exact`
Expected: FAIL — current `lstat_path` is purely lexical, so `/a/symdir/sl` does not traverse `symdir`; `dispatch` returns `-ENOENT` (left `-2`, right `16`).

- [ ] **Step 3: Add `PathResolver::resolve_lstat`**

In `path.rs`, immediately after `pub fn resolve_stat` (added in Task 3), add:

```rust
    /// Resolve for `lstat()`: every INTERMEDIATE component followed,
    /// terminal NOT followed (POSIX lstat). Per-component `/proc`
    /// authorization on (including the terminal candidate).
    pub fn resolve_lstat(&mut self, raw_path: &[u8]) -> Result<Vec<u8>, i32> {
        let rewritten = proc_self_rewrite(self.caller_pid, raw_path);
        let cwd = self.kernel.process(self.caller_pid).cwd.clone();
        resolve_components(
            self.kernel,
            self.caller_pid,
            &cwd,
            &rewritten,
            /*follow_terminal*/ false,
            /*authorize_each*/ true,
        )
    }
```

- [ ] **Step 4: Rewire `lstat_path`**

In `fs.rs`, replace `pub(super) fn lstat_path` (`fs.rs:557-571`) so it becomes:

```rust
pub(super) fn lstat_path(caller_pid: u32, request: &[u8], response: &mut [u8]) -> i64 {
    if request.is_empty() {
        return -(abi::EINVAL as i64);
    }
    if response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        // POSIX lstat(): resolve symlinks in every INTERMEDIATE
        // component, but do NOT follow the terminal (#134 Part 2).
        // write_stat_record then types the un-followed terminal —
        // a terminal symlink reports S_IFLNK + Part-1 st_size.
        let path = match PathResolver::new(k, caller_pid).resolve_lstat(request) {
            Ok(path) => path,
            Err(errno) => return -(errno as i64),
        };
        write_stat_record(k, &path, response)
    })
}
```

- [ ] **Step 5: Run new test + full lstat/Part-1 suite — expect PASS**

Run: `cargo test --lib -p yurt-kernel-wasm lstat_ -- --nocapture 2>&1 | tail -3`
Expected: `0 failed`. `lstat_resolves_intermediate_but_not_terminal_symlink` passes; the existing `lstat_does_not_follow_symlink_to_directory`, `lstat_does_not_follow_symlink_to_regular_file`, `lstat_on_dangling_symlink_reports_the_link`, `lstat_on_regular_file_matches_stat`, `lstat_on_directory_matches_stat`, `lstat_unknown_path_is_enoent`, `lstat_symlink_st_size_is_target_path_length`, `lstat_empty_request_is_einval`, `lstat_short_response_is_einval` stay green.

- [ ] **Step 6: Full suite + fmt + clippy**

Run: `cargo test --lib -p yurt-kernel-wasm 2>&1 | tail -3 && cargo fmt -p yurt-kernel-wasm --check && cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings 2>&1 | tail -1`
Expected: `0 failed`; no fmt diff; clippy clean.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel-wasm/src/path.rs packages/kernel-wasm/src/dispatch/fs.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "fix(#134p2): lstat() resolves intermediate components, terminal not followed (Part 1 preserved)"
```

---

### Task 5: Strengthen authorization to per-component + per-symlink-target; SYMLOOP & residual tests

Moves the `authorize_each` gate from final-path-only (Task 2 interim) to **every component candidate and every symlink target**, closing the intermediate-symlink `/proc/<other-pid>` oracle. Adds the security RED→GREEN, the non-regression GREEN locks, the intermediate SYMLOOP test, and the trailing-slash known-residual characterization (#146).

**Files:**
- Modify: `packages/kernel-wasm/src/path.rs` — `resolve_components` gate placement.
- Test: `packages/kernel-wasm/src/dispatch/tests.rs`.

- [ ] **Step 1: Write the failing per-component RED test**

This is the *distinguishing* test: an intermediate component lands in another pid's `/proc/2`, but `..` then escapes so the **final** resolved path is `/tmp/x` (not under `/proc`). The Task-2 interim final-path-only gate allows it (final path `/tmp/x` is ungated); a true per-component gate denies it at the `/proc/2` candidate. It depends only on `/proc` and `/proc/2` being directories (`entry_type == 3`) — no `/proc/<pid>/cwd` symlink semantics.

```rust
// Issue #134 Part 2: the /proc authorization gate must be PER-COMPONENT,
// not final-path-only. An intermediate symlink crosses into /proc/2
// (other pid) but `..` escapes so the final path (/tmp/x) is ungated.
// Final-path-only (Task 2 interim) lets this through; the per-component
// gate (this task) denies it at the /proc/2 candidate.
#[test]
fn stat_intermediate_crosspid_proc_gate_is_per_component() {
    let _g = crate::kernel::TestGuard::acquire();
    set_argv(&set_argv_req(2, &[b"/bin/other"])); // pid 2 exists
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/t", &mut []), 0);
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/tmp", &mut []), 0);
    let mut reg = (b"/tmp/x".len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(b"/tmp/x");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    // /t/hop -> /proc/2  (an intermediate that visits pid 2's proc dir)
    let mut sreq = (b"/proc/2".len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/proc/2");
    sreq.extend_from_slice(b"/t/hop");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    // /t/hop/../../tmp/x : resolves /t/hop→/proc/2 (candidate /proc/2 →
    // gated), then `..`/`..` climb out, final = /tmp/x (ungated).
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/t/hop/../../tmp/x", &mut out),
        -(abi::EPERM as i64),
        "stat must gate the intermediate /proc/2 candidate even though \
         the final path escapes /proc to /tmp/x"
    );
}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cargo test --lib -p yurt-kernel-wasm stat_intermediate_crosspid_proc_gate_is_per_component -- --exact`
Expected: FAIL — the Task-2 interim gate checks only the *final* resolved path (`/tmp/x`, ungated), so `dispatch` returns `16`, not `-EPERM` (assert left `16`, right `-1`). RED proves the per-component gap precisely.

- [ ] **Step 3: Move the gate to per-component + per-symlink-target**

In `resolve_components` (`path.rs`), make these three edits:

(a) After `let mut hops = 0u32;` and before the `while` loop, add the snapshot refresh:

```rust
    if authorize_each {
        k.publish_proc_snapshots();
    }
```

(b) Immediately after `let candidate = join_components(&candidate_components);` add the per-component gate:

```rust
        if authorize_each && !k.can_read_proc_path(caller_pid, &candidate) {
            return Err(abi::EPERM);
        }
```

(c) Inside the `if let Some(target) = k.vfs.readlink(&candidate)` block, after `target_path` is computed and before `pending = ...`, add the per-target gate:

```rust
                if authorize_each && !k.can_read_proc_path(caller_pid, &target_path) {
                    return Err(abi::EPERM);
                }
```

(d) Delete the now-redundant interim final-path gate block (the `if authorize_each { k.publish_proc_snapshots(); if !k.can_read_proc_path(caller_pid, &final_path) { return Err(abi::EPERM); } }` near the end). The final component is itself a `candidate` already gated by (b), so this is covered without a separate post-check.

- [ ] **Step 4: Run the RED test — expect PASS — and add the broad GREEN coverage**

Run: `cargo test --lib -p yurt-kernel-wasm stat_intermediate_crosspid_proc_gate_is_per_component -- --exact`
Expected: PASS (`1 passed`) — the per-component gate now denies the `/proc/2` candidate.

Then append the broad stat+lstat coverage + root-allowed test (GREEN — verifies both entry points and the root carve-out now that the gate exists):

```rust
// Coverage: intermediate /proc/<other> symlink gated for BOTH stat and
// lstat; root is not gated. Final path here IS under /proc/2, so this
// also exercises the simple (final == proc) case for both entries.
#[test]
fn stat_lstat_intermediate_proc_symlink_is_gated() {
    let _g = crate::kernel::TestGuard::acquire();
    set_argv(&set_argv_req(2, &[b"/bin/other"]));
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/t", &mut []), 0);
    let mut sreq = (b"/proc/2".len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/proc/2");
    sreq.extend_from_slice(b"/t/leak");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);

    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/t/leak/status", &mut out),
        -(abi::EPERM as i64),
        "stat: /proc/<other> via intermediate symlink must be gated"
    );
    assert_eq!(
        dispatch(METHOD_SYS_LSTAT, 1, b"/t/leak/status", &mut out),
        -(abi::EPERM as i64),
        "lstat: /proc/<other> via intermediate symlink must be gated"
    );
    // root caller not gated (reaches the entry: 16 or -ENOENT for a
    // missing leaf, never -EPERM).
    make_root(1);
    let rc = dispatch(METHOD_SYS_STAT, 1, b"/t/leak/status", &mut out);
    assert_ne!(rc, -(abi::EPERM as i64), "root must not be gated: {rc}");
}
```

Run: `cargo test --lib -p yurt-kernel-wasm stat_lstat_intermediate_proc_symlink_is_gated -- --exact`
Expected: PASS (`1 passed`).

- [ ] **Step 5: Add the non-regression GREEN locks + SYMLOOP + trailing-slash residual**

```rust
// Per-component-auth non-regression: ordinary deep paths and the
// caller's OWN /proc/self must still resolve (strict-strengthening
// lock — a future can_read_proc_path change cannot silently regress).
#[test]
fn stat_lstat_per_component_auth_allows_self_and_ordinary() {
    let _g = crate::kernel::TestGuard::acquire();
    set_argv(&set_argv_req(1, &[b"/bin/self"]));
    for p in [b"/a".as_slice(), b"/a/b", b"/a/b/c", b"/a/b/c/d"] {
        assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, p, &mut []), 0);
    }
    let mut reg = (b"/a/b/c/d/f".len() as u32).to_le_bytes().to_vec();
    reg.extend_from_slice(b"/a/b/c/d/f");
    reg.extend_from_slice(b"hi");
    dispatch(METHOD_KERNEL_REGISTER_FILE, 0, &reg, &mut []);
    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/a/b/c/d/f", &mut out), 16);
    assert_eq!(dispatch(METHOD_SYS_LSTAT, 1, b"/a/b/c/d/f", &mut out), 16);
    // own /proc/self/cmdline (multi-component, rewritten to /proc/1)
    assert_eq!(dispatch(METHOD_SYS_STAT, 1, b"/proc/self/cmdline", &mut out), 16);
    assert_eq!(dispatch(METHOD_SYS_LSTAT, 1, b"/proc/self/cmdline", &mut out), 16);
}

// Intermediate symlink cycle → EINVAL (40-hop SYMLOOP), both entries.
#[test]
fn stat_lstat_intermediate_symlink_loop_is_einval() {
    let _g = crate::kernel::TestGuard::acquire();
    // /x -> /y/z and /y -> /x  → cycle reached via an intermediate.
    let mut s1 = (b"/y/z".len() as u32).to_le_bytes().to_vec();
    s1.extend_from_slice(b"/y/z");
    s1.extend_from_slice(b"/x");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &s1, &mut []), 0);
    let mut s2 = (b"/x".len() as u32).to_le_bytes().to_vec();
    s2.extend_from_slice(b"/x");
    s2.extend_from_slice(b"/y");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &s2, &mut []), 0);
    let mut out = [0u8; 16];
    assert_eq!(
        dispatch(METHOD_SYS_STAT, 1, b"/x/q", &mut out),
        -(abi::EINVAL as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_LSTAT, 1, b"/x/q", &mut out),
        -(abi::EINVAL as i64)
    );
}

// KNOWN PRESERVED non-POSIX residual (#146): a trailing slash does NOT
// force-follow a terminal symlink for lstat. Pins current behavior so
// #146's eventual fix is a deliberate, test-visible change.
#[test]
fn lstat_trailing_slash_on_terminal_symlink_known_residual_146() {
    let _g = crate::kernel::TestGuard::acquire();
    assert_eq!(dispatch(METHOD_SYS_MKDIR, 1, b"/real", &mut []), 0);
    let mut sreq = (b"/real".len() as u32).to_le_bytes().to_vec();
    sreq.extend_from_slice(b"/real");
    sreq.extend_from_slice(b"/symdir");
    assert_eq!(dispatch(METHOD_SYS_SYMLINK, 1, &sreq, &mut []), 0);
    let mut out = [0u8; 16];
    assert_eq!(dispatch(METHOD_SYS_LSTAT, 1, b"/symdir/", &mut out), 16);
    assert_eq!(
        u32::from_le_bytes(out[8..12].try_into().unwrap()),
        7,
        "KNOWN RESIDUAL #146: trailing slash does not force-follow; \
         symdir reported as S_IFLNK (POSIX would follow to S_IFDIR)"
    );
}
```

- [ ] **Step 6: Run new tests — expect PASS**

Run: `cargo test --lib -p yurt-kernel-wasm per_component_auth_allows_self_and_ordinary intermediate_symlink_loop_is_einval trailing_slash_on_terminal_symlink_known_residual_146 -- --nocapture 2>&1 | tail -3`
Expected: all pass (`0 failed`).

- [ ] **Step 7: Full suite + fmt + clippy**

Run: `cargo test --lib -p yurt-kernel-wasm 2>&1 | tail -3 && cargo fmt -p yurt-kernel-wasm --check && cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings 2>&1 | tail -1`
Expected: `0 failed` (≥ 417 passed); no fmt diff; clippy clean. Confirm the Task-1 `realpath_crosspid_proc_symlink_is_post_gated_unchanged` and all `realpath_*` are still green (realpath uses `authorize_each=false`, untouched by the per-component gate).

- [ ] **Step 8: Commit**

```bash
git add packages/kernel-wasm/src/path.rs packages/kernel-wasm/src/dispatch/tests.rs
git commit -m "fix(#134p2): per-component + per-symlink-target /proc gate; SYMLOOP + #146 residual tests"
```

---

### Task 6: Finalize — issue cross-references, spec/plan checkbox sweep, completion gate

**Files:** none code; housekeeping + final verification.

- [ ] **Step 1: Re-run the full gate from a clean state**

Run: `cargo test --lib -p yurt-kernel-wasm 2>&1 | tail -3 && cargo fmt --check -p yurt-kernel-wasm && cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings 2>&1 | tail -1`
Expected: `0 failed`; no fmt diff; clippy clean.

- [ ] **Step 2: Verify the spec's DoD list is satisfied**

Open `docs/superpowers/specs/2026-05-17-issue-134-part2-percomponent-symlink-design.md`, read the **Sequencing / DoD** section, and confirm each DoD bullet maps to a green test from Tasks 3–5. If any bullet has no test, add it before proceeding (do not mark complete with gaps).

- [ ] **Step 3: Commit any doc/cross-ref updates**

```bash
git add -A
git commit -m "docs(#134p2): DoD verification sweep" --allow-empty
```

- [ ] **Step 4: Hand off for review (do NOT self-merge)**

Per project policy ([feedback] no self-merge) and AGENTS.md, stop here: the branch `worktree-issue-134-lstat-stsize` carries Part 1 + Part 2 + the AGENTS.md rule + spec + plan. Surface the branch state and the `requesting-code-review` / PR decision to the user. PR closes #134 (both parts); #142 and #146 remain open follow-ups.

---

## Self-Review

**1. Spec coverage:** shared `resolve_components` w/ both knobs → Task 2; `realpath` byte-for-byte unchanged (`(true,false)`) → Tasks 1+2 (characterization + refactor); `resolve_stat`/`stat_path` intermediate resolution → Task 3; `resolve_lstat`/`lstat_path` intermediate-not-terminal + Part 1 preserved → Task 4; per-component + per-symlink-target `/proc` gate, dynamic "terminal" via `pending.is_empty()`, SYMLOOP EINVAL, non-regression locks, trailing-slash #146 residual → Task 5; DoD verification → Task 6. ENOENT/ENOTDIR/relative-target/`.`/`..` are inherited unchanged from `resolve_realpath`'s body (moved verbatim into `resolve_components`) and guarded by the unchanged existing `stat_*`/`lstat_*`/`realpath_*` suites every task. All spec sections covered.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has an exact command + expected result. Task 5's RED (`stat_intermediate_crosspid_proc_gate_is_per_component`) is a single unambiguous test that distinguishes per-component from final-path-only gating using only `/proc`+`/proc/2` directory semantics (no `/proc/<pid>/cwd` symlink assumption); the broad stat+lstat+root coverage is a separate GREEN test added in Step 4 after the gate exists.

**3. Type consistency:** `resolve_components(k, caller_pid: u32, cwd: &[u8], path: &[u8], follow_terminal: bool, authorize_each: bool) -> Result<Vec<u8>, i32>` is used identically in `PathResolver::realpath` (true,false), `resolve_stat` (true,true), `resolve_lstat` (false,true). `stat_path`/`lstat_path` convert `Err(errno: i32)` via `-(errno as i64)`, matching the existing `realpath` dispatch (`fs.rs:427`). `PathResolver::new(k, caller_pid)` and `use crate::path::PathResolver;` already exist in `fs.rs`. Helpers `split_components`/`join_components`/`append_rest`/`absolute_from_cwd`/`proc_self_rewrite` are existing `path.rs` free fns reused unchanged. `k.publish_proc_snapshots()` / `k.can_read_proc_path(caller_pid, &[u8]) -> bool` signatures match `kernel.rs:1375/1396`. Consistent throughout.
