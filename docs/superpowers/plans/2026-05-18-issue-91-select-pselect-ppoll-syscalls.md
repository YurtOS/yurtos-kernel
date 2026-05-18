# Issue #91 — `select` / `pselect` / `ppoll` kernel syscalls — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `select`/`pselect`/`ppoll` readiness shim boundary from guest libc into the kernel by adding three real syscalls over one shared per-fd readiness core, preserving the shipped `select` success-path behaviour exactly.

**Architecture:** A new `poll_core(k, caller_pid, &mut [WorkFd])` factors *only* the per-fd readiness loop (over the unchanged `poll_revents_for_fd`) and computes **no** count. `poll_fds` is reimplemented over it (behaviour unchanged). `sys_select`/`sys_pselect` decode a fixed packed buffer, build `WorkFd`s only for fds in ≥1 set, run `poll_core`, then do the `select`-specific fd_set transform + per-set count + first-`POLLNVAL`→`-EBADF`. `sys_ppoll` is `poll` + timespec + sigmask (same result shaping as `poll_fds`). Guest libc owns *all* marshalling (one marshaller); host transports are dumb passthroughs; sigmask + timeout are carried in the wire format but decoded-and-range-checked-only (not applied) until #90 + blocking land.

**Tech Stack:** Rust (`packages/kernel-wasm` dispatch, `wasm32-wasip1`), C guest libc shims (`abi/src`, built by `yurt-cc`), TypeScript/Deno host interfaces, TOML ABI contract + conformance specs.

---

## Context for the implementer (read before Task 1)

You have **zero assumed context**. Key facts, all verified against the tree at plan time:

1. **Line numbers in this plan and in the design spec are approximate; symbol names are load-bearing.** Always locate code by `grep`-ing the symbol, never by jumping to a line number.

2. **The shipped `select` is libc-only.** `abi/src/yurt_select.c` transforms fd_sets→pollfds in-guest and calls the existing `yurt_host_poll` import. This plan retires that transform into the kernel; the C file becomes a thin marshaller.

3. **`poll` stays exactly as-is.** `abi/src/yurt_poll.c`, the `yurt_host_poll` import, the wasmtime host-marshalled `env::sys_poll`, the kernel `poll_fds` *wire*, and `METHOD_SYS_POLL` do not change behaviour. `poll_fds` is *reimplemented over `poll_core`* with identical observable behaviour (regression-guarded by the existing poll tests).

4. **SPEC-VS-CODE DEVIATION (host transport).** The design spec says to register the new imports "alongside wherever `host_poll` is already registered" and to "anchor to the existing `host_poll` registration" on the wasmtime transport. **This is factually wrong about wasmtime.** Verified reality:
   - `host_poll` is defined **only** in the legacy TS kernel: `packages/kernel/src/host-imports/kernel-imports.ts` (`host_poll(`, ~line 1547).
   - The wasmtime runtime (`packages/runtime-wasmtime/src/kernel_host_interface.rs`) has **no** `yurt::host_poll`. Poll there rides the host-marshalled `env::sys_poll` (`SYS_NAMESPACE`, scalar args). The only `yurt`-namespace (`YURT_NAMESPACE`) registrations on wasmtime are the 7 `host_thread_*` funcs in `register_yurt_thread_imports` (~line 3414).
   - `packages/kernel-host-interface-js/mod.ts` (the kernel.wasm host-driver) currently has **no** `host_poll` either.

   The spec's *design intent* — yurt-namespace import surface, packed request/response buffer, thin passthrough, kernel does the transform — is unambiguous and internally consistent. Only the incidental "anchor to host_poll on wasmtime" hint is wrong. **This plan follows the design intent:** it registers new `yurt::host_select/host_pselect/host_ppoll` thin passthroughs in the existing `yurt`-namespace registration block on wasmtime, keeps `env::sys_poll` and the C `poll()` path untouched, and adds the matching passthroughs to the JS/Deno kernel.wasm host-driver and the legacy TS kernel. Where the spec's file-list says "alongside host_poll", read it as "alongside the existing yurt-namespace registrations / the existing readiness imports."

5. **`pselect`/`ppoll` are not declared anywhere in `abi/include/`** (verified: `grep -rn 'pselect\|ppoll' abi/include/` → no matches). The conformance canary does `#include <sys/select.h>` / `#include <poll.h>`; wasi-libc's minimal headers declare `select`/`poll` but not `pselect`/`ppoll`. The guest shim definitions therefore need visible prototypes or they compile as implicit declarations and fail `-Wall -Wextra`. This plan adds the prototypes via the yurt override-header pattern (`abi/include/poll.h` already exists and uses `#include_next`; a new `abi/include/sys/select.h` mirrors it). **Task 5 step 0 verifies whether wasi-libc already declares them and skips the header add if so.**

6. **The guest builds the wire fd_set bit-by-bit, never by struct copy.** The wire `fd_set` is a fixed **128-byte** little-endian bitmap (`uint32_t fds_bits[32]`, FD_SETSIZE 1024, fd `n` → word `n/32`, bit `n%32`). wasi-libc's in-memory `fd_set` layout is *not* relevant: the guest shim reads the caller's set with `FD_ISSET` and writes results with `FD_SET`, exactly as the retired `yurt_select.c` already does. Never `memcpy` an `fd_set` into the wire slot.

7. **errno convention.** Kernel handlers return `i64`: a non-negative success value/count, or `-(abi::ERRNO as i64)`. Guest shims turn a negative host return into `errno = -rc; return -1;`. Errno constants live in `packages/kernel-wasm/src/abi.rs` (`use crate::abi;` → `abi::EINVAL` = 22, `abi::EBADF` = 9), all `i32`.

8. **Kernel-wasm is not clippy-gated in CI** (it is excluded from workspace `default-members`). You MUST run `cargo clippy -p yurt-kernel-wasm --all-targets -- -D warnings` locally; CI will not catch it for you.

9. **`cargo test` is 64-bit native; kernel-wasm ships 32-bit `usize` (wasm32).** When writing length/overflow guards use the subtraction form (`if buf.len() < N` / `(buf.len() - N)`), never `a * b` that could overflow only at 32-bit width and pass invisibly on the 64-bit test host.

10. **Three method-id mirror sites + one drift test.** The TOML is the source of truth; `packages/kernel-wasm/build.rs` generates the kernel `METHOD_SYS_*` consts (do **not** hand-edit those). You must hand-mirror the same ids in: (a) wasmtime `mod sys_method_id`, (b) JS `export const METHOD`, and (c) the hardcoded table + consts in `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs` (`kernel_host_interface_method_ids_match_yurt_abi_methods_toml`), which is the drift guard — a mismatch there fails a test rather than shipping.

11. **B0 parity gate.** `packages/kernel/src/__tests__/parity-differ_test.ts` runs every `abi/conformance/*.spec.toml` canary case through the **TS kernel** and **kernel.wasm** and fails on any divergence not in `abi/conformance/parity-baseline.toml` (currently effectively empty besides the documented `openat_rename_stability` row). New `pselect`/`ppoll` cases must produce **identical** observable output on both kernels → the legacy TS kernel must implement the same decode+transform (Task 7). Also `packages/runtime-wasmtime/tests/fixture_parity.rs::every_sys_method_has_dispatch_or_documented_deferral` requires every `sys_*` TOML method to have a kernel dispatch arm — Tasks 3/4 add them.

12. **Worktree.** All work happens in the dedicated worktree / branch (`feat/select-pselect-ppoll-syscalls`). Commit frequently (one commit per task minimum). Never `--no-verify`. Never `git stash` (repo-global stack, shared across worktrees). Commit message footer:
    `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

## Wire formats (authoritative — copy these exactly)

All multi-byte fields little-endian, byte-packed at the stated offsets, (de)serialized field-by-field by explicit offset (never a `#[repr(C)]` overlay; `i64`s are deliberately unaligned). `fd_set` = 128 bytes (`u32 words[32]`; fd `n` → word `n/32`, bit `n%32`).

- **`sys_select` request — EXACTLY 404 B:** `u32 nfds`@0 · `i64 tv_sec`@4 · `i32 tv_usec`@12 · `u8 timeout_null`@16 · `u8 pad[3]`@17 · `fd_set readfds`@20 · `writefds`@148 · `exceptfds`@276. **Response:** `read|write|except` fd_sets, 384 B written, buffer must be ≥384. **Return:** per-set ready count, or `-errno`.
- **`sys_pselect` request — EXACTLY 412 B:** `u32 nfds`@0 · `i64 tv_sec`@4 · `i32 tv_nsec`@12 · `u8 timeout_null`@16 · `u8 sigmask_null`@17 · `u8 pad[2]`@18 · `u64 sigmask`@20 (canonical; valid iff `sigmask_null==0`) · `readfds`@28 · `writefds`@156 · `exceptfds`@284. **Response/Return:** as `sys_select`.
- **`sys_ppoll` request — 24 B header + pollfd tail:** `i64 tv_sec`@0 · `i32 tv_nsec`@8 · `u8 timeout_null`@12 · `u8 sigmask_null`@13 · `u8 pad[2]`@14 · `u64 sigmask`@16 · then `pollfd[]` (8 B: `i32 fd`,`i16 events`,`i16 revents`-ignored)@24. **Response:** records with `revents` overwritten. **Return:** poll-style positive count, or `-errno`.
- **Decode-size guards:** `sys_select` `request.len() == 404` exactly else `-EINVAL`; `sys_pselect` `== 412` exactly else `-EINVAL`; response `>= 384` else `-EINVAL`. `sys_ppoll` `request.len() >= 24` and `(request.len() - 24) % 8 == 0` else `-EINVAL`; response `>=` pollfd-records byte length else `-EINVAL`. Only the first `nfds` bits of each 128-byte set are examined.
- **`nfds` sign:** wire is `u32`; kernel authority is the upper-bound check only. `nfds > 1024` ⇒ `-EINVAL` (a guest `int nfds < 0` wraps to `u32 ≥ 0x8000_0000 > 1024` ⇒ same result).
- **Timeout range checks (decoded, range-checked, NOT applied):** `tv_sec < 0` ⇒ `-EINVAL`; `select` `tv_usec ∉ [0, 1_000_000)` ⇒ `-EINVAL`; `pselect`/`ppoll` `tv_nsec ∉ [0, 1_000_000_000)` ⇒ `-EINVAL`. `timeout_null==1` means "no timeout struct" (POSIX block-forever); today identical immediate snapshot.
- **`sigmask` canonical convention:** signal `s` ⇒ bit `s-1`. The guest sigset_t is the lossy 8-slot compact byte. Reverse slot→canonical-bit map the guest shim applies:

  | compact slot | signal(s) | canonical bit(s) set |
  |---|---|---|
  | 0 | SIGHUP(1)  | bit 0 |
  | 1 | SIGINT(2)  | bit 1 |
  | 2 | SIGQUIT(3) | bit 2 |
  | 3 | SIGTERM(15)| bit 14 |
  | 4 | SIGCHLD(17)| bit 16 |
  | 5 | SIGWINCH(28)| bit 27 |
  | 6 | SIGPIPE(13)| bit 12 |
  | 7 | SIGUSR1(10),SIGUSR2(12),SIGALRM(14) | bits 9, 11, 13 (all three — documented over-approximation) |

## File structure

| File | Responsibility | Action |
|---|---|---|
| `abi/contract/yurt_abi_methods.toml` | ABI source of truth: 3 new `[method.*]` ids + id-gap rationale + `#51`→`#57` comment fix | Modify |
| `packages/kernel-wasm/src/dispatch/mod.rs` | `WorkFd`, `poll_core`, `sys_select`/`sys_pselect`/`sys_ppoll` handlers, 3 dispatch arms, `poll_fds` over `poll_core` | Modify |
| `packages/kernel-wasm/src/dispatch/tests.rs` | Kernel unit tests (TDD) | Modify |
| `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs` | Method-id drift guard: 3 consts + 3 table rows | Modify |
| `abi/src/yurt_select.c` | Slim `select()` → 404 B marshaller → `yurt_host_select`; add `pselect()` → 412 B → `yurt_host_pselect` | Rewrite |
| `abi/src/yurt_poll.c` | Add `ppoll()` → 24 B header+tail → `yurt_host_ppoll` (poll() unchanged) | Modify |
| `abi/src/yurt_runtime.h` | 3 new `yurt_host_*` import declarations | Modify |
| `abi/include/sys/select.h` | New: yurt override header declaring `pselect` (mirrors `abi/include/poll.h`) — only if wasi-libc lacks it | Create (conditional) |
| `abi/include/poll.h` | Add `ppoll` prototype — only if wasi-libc lacks it | Modify (conditional) |
| `abi/Makefile` | (No new .c file — `pselect` lives in `yurt_select.c`, `ppoll` in `yurt_poll.c`; both already in `LIB_OBJS`) | No change |
| `packages/runtime-wasmtime/src/kernel_host_interface.rs` | 3 `sys_method_id` consts + `register_yurt_poll_imports` thin passthroughs (yurt namespace) | Modify |
| `packages/kernel-host-interface-js/mod.ts` | 3 `METHOD` consts + 3 host import passthroughs for the kernel.wasm driver | Modify |
| `packages/kernel/src/host-imports/kernel-imports.ts` | Legacy TS kernel: `host_select/pselect/ppoll` decode + fd_set transform over `pollReventsForTarget` | Modify |
| `packages/kernel/src/process/loader.ts` | Add the 3 new import names to the asyncify wrap lists (parent + child) next to `host_poll` | Modify |
| `abi/conformance/select.spec.toml` | Keep (unchanged) | No change |
| `abi/conformance/pselect.spec.toml` | New: mirror select.spec.toml | Create |
| `abi/conformance/ppoll.spec.toml` | New: mirror select.spec.toml | Create |
| `abi/conformance/c/posix-runtime-canary.c` | `case_pselect_*` / `case_ppoll_*` + sigmask regression case; register in `run_case`/`list_cases` | Modify |
| `abi/conformance/parity-baseline.toml` | Expected empty for the new cases (no new divergence rows) | Verify only |

---

## ⚠️ R5–R8 spec-reconciliation deltas (apply WITHIN the referenced task — do not skip)

This plan was drafted before spec rounds R5–R8 (spec `…/2026-05-18-select-pselect-ppoll-syscalls-design.md`, head `8bb3abae`, authoritative). **Structural note (R9):** the canonical code block in each task IS the recipe — there is no override layer. The highest-risk deltas are now **inlined directly into their target blocks** (D3+D5 → Task 5 `ppoll()` block; D6 → Task 9 Step 0; D4 → the `sys_select`/`sys_pselect` doc-strings + below). This list is an **index of what was folded where + the remaining small deltas** to apply in the named task — not a separate source of truth.

- **D1 — `_Static_assert(sizeof(fd_set)==128)` [Task 5, `abi/src/yurt_select.c`].** Beside the existing `_Static_assert(sizeof(void *) == 4, …)` add:
  ```c
  #include <sys/select.h>
  _Static_assert(sizeof(fd_set) == 128, "select ABI wire size: wasm32 fd_set must be 128 B (FD_SETSIZE 1024, 4-byte long)");
  ```
  Build pins **wasi-sdk-33** (`abi/Makefile`); this assert (compiled against the real sysroot) is the enforcement — not the inspected header.

- **D2 — C-visible request cap + Rust parity assert [Task 5 + Task 6].** In `abi/src/yurt_runtime.h` add `#define YURT_MAX_REQUEST_LEN 1048576 /* MUST equal kernel-host-interface-core MAX_GUEST_BUFFER_LEN (1 MiB); abi/Makefile pins it */`. In Task 6 add a Rust test `#[test] fn ppoll_cap_matches_c_macro(){ assert_eq!(yurt_kernel_host_interface_core::MAX_GUEST_BUFFER_LEN, 1_048_576); }` (cross-ref the C macro in a comment) so the two cannot silently drift.

- **D3 — `ppoll` pre-alloc bounding. ✅ INLINED in the Task 5 `ppoll()` block** (overflow guard + `req_len > YURT_MAX_REQUEST_LEN → EINVAL` + heap `malloc`, no `alloca`). **Still to apply in Task 6 (wasmtime) & Task 7 (JS/Deno + legacy-TS):** before `copyIn`, bound request length to `MAX_GUEST_BUFFER_LEN` → `-E2BIG`; in the **JS shim harden `len = nfds * POLLFD_SIZE`** (`len > MAX_GUEST_BUFFER_LEN → -E2BIG`, not just `Number.isSafeInteger(len)`). Kernel `(len-24)%8`/response checks stay defense-in-depth.

- **D4 — NULL-timeout never spurious `-EINVAL`. ✅ doc-strings fixed.** Kernel [Task 3/4]: tv range-check only when `timeout_null==0`. Guest shim [Task 5]: caller `timeout==NULL` ⇒ set `timeout_null=1` **and zero-fill** duration bytes. **R9 finding #4 (correction):** the `select()` shim's `nfds==0` short-circuit must **not** bypass timeout validation — shipped `yurt_select.c` validates the (present, non-NULL) timeout *before* the `nfds==0` early return, so `select(0,…,{tv_sec=-1})` must still `-EINVAL`. Keep that order (validate-when-`timeout_null==0` **then** `nfds==0` short-circuit) to stay faithful (C3) and correct. Tests [Task 3/4]: `timeout==NULL` ⇒ snapshot, never `-EINVAL`, **incl. garbage duration bytes** (M3: this garbage-bytes case is mandated and currently absent from the Task 3/4 test blocks — add it); plus `nfds==0` + invalid present timeout ⇒ `-EINVAL`.

- **D5 — wasi-sdk-33 time64 + Rust bindings. ✅ time64 INLINED** as the `__ppoll_time64` alias + verify-marker in the Task 5 `ppoll()` block (same for `pselect`→`__pselect_time64`). **Still to apply in Task 5:** add `extern "C"` bindings for `pselect` and `ppoll` to `abi/rust/crate-ports/libc-0.2.186/src/wasi/mod.rs`, mirroring the existing `select` (`:942`) / `poll` (`:895`) entries — Rust guests are in scope, not just C.

- **D6 — per-transport e2e dispatch test. ✅ INLINED as Task 9 Step 0** (concrete test + "mutate an id, confirm it fails" teeth check). The drift guard / `df5cd0d8:3460-3462` do **not** discharge it.

- **D7 — error-path response POSIX-unspecified [Task 3 tests].** Faithfulness/parity assertions are **success-path only**; on `-EBADF` the output set contents and *which* fd are unspecified — assert only `rc==-1 && errno==EBADF`, never error-path set bytes.

- **M-nits (apply in the named block, do not skip):** **M1** delete the dead `yurt_select_timeout_einval` static fn from the Task 5 Step 4 `yurt_select.c` block (C no longer range-checks timeout; it's `-Wunused-function`). **M2** in any shown Rust block, `slice[..].fill(0)` → `slice.fill(0)` (clippy `redundant_slicing` under `-D warnings`; already fixed in-tree for `select_core`). **M5** state in the C3 rationale that `nfds==0` not clearing caller fd_sets is a **known, intentional POSIX deviation** (faithful to `yurt_select.c`) so a future reader doesn't "fix" it. **M4** add a one-line note in Task 7 that the legacy-TS error-path rc (`ERR_IO` for OOB/no-kernel) diverges from the Rust kernel's `-EINVAL`/`-EFAULT` — latent parity gap, not B0-exercised (valid-buffer cases only).

---

## Task 1 — Task 9

> The full per-task recipes (each with verification commands, exact code blocks, and commit messages) live in this plan as posted by the user; see the `select-pselect-ppoll` worktree's task list. This in-repo doc captures the design intent + wire formats + file structure + R5–R8 reconciliation deltas so reviewers and follow-on agents can self-orient.

---

## Self-Review (completed by plan author)

**1. Spec coverage** — every design-spec section maps to a task:
- Problem/reframing, Goals, Non-goals → Tasks 2–4 (kernel), Task 5 (single marshaller, sigmask carried-not-applied), Context notes 3/4.
- Architecture (`poll_core` no count; per-syscall shaping; `poll_fds` over `poll_core`; select-only EBADF/count) → Tasks 2, 3, 4 (explicit "never return poll_core count for select").
- `select`/`pselect` fd_set fidelity (events/result mapping verbatim from `yurt_select.c`; `nfds==0` no-write-back; `nfds>1024`/timeout `-EINVAL`; first-POLLNVAL→EBADF; success-path byte-faithful) → Task 3 `select_core` + tests + Task 5 shim (`nfds==0` short-circuit, NULL zero-fill/no-write-back).
- Method-id gap exception + 3 mirrors + drift test + `#51`→`#57` → Task 1 (+ Task 6 wasmtime mirror, Task 7 JS mirror).
- Wire formats (404/412/24-B, offsets, decode-size guards, nfds sign, NULL-set marshalling, canonical sigmask, range checks) → "Wire formats" section + Tasks 3/4/5/7.
- Components/file structure → File-structure table; each file has an owning task.
- Testing (all enumerated unit tests incl. C1/C2/C3, exact-length rejection, negative-nfds wrap, timeout_null-vs-zero, ppoll malformed tail, sigmask compact→canonical regression; gates) → Tasks 3/4 tests, Task 8 sigmask regression case, Task 9 gates.
- Risks/mitigations → Context notes + Task 2 regression guard + Task 9 empty-baseline guard.

**2. Placeholder scan** — one intentional placeholder (`selectImpl` module-scope stub in Task 7 Step 3) is explicitly **deleted and replaced** by the real closure in Step 3a (scope reason stated). No "TBD"/"add error handling"/"similar to Task N"; every code step shows complete code.

**3. Type consistency** — `WorkFd { fd: i32, events: i16, revents: i16 }`, `poll_core(k, caller_pid, &mut [WorkFd])`, `select_core(caller_pid, request, response, set_base)`, `timeout_in_range`, `fdset_get/fdset_set`, `sys_select/sys_pselect/sys_ppoll` are used consistently across Tasks 2–4. Method consts `METHOD_SYS_SELECT/PSELECT/PPOLL` (generated) vs `sys_method_id::SELECT/PSELECT/PPOLL` (wasmtime mirror) vs `METHOD.SYS_SELECT/...` (JS mirror) — names differ by site as the real code requires; ids `0x1_00A1/A2/A3` identical everywhere.

**Known residual risk surfaced for the review checkpoint:** how the *standalone-`wasmtime`* conformance run resolves `yurt.host_*` imports was not fully traced (Task 8 Step 4 captures the exact error if it surfaces); the B0 differ (Task 9) exercises both kernels via the TS harness regardless and is the binding faithfulness gate per the design spec.
