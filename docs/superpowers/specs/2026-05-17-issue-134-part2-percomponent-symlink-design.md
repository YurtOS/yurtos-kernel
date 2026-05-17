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

  **"Terminal" is defined dynamically, not lexically:** a component is the
  terminal iff `pending.is_empty()` at the moment it is popped from the
  resolution queue — *not* the last component of `raw_path`. This matters
  because an intermediate symlink rewrites `pending` (its target's
  components are spliced in, `path.rs:157`), so the eventual terminal can
  come from a symlink target. Example: `lstat("/a/sl")` where `sl` →
  `/x/y`: `sl` is popped with `pending` empty → it *is* the terminal →
  `follow_terminal=false` does not follow it → `sl` reported as the link.
  But `lstat("/a/sl/z")` (`sl` → `/x/y`): `sl` is popped with `pending =
  [z]` (non-empty) → `sl` is intermediate → followed → `pending` becomes
  `[x, y, z]`, resolved cleared; later `z` is popped with `pending` empty
  → `z` is the terminal. The `follow_terminal=false` skip therefore keys
  off the live `pending.is_empty()` check inside the loop, applied to the
  non-`.`/`..` component being pushed, never a precomputed index.
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
- `.` / `..` are handled **inline in the resolution loop**, not by any
  lexical pre-pass (there is none): `.` → `continue` (skipped, never a
  candidate, never "the terminal"); `..` → `resolved.pop()` (also skipped).
  So for `lstat("/a/b/.")`, when `.` is popped (`pending` empty) it is
  `continue`d and the terminal that gets pushed is the last *real* name —
  here `b`, which was popped earlier with `pending = ["."]` non-empty, so
  `b` is **intermediate** and *is* followed if it is a symlink (POSIX:
  trailing `/.` forces the preceding symlink to be followed). The resolved
  result is the (followed) directory; `write_stat_record` types it. This is
  the genuine loop behavior — not a synthesized `.` terminal.
- **Trailing slash on a terminal symlink for `lstat` — KNOWN PRESERVED
  RESIDUAL, not POSIX-conformant (see Non-goals, issue #146).**
  `split_components` (`path.rs:74`) filters empty parts, so a trailing `/`
  is silently discarded and synthesizes no `.`. Thus `lstat("/a/symdir/")`
  (`symdir` a symlink) → `[a, symdir]`, `symdir` is the terminal in
  `follow_terminal=false` and is **not** followed: it is reported as the
  link. POSIX requires a trailing slash to force-follow the terminal
  symlink and demand a directory (`ENOTDIR` otherwise). Today's lexical
  `lstat`/`stat` already has this deviation; Part 2 **preserves** it
  unchanged (does not introduce/widen it). Tracked in **#146**; pinned here
  by a characterization test so a future fix is a deliberate, visible
  change.
- Relative intermediate symlink target → joined against resolved-so-far (kept
  from `resolve_realpath`, `path.rs:151-156`).
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

*Provenance of the #63 claims (verified, not assumed):* read against the #63
worktree `.worktrees/b2.9-openat` (branch `parity-b2.9-openat-inode-anchor`,
commit `1d4842f`) — spec
`docs/superpowers/specs/2026-05-17-b2.9-openat-inode-anchoring-design.md`
lines 69–74 (`resolve_at` returns `(None, 7)` for symlinks; "dispatch never
follows symlinks through `resolve_at`; it reconstructs the absolute path and
delegates to the existing path-based resolver") and 197–200 (symlink mid-walk
→ reconstruct-absolute + fall back to `sys_open`, "centralized 40-hop
SYMLOOP"), and the `vfs.rs` `dir_inode`/`resolve_at`/`dir_path` impls. That
commit is a moving target on an open PR; this note is coordination context,
re-verify at integration time, not a load-bearing dependency of Part 2.

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
- **per-component-auth non-regression (GREEN, must not RED):** because
  `authorize_each=true` changes `stat`/`lstat` from one final-path gate to
  per-prefix gating, a positive test that `stat`/`lstat` of `/proc/self/...`
  (own proc, multi-component) and of a deep ordinary path (e.g.
  `/a/b/c/d/e/f`, no `/proc`) **still succeed** — locks the
  strict-strengthening property so a future `can_read_proc_path` change
  cannot silently regress ordinary/self-proc resolution.

Known-residual characterization (GREEN, pins preserved behavior — #146):
- `lstat("/a/symdir/")` with a trailing slash where `symdir` is a
  symlink-to-dir → asserts the **current** (non-POSIX) behavior: `symdir`
  reported as the link (filetype 7), *not* followed. Documents the residual
  so #146's eventual fix is a deliberate, test-visible change, not an
  accident.

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
- **Trailing-slash (or trailing `/.`) forcing terminal-symlink follow + a
  directory check** → **#146**. A distinct POSIX residual, pre-existing in
  today's lexical `stat`/`lstat`; Part 2 preserves current behavior
  unchanged and pins it with a characterization test (no silent regression),
  but does not fix it — that belongs in the shared resolver later, sequenced
  after #134.
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
