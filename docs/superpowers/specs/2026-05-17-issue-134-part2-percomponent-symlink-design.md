# Issue #134 Part 2 — per-component symlink resolution for stat() and lstat()

Sub-slice of the full-parity initiative (tracking #52, umbrella #57); part of
the #71 holistic follow-up. Closes the second residual of **#134** (Part 1 —
`lstat` `st_size` — already fixed in commit `d759965` on this branch). Off
`main`; no new syscalls / ABI method-ids. Single-crate (`yurt-kernel-wasm`).

## Problem

POSIX resolves symlinks in **every intermediate** path component; only the
**terminal** component differs between `stat` (follow) and `lstat` (no-follow).

`stat_path` and `lstat_path` (`packages/kernel-wasm/src/dispatch/fs.rs`) do
**not** resolve intermediate symlink components:

- `lstat_path` calls `normalize_readable_path` → `PathResolver::normalize` →
  `normalize_lexical_path` (`path.rs:97`), which is purely lexical (`.`/`..`
  only, no `readlink`).
- `stat_path` additionally calls `follow_symlinks` (`fs.rs:225`), which loops
  `readlink` on the **whole** path — i.e. it only follows when the *final*
  component is a symlink; it never resolves an intermediate one.

So `stat`/`lstat` of `/a/symlinkdir/b` does not traverse `symlinkdir`.
Provenance: pre-existing limitation inherited from #67's `stat`; #81/#120 kept
`lstat` consistent with it (did not introduce or widen it).

### The issue text's "VFS-wide change" framing is over-scoped

#134 says Part 2 needs "a per-component walk with a dir-handle API across every
backend — overlaps the #59 dirfd inode-anchoring track. Not a point fix in
dispatch." Verified against the code, that is inaccurate:

- `path.rs:resolve_realpath` (`path.rs:125`) **already implements faithful
  POSIX per-component resolution today**: a component loop, per-candidate
  `readlink`, relative-target join against resolved-so-far, `.`/`..`, ENOTDIR,
  ENOENT, and the 40-hop SYMLOOP limit. It uses only `vfs.readlink` +
  `vfs.entry_type` — both on the **base `VfsBackend` trait on `main`**,
  implemented by every backend. No `dir_inode`/`resolve_at`/dir-handle API.
- PR #63's inode-anchored `openat` walk **deliberately punts symlink
  components back to this same centralized path resolver** (`resolve_at` →
  `(None, 7)` → reconstruct absolute + delegate to `sys_open`, keeping "the
  40-hop SYMLOOP logic centralized, not duplicated"). #63 therefore does
  **not** itself fix Part 2, and Part 2 needs **none** of #63's mechanism.

Part 2 is a dispatch/path-resolver change, mechanism-independent of #59/#63.

## Scope

In scope: `stat_path` and `lstat_path` only (exactly what #134 Part 2 names).

Out of scope, tracked separately:

- `sys_open`/`sys_openat` and every other `normalize_readable_path` consumer
  (`mkdir`, `rmdir`, `readdir`, `unlink`, `readlink`, `chmod`, `chown`,
  `chdir`, and `PathResolver::normalize` link-name users) share the identical
  intermediate-symlink residual → **issue #142** (blocked on this; sequenced
  after #134 and #63).
- `realpath` semantics are deliberately **unchanged** (see Non-goals).
- #69 ELOOP-vs-EINVAL retarget — orthogonal; match whatever the base does.
- The dirfd inode-anchoring rewrite — #59 / PR #63.

## Approach (A: shared mode-parameterized resolver)

Generalize `resolve_realpath`'s core into one resolver shared by
`realpath` + `stat` + `lstat` — one SYMLOOP/`.`/`..`/auth implementation, no
drift (the same "shared so semantics cannot drift" principle by which #80
shares `follow_symlinks` between `open` and `stat`).

### 1. `path.rs` — shared core

```rust
fn resolve_components(
    k: &mut Kernel,
    caller_pid: u32,
    cwd: &[u8],
    raw_path: &[u8],
    follow_terminal: bool,
    authorize_each: bool,
) -> Result<Vec<u8>, i32>      // positive errno, as resolve_realpath today
```

Behaviorally identical to today's `resolve_realpath` except for two knobs:

- **`follow_terminal`** — `true`: `readlink` the final component too (current
  realpath/stat behavior; final target must exist or `ENOENT`). `false`:
  resolve and follow every component **except** the terminal; the terminal
  name is appended to the fully-resolved parent **without** `readlink`-ing it.
  The terminal must still exist *as an entry* (`entry_type != 0`); a dangling
  terminal symlink counts as existing (filetype 7) and is **not** `ENOENT`.
- **`authorize_each`** — `true`: `k.publish_proc_snapshots()` then
  `k.can_read_proc_path(caller_pid, cand)` at **every** resolved component
  candidate **and** every symlink-target re-entry; on deny return `EPERM`.
  The terminal candidate is authorized **even in `follow_terminal=false`
  mode**, so a direct `lstat("/proc/<other-pid>/x")` stays gated exactly as
  today's single `normalize_readable_path` gate. `false`: no per-component
  gate (today's `resolve_realpath`).

`resolve_realpath` is reduced to a thin caller:
`resolve_components(k, caller_pid, cwd, p, /*follow_terminal*/ true,
/*authorize_each*/ false)` — **byte-for-byte unchanged** outcomes for
`realpath` (it keeps its existing single post-resolution gate at
`fs.rs:430`). `caller_pid` is threaded into `resolve_realpath`/
`PathResolver::realpath` (currently absent) but unused when
`authorize_each=false`.

Two new `PathResolver` methods mirroring `normalize`/`realpath`:

- `resolve_stat(raw)`  = `proc_self` rewrite + cwd join +
  `resolve_components(.., follow_terminal=true,  authorize_each=true)`
- `resolve_lstat(raw)` = `proc_self` rewrite + cwd join +
  `resolve_components(.., follow_terminal=false, authorize_each=true)`

(`proc_self_rewrite` + `absolute_from_cwd` are the existing `path.rs` helpers
already used by `PathResolver::realpath`.)

### 2. `dispatch/fs.rs` — wiring

- `stat_path`: replace `normalize_readable_path(..)? ; follow_symlinks(..)?`
  with `PathResolver::new(k, pid).resolve_stat(raw)`; `Ok(p)` →
  `write_stat_record(k, &p, response)`, `Err(e)` → `-(e as i64)`.
- `lstat_path`: replace `normalize_readable_path(..)?` with
  `PathResolver::new(k, pid).resolve_lstat(raw)`; same `Ok`/`Err` shape.
- `write_stat_record`, `follow_symlinks`, `normalize_readable_path`, and every
  other call site are **untouched** → `sys_open`, `realpath`, and #134 Part 1
  are unaffected.

### 3. Invariants preserved / strengthened

- **Part 1 intact:** `lstat` of a terminal symlink still types it 7 and
  reports `st_size` = target length (`resolve_lstat` does not follow the
  terminal; `write_stat_record` unchanged).
- **stat unchanged where it already worked:** terminal follow, multi-hop
  terminal chain, dangling-terminal → `ENOENT`.
- **Authorization strengthened:** the per-component gate generalizes the
  per-hop gate `follow_symlinks` does today (via re-`normalize`) to *every*
  component — an intermediate symlink into `/proc/<other-pid>` is now gated
  for `stat`/`lstat` (was an oracle gap). Defense-in-depth.
- **SYMLOOP:** `hops > 40 → EINVAL`, matching `resolve_realpath` /
  `follow_symlinks` on the base.

### POSIX edge semantics (explicit, to remove ambiguity)

- Empty path / embedded NUL → `EINVAL` (kept from `resolve_realpath`).
- `/` (no terminal component) → `/`; `write_stat_record("/")` → directory,
  both modes.
- Intermediate component missing → `ENOENT`; intermediate component exists but
  is not a directory (and not a symlink that resolves to one) → `ENOTDIR`
  (kept from `resolve_realpath`'s `!pending.is_empty() && ty != 3`).
- `lstat` terminal `.`/`..` and trailing `/`: lexical reduction makes the
  effective terminal `.`; `.` is never a symlink, so it is "not followed"
  trivially and resolves to its (followed) parent dir — POSIX-consistent with
  trailing-slash forcing directory semantics. No special-casing needed.
- Relative intermediate symlink target → joined against resolved-so-far (kept
  from `resolve_realpath`).
- `lstat` of a dangling terminal symlink → reported as the link (filetype 7),
  never `ENOENT` (preserved by the `follow_terminal=false` "exists as entry"
  rule + existing `lstat_on_dangling_symlink_reports_the_link`).

## #59 / PR #63 coordination

Independent off `main` (this worktree, `worktree-issue-134-lstat-stsize`); no
#63 mechanism dependency. Seam overlap only: #63 also edits `path.rs`/
`dispatch/fs.rs` (adds a `PathResolver` cwd-refresh) and routes its
inode-anchored `openat` symlink-fallback through this centralized resolver.
Consequence: once Part 2 lands, #63's `openat` intermediate symlinks inherit
per-component faithfulness automatically. Whichever PR merges first, the other
takes a small additive 2-file (`path.rs`, `fs.rs`) union rebase — the
project's documented slice-rebase pattern. #142 is sequenced after both.

## Testing (TDD red → green)

Order: **characterize `realpath` first** (lock current behavior so the
refactor is provably non-regressing), then red→green the new behavior.

Realpath characterization (must stay green through the refactor):
- existing `realpath_follows_symlink_components_and_parent_traversal` and any
  other `realpath_*` tests; add a characterization test asserting a
  cross-pid `/proc` intermediate symlink in `realpath` behaves **exactly as
  today** (proves `authorize_each=false` keeps realpath unchanged).

`stat` (RED then GREEN):
- intermediate symlink-to-dir traversal: `/a/symdir/f` where `symdir`→real
  dir containing `f` → S_IFREG.
- multi-hop intermediate chain; relative intermediate target.
- intermediate dangling symlink → `ENOENT`; intermediate non-dir → `ENOTDIR`.
- unchanged: `stat_follows_symlink_*`, `stat_on_dangling_symlink_is_enoent`,
  `stat_follows_multi_hop_symlink_chain` stay green.

`lstat` (RED then GREEN):
- intermediate symlink-to-dir traversal, terminal symlink **not** followed:
  `/a/symdir/sl` → filetype 7 + Part 1 `st_size` (target length).
- intermediate dangling → `ENOENT`; intermediate non-dir → `ENOTDIR`.
- unchanged: all `lstat_*` and the Part 1
  `lstat_symlink_st_size_is_target_path_length` /
  `lstat_does_not_follow_symlink_to_regular_file` stay green.

Security (RED then GREEN), both `stat` and `lstat`:
- an **intermediate** symlink into `/proc/<other-pid>/…` → `EPERM` for a
  non-root caller (mirrors `proc_other_pid_open_gate_survives_symlink_
  resolution`); root still permitted.

SYMLOOP:
- an intermediate symlink cycle → `EINVAL` (40-hop), for both.

Gate: `cargo test --lib -p yurt-kernel-wasm` all green, `cargo fmt --check`
clean, `cargo clippy -p yurt-kernel-wasm --lib --tests -- -D warnings` clean.
Single crate, so the changed-crate pre-commit clippy hook suffices; no
cross-crate run needed.

## Non-goals

- Changing `realpath` semantics. The shared core preserves its exact current
  behavior (`authorize_each=false`; realpath keeps its single post-check).
  Realpath's lack of a *per-component* `/proc` gate is a pre-existing,
  separate hardening question — explicitly **not** addressed here to keep this
  slice tight and provably non-regressing.
- `sys_open` / other `normalize_readable_path` consumers → #142.
- dirfd inode-anchoring → #59 / PR #63.
- New syscalls / ABI method-ids / `host_*` surface changes.
- #69 ELOOP errno retarget.

## Sequencing / DoD

Single PR off `main`. Internal order (each its own red→green commit):

1. Characterization tests for `realpath` (green on base).
2. Extract `resolve_components`; `resolve_realpath` becomes the
   `(true, false)` caller; thread `caller_pid`. Realpath tests stay green.
3. `follow_terminal` knob + `PathResolver::resolve_stat`; wire `stat_path`;
   stat tests red→green; stat regression tests stay green.
4. `resolve_lstat` (`follow_terminal=false`); wire `lstat_path`; lstat tests
   red→green; lstat + Part 1 tests stay green.
5. `authorize_each` per-component gate; security tests red→green.
6. SYMLOOP intermediate-cycle test green; full gate.

**DoD:** `stat`/`lstat` resolve symlinks in every intermediate component;
terminal still differs (stat follows, lstat doesn't, Part 1 size intact);
intermediate `/proc/<other>` gated; intermediate SYMLOOP→EINVAL; all
pre-existing stat/lstat/realpath/Part-1 tests green; `fmt`+`clippy -D
warnings` clean. CI-green & marked ready when scope complete; humans
review/merge (never self-merged — per project policy).
