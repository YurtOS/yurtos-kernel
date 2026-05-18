# #93 — File-backed `mmap`/`munmap`/`mprotect`/`msync`: tiered design

**Status:** Design recorded (rev7) — **supersedes the recommendation half of [#187](https://github.com/YurtOS/yurtos-kernel/pull/187)** (`2026-05-17-…`, header amended to defer here). The **tiered *decision*** (§9-A) is ready for maintainer ratification now; the **Tier-A *program*** (§9-B) is a separate, larger ratification. No code in this PR (#93 = decision first; brainstorming gate forbids implementation before an approved spec). Part of #83; refs #52, #71, #65, #97, #129/#168/#172, #218.

> #187 framed it binary: (a) descope, or (b) emulate-by-copy. This keeps copy-emulation as the **universal floor** (Tier B) and adds **Tier A**: lazy, zero-copy content delivery on native runtimes where the embedder owns the *user* instance's linear memory. Two live tiers. A third — **A′** (zero-copy view of resident ramfs/tmpfs) — is **not implementable under today's sandbox** and is deferred to a separate decision (Appendix A′ / #218).

---

## 1. Problem & why a single answer is wrong

A `wasm32` guest has one runtime-owned linear memory and no MMU. "Real `mmap`" = (1) **projection** (file bytes guest-addressable without a copy); (2) **MMU semantics** (lazy fault, COW, enforced `PROT_*`, `MAP_SHARED` coherency); (3) an **IO substrate**. Reachability of (1)/(2) depends on *who owns the linear memory* and *what backs the OFD* — hence tiered.

### 1.1 Dead ends (considered & rejected — recorded so they are not re-derived)

- **Host `mmap` projected into linear memory, generically.** A `WebAssembly.Memory` is one engine-owned contiguous buffer; nothing splices a foreign host mapping into a sub-range. Dead wherever the engine owns the allocation (all browsers). Not dead when the embedder owns it — Tier A.
- **Multi-memory.** Rejected on three non-stale grounds: (i) LLVM has flag + MC/back-end only ([D158409](https://reviews.llvm.org/D158409)) — **no C-frontend / address-space lowering**, so transparent C use needs an LLVM fork, not our clang wrapper; (ii) each memory is still its own engine buffer (no host aliasing); (iii) memory is chosen by a **static instruction immediate**, never by pointer bits. (Multi-memory has shipped in current engines incl. Safari ≥18; availability is *not* part of the reasoning — it still does not help, for (i)–(iii).)
- **memory64 + fat/tagged pointers.** memory64 only widens the address operand; adds no memory selector to the pointer. A `[mem-index:offset]` fat pointer is a software-dispatch ABI (software MMU), same LLVM-fork cost, still no aliasing/MMU. Rejected as a *projection* mechanism; memory64 survives only as an orthogonal **arena-size lever** (§4/M2).

**Conclusion:** copy-emulation is the universal floor; real zero-copy `mmap` is reachable only where the embedder owns the *user* memory (Tier A).

---

## 2. Architecture — one ABI; selection in `kernel.wasm`, mechanism split

**The kernel→host ABI family already exists and is the right foundation — but the *specific* primitives this design needs are ENOSYS stubs today.** `packages/kernel-wasm/src/kh.rs` is headed `//! Kernel→Host imports (kh_*)` and declares **~37** distinct `kh_*` imports; `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs:885` (`kernel_host_interface_serves_kh_call_during_kernel_dispatch`) exercises the trampoline **in both directions**. So the *direction* and *family* are proven and trampoline-tested — Tier A is **one new `kh_mmap_*` import in an existing family, not a new control-flow direction**.

**Honest cost statement (B1) — runtime-divergent, with a security gap.** The cross-instance copy primitive Tier B needs — `kh_process_mem_write`/`_read` — is **not uniformly available, and its policy gating is inconsistent across runtimes**:
- **wasmtime host:** declared but **unimplemented** — `packages/kernel-wasm/src/kh.rs:1059/1065/1073` are `#[allow(dead_code)]`; host side `packages/runtime-wasmtime/src/kernel_host_interface.rs:4685/4700/4715` is *policy-check (`may_process_memory`, `:493/4692`) → `-EACCES`* then **`-ENOSYS`** (no copy).
- **JS host:** **already implemented** — `packages/kernel-host-interface-js/mod.ts:3048/3054` wire `kh_process_mem_read/write` to `processEngine.memRead/memWrite` (copies at `:2184/2201`) — **but with no policy gate**: the JS `PolicyEnforcer` (`mod.ts:313`) has **no `mayProcessMemory`** counterpart to the Rust hook. That is a **cross-runtime security divergence** ([[project_policy_enforcer]]: the gate must be the same shape on Rust + JS).

So the floor's slice-1 work is two-pronged and *not* "reuse the read path": **(a)** implement the wasmtime host copy (currently `-ENOSYS`); **(b)** add the missing **`mayProcessMemory` hook to the JS `PolicyEnforcer`** so the universal floor has non-divergent security. Read-style syscalls do not transit this primitive today. Slice-1 risk/timeline reflect both prongs.

The design splits:

**(A) Tier *selection* — pure, in `yurt-kernel-wasm`, unit-testable.** A `MmapSelector`: `runtime-capability × OFD-backing × fd-mode → tier + errno gating`, plus per-process arena bookkeeping and `MmapTable`. No host access, deterministic, unit-tested without a runtime.

**(B) Tier *mechanism*:**
- **Tier B (universal floor)** runs in `kernel.wasm`; it populates the chosen arena range by **implementing and then invoking `kh_process_mem_write(user_handle, guest_addr, bytes)`** (today `-ENOSYS`; slice 1 wires its host side in `runtime-wasmtime` and the dead-code Rust wrapper). Reads come from the synchronous OPFS substrate / VFS read path.
- **Tier A (native only)** runs in `runtime-wasmtime` via a **new `kh_mmap_*` import** (typed, no-JSON, same `kh_*` family/trampoline). Only the embedder can issue host `mmap(MAP_FIXED)` into the user-instance arena it owns.

Selection (analogue of Linux per-fs `f_op->mmap` dispatch):

| OFD backing | Embedder owns the *user* instance memory (native) | Engine owns memory (all browsers) |
|---|---|---|
| Real host fd (host-fs, on-disk image) | **Tier A** — embedder host `MAP_FIXED` overlay | **Tier B** — copy |
| In-wasm-resident (ramfs/tmpfs, resident layers) | **Tier B** — copy¹ | **Tier B** — copy¹ |
| Remote/lazy (S3, network VFS) | **Tier B** — copy + cap | **Tier B** — copy + cap |
| Socket/pipe/char-special | `ENODEV` | `ENODEV` |

¹ ramfs/tmpfs bytes live in **kernel** linear memory; the sandbox forbids the guest addressing it (Appendix A′). Tier-B copy everywhere; A′ gated on #218.

Every `mmap` of a file is an outside-world crossing → `PolicyEnforcer` gate before any mechanism. One ABI; selection/dispatch internal.

```
guest mmap() → libc shim (thin marshaller, no logic) → SYS_mmap (no JSON)
  → kernel.wasm:  PolicyEnforcer gate
                  MmapSelector → tier + arena addr + MmapTable entry
       ├─ Tier B  → kernel calls kh_process_mem_write  [NEW: ENOSYS today]
       └─ Tier A  → NEW kh_mmap_* import (existing kh_* family/trampoline)
                    → runtime-wasmtime: host mmap(MAP_FIXED) into the
                      embedder-owned USER-instance arena
```

---

## 3. The ABI primitive (typed, no JSON, WASI-#304-shaped)

WASI [issue #304](https://github.com/WebAssembly/WASI/issues/304) independently converged on this shape. Five `SYS_*` imports; `abi/src/yurt_mman.c` today is **`ENOSYS` for `mmap`/`munmap`/`mprotect`/`msync`** while **`madvise`/`posix_madvise` already implement a real advice-switch** (kept as bookkeeping per §5 — *not* an ENOSYS replacement). The C shim becomes a pure marshaller — no logic (project rule):

```
sys_mmap(addr:u32, len:u32, prot:i32, flags:i32, fd:i32, offset:i64) -> i64
sys_munmap(addr:u32, len:u32)                                        -> i32
sys_mprotect(addr:u32, len:u32, prot:i32)                            -> i32
sys_msync(addr:u32, len:u32, flags:i32)                              -> i32
sys_madvise(addr:u32, len:u32, advice:i32)                           -> i32
```

**Two surfaces.** *libc* = bit-for-bit POSIX `mmap(2)` (`MAP_FAILED`+`errno`). *Kernel ABI* = syscall-shaped: `sys_mmap` returns **i64** (`>=0` guest ptr, `<0` negated errno). Shim: `<0 → errno=-ret; return MAP_FAILED;`. *(Sign boundary verified: max u32 guest ptr < i64 sign bit; the `-1..-4095` errno band cannot alias a valid arena address.)*

**Wart not copied.** Linux's real syscall is `mmap2` (offset in 4 KiB pages, a 32-bit-register hack). We take `offset` as **raw bytes in i64** (the `mmap(2)` function contract) — wasm imports have no register constraint.

**Keystone — a per-process, embedder-reserved mmap *arena*.** For Tier A the embedder builds the *user* instance's linear memory as an `mmap`'d region + extra reserved, fully-anon-backed VA = the arena. `mmap` is an allocator within it. Structurally dissolves three #187 holes: page-aligned by construction; a dedicated arena VA range makes "is this an mmap ptr?" an O(1) range check + O(log n) interval probe; partial unmap = arena-range split.

**Arena must be hole-free (M1).** Fully **anonymous-backed** at all times. A Tier-A `MAP_FIXED` overlay *replaces* anon pages; on partial `munmap` the freed sub-range is **re-overlaid with anon**, never an OS hole — a stray guest load into a reserved-but-unmapped sub-range must not become a **native SIGSEGV in the embedder**; with anon backing it reads zero-fill (benign). (Tier B: no OS mapping; ordinary accessible linear memory.)

**Arena ↔ heap isolation is NET-NEW Rust design — contiguity is load-bearing (Issue-1 fix).** The Rust `yurt-kernel-wasm`/`runtime-wasmtime` path has **no** `brk`/`sbrk`/arena ceiling today (grep-confirmed). wasm linear memory is **contiguous from address 0**; `memory.grow` only extends the *top*. Therefore `__yurt_mmap_arena_base` is pinned **exactly at the (fixed) libc heap `brk`/`sbrk` max ceiling — zero VA gap**. A *gap* between a low pinned heap-max and a *high* arena base would be fatal: making any arena address accessible forces `memory.grow` to also make the whole gap below it accessible, ballooning accessible memory on the first `mmap` — the exact High-2b OOM. With zero gap the arena is a **contiguous bump region growing upward from the heap ceiling**: accessible size tracks the arena **high-water mark**, not a per-mapping sparse cost. Honest restatement of the cost model (supersedes any "grow exactly that range / pays nothing per mapping" phrasing): a process that **never `mmap`s pays zero** (`memory.size` stays at the heap ceiling); a process that does `mmap` pays up to its arena high-water mark (intra-arena holes from `munmap` are accessible-but-unused, reclaimable by the arena allocator, not by shrinking linear memory) — all bounded by `YURT_MMAP_ARENA_MAX`.

**Who grows the arena's *accessible* size (High-2 — ownership + ordering).** There is **no kernel→host primitive to grow user memory** (`kh_process_mem_write` only copies into already-addressable memory — and is itself ENOSYS today, B1). Only the owner of the user instance's memory can extend it:
- **Tier A (native):** the **embedder** owns it → `LinearMemory::grow_to()` (accessible `byte_size()` is distinct from `reserved_size_in_bytes`).
- **Tier B (browser / guest-owned memory):** only the **guest** can `memory.grow` its own memory. **Single-phase, guest-allocates-and-grows-then-calls (High-1 ABI fix — no `NEED_GROW` sentinel).** The earlier "two-phase / kernel returns `NEED_GROW`" idea is **withdrawn**: it had no encoding under the `>=0 ptr / <0 errno` scalar contract (and `kernel_dispatch` is the same scalar contract). Instead the **arena bump-allocator + `memory.grow` live in the safe-Rust guest helper** (the only actor that can grow guest memory; it owns the arena bump pointer as guest-side state). Flow of one `mmap`:
  1. Guest helper computes the next page-aligned arena range from its bump pointer + page-rounded `len`; checks it against `YURT_MMAP_ARENA_MAX`.
  2. Guest helper `memory.grow`s linear memory to cover the new high-water mark **before any kernel call**. If `memory.grow` fails → return `MAP_FAILED`/`ENOMEM` to the caller **without ever entering the kernel** (no kernel reservation exists → nothing to roll back).
  3. Guest helper calls `sys_mmap(addr=chosen_arena_addr, len, prot, flags, fd, offset)` — `addr` is the already-grown, already-chosen arena address (this is exactly the WASI-#304 caller-supplies-addr shape + our "`MAP_FIXED` inside the arena" capability).
  4. Kernel `MmapSelector` **validates** `addr ∈ [arena_base, arena_end)`, page-aligned, `addr+len ≤ arena_end`, overlap per the `MAP_FIXED` rule (§ below), records the `MmapTable` entry, and (Tier B) populates `[addr,addr+len)` via `kh_process_mem_write` (now addressable, since step 2 grew it). Returns `addr` or `<0` errno — **single scalar, single phase, no sentinel**.

  *Authority/robustness:* the kernel stays authoritative for safety — it validates the guest-supplied `addr` is within the arena window, page-aligned, non-overflowing, and overlap-legal before populating; a bogus/malicious `addr` is rejected (`EINVAL`), never populated. The arena *allocator* being guest-side does not weaken this (the kernel never trusts the address; `MmapSelector`/`MmapTable` remain the authority for tier/errno/range-check). **C-shim purity** ([[feedback_buffer_code_in_rust]]): C `mmap` is literally `return __yurt_mmap(addr,len,prot,flags,fd,offset);` — the whole allocate→grow→call sequence is in the safe-Rust guest helper; no branch logic in C. **Concurrency:** the guest-side bump allocator + `memory.grow` run under a guest-side lock (pthread-safe; `memory.grow` is monotonic so the high-water only rises); the kernel `MmapTable` mutation is under the existing serialized dispatch ([[project_async_dispatcher_pass]]). **Async:** if the populate read is over an async VFS (S3/network) the AsyncBridge suspend occurs in step 4 *during the kernel's VFS read*, after the guest already grew — never interleaved with growth.

  Total accessible arena is bounded by **`YURT_MMAP_ARENA_MAX` (default 256 MiB; `PolicyEnforcer` knob)**, distinct from per-mapping `YURT_MMAP_MAX_COPY` (§5); exceeding it → `ENOMEM`. No new kernel→host growth import.

`packages/kernel/src/process/loader.ts:52` ("brk/sbrk/mmap can grow up to that bound") is the **TypeScript** kernel, a *separate legacy concern*; slice 1 builds the Rust mechanism new — not "reconcile" the TS comment.

**`addr`/`MAP_FIXED` — placement, overlap-replacement, alignment (High-2 + Medium).** Under the single-phase model the guest helper always supplies an in-arena `addr`; the kernel validates it. Rules:
- **Outside the arena** (or `addr+len` past `arena_end`, or `addr` not page-aligned): **`EINVAL`** + enumerated-`UNSUPPORTED` row (cannot remap arbitrary linear memory). Address/length alignment is enforced for **`MAP_FIXED`, `munmap`, `mprotect`** too — a non-page-aligned `addr` to any of them is `EINVAL` (`len` is page-rounded-up; `len==0` for `munmap`/`mmap` is `EINVAL`).
- **In-arena, free range:** honored.
- **In-arena, overlapping an existing mapping — POSIX `MAP_FIXED` *replaces* (the prior under-spec was wrong).** The kernel performs an **atomic-under-serialized-dispatch replace** of the overlapped sub-range: (1) Tier B → if the victim is `MAP_SHARED` & dirty, shadow-diff-flush it, then drop its shadow; Tier A → host `munmap` the sub-range then **re-overlay anon** (preserves the M1 hole-free invariant); (2) **trim/split** any partially-overlapped `MmapTable` entries (reusing the §6 partial-unmap split machinery); (3) install the new mapping over the now-clean range. Sequencing (flush/drop → host-munmap → anon re-overlay → install) is mandatory and ordered. This is not a new return path — success or the errno above.

**Anonymous — private vs shared are different paths.** `MAP_ANONYMOUS`/`fd==-1`:
- **private** (`|MAP_PRIVATE`): first-class — `MmapSelector` sees `ofd=None` → arena range, **zero-fill, no `pread`**, full bookkeeping. The **only anon path in slice 1**; makes the four ENOSYS symbols functional.
- **shared** (`|MAP_SHARED`): **gated on SAB / native shared memory**, **fails visibly with `ENOTSUP`** when unavailable (§5 P1b) — implemented separately, after private-anon, never silently downgraded.

**Overflow (#65).** `offset+len`, `addr+len` via `checked_add` in safe Rust → `EINVAL`/`EOVERFLOW`, never wrap. Explicit wasm32-width guard test (kernel ships 32-bit `usize`; `cargo test` is 64-bit native — guard must exercise the 32-bit bound on a 64-bit host).

---

## 4. Tier A — embedder host `MAP_FIXED` overlay (native only)

Lazy, zero-copy content delivery. Runs in `runtime-wasmtime`, reached via the new `kh_mmap_*` import.

1. Embedder builds the *user* instance's linear memory as an `mmap`'d region + reserved anon-backed arena (§3).
2. Tier-A call for a host-fd OFD: arena picks page-aligned `[A,A+len)`; embedder calls host `mmap(host_base+A, len, PROT_READ|PROT_WRITE, MAP_FIXED | <host flags per derivation below>, host_fd, offset)` — host **prot is always RW** (P0b safety).
3. Guest load/store at `A` faults into the OS file mapping: lazy paging, real COW (`MAP_PRIVATE`), and — **only when the OFD is writable** — real `MAP_SHARED` write-back coherency; `msync`/`munmap` = host `msync`/`munmap` + arena free (freed range re-overlaid anon).

**Host flags derivation — fd-mode interaction (High-1).** Host `prot` is always RW (P0b). Host *flags* are **derived from the OFD open mode, not blind-copied** (host `MAP_SHARED|PROT_WRITE` needs a writable fd; a blind copy would `EACCES` a legitimate read-only shared map):
- guest `MAP_PRIVATE` (any prot) → host `MAP_PRIVATE` (COW; fd write-perm irrelevant).
- guest `MAP_SHARED` on a **writable** OFD (`O_RDWR`) → host `MAP_SHARED` (true coherent write-back — the §4 unique win).
- guest `MAP_SHARED|PROT_READ` on a **read-only** OFD → host `MAP_PRIVATE` (zero-copy-correct *reads*; a RO file has no write-back to honor). Lost property: cross-process visibility of any (UB) guest write → enumerated-`UNSUPPORTED`; not an error, not a host crash.
- guest `MAP_SHARED|PROT_WRITE` on a **read-only** OFD → `EACCES` at *selection* (POSIX requires it) — never reaches Tier A.

**`PROT_*` is NOT enforced — bookkeeping-only on BOTH tiers (P0b/M1).** Tier A maps host pages **RW regardless of guest `prot`**. Consequence of *that* choice: a guest *store* to its own `PROT_READ` page, or any access to a `PROT_NONE` page, **silently succeeds** (the protection is simply not enforced — an enumerated divergence). We deliberately do **not** mirror guest `prot` onto the host mapping, *because* a restrictive host `prot` would convert exactly those accesses into a **native SIGSEGV in the embedder** (there is no portable wasm host-fault→guest-fault delivery, so it could not be surfaced as a guest `SIGSEGV`/`EFAULT`) — host-RW is the lesser evil. This applies to the initial mapping `prot`, not only `mprotect`. `prot` is recorded (for `/proc`) and **never enforced** on either tier; enforcement is enumerated-`UNSUPPORTED`; a real host-fault→guest-trap mechanism is a separate future design. Therefore the honest Tier-A claim is **"lazy + COW + writable-fd `MAP_SHARED`-coherency correct; `PROT_*` recorded but unenforced (violations silently succeed)"** — *not* "full MMU-correct".

**EOF — page-level hybrid, no silent coherency loss (D + page-granularity fix).** A host file mapping accessed past the file's last page would `SIGBUS` the *embedder*. The split is **page-aligned**, so it is implementable with page-granular `mmap`/anon overlay. Let `eof_pg = round_up(file_size, page)`:
- **`[offset, min(offset+len, eof_pg))`** → **Tier A host file mapping**. This includes the last *partial* file page: the OS file mapping itself zero-fills `[file_size, eof_pg)` within that page (standard POSIX) — we add **no** anon overlay there, so the in-file bytes in that page keep full `MAP_SHARED` coherency. Nothing sub-page is hand-split.
- **whole pages `[eof_pg, offset+len)`** (exist only when `len` extends ≥1 page past EOF; if `offset ≥ eof_pg` the whole mapping) → **anon overlay**, zero-filled, no `SIGBUS`.

The whole-map is **not** downgraded to Tier B (that would silently drop the coherency Tier A exists to provide — the P1b silent-wrong class). True POSIX `SIGBUS`-past-`eof_pg` and the beyond-EOF zero-fill are enumerated-`UNSUPPORTED` rows (no guest-fault delivery).

**Scale, honestly (M2).** Lazy, no eager-copy/double-buffer — far better than Tier B for large files — but the arena lives in the user instance's single linear memory: on `wasm32` the ceiling is the ~4 GiB budget *shared with heap+stack*. `memory64` is the only lever past 4 GiB, but it is **not free and not just a flipped switch**: the §3 ABI is `u32` addr/len, so a memory64 target needs an **ABI revision** (a versioned `sys_mmap` with `u64` addr/len + the shim/selector widened). It is deliberately **not** done now (YAGNI; `wasm32` is the target) — recorded as a future ABI-breaking change, distinct from and not contingent on the §1.1 pointer-aliasing rejection.

**Per-runtime glue:** embedder must own the *user-process* instance memory — wasmtime `MemoryCreator`/`LinearMemory` (first), WasmEdge/wasmer equivalents. Engine-default/browser → probe false → Tier A never selected.

**Still enumerated-UNSUPPORTED on Tier A:** `MAP_FIXED` outside arena (`EINVAL`); RO-fd `MAP_SHARED` as private-COW; cross-*process* `MAP_SHARED` between separate user instances unless they deliberately share the host fd+mapping (#129/#168/#172); `PROT_*` enforcement; `PROT_EXEC` (inert); SIGBUS-past-EOF / tail-page zero-fill.

---

## 5. Tier B — copy-emulation + shadow-diff (universal floor; in-kernel)

All browsers, all in-wasm-resident OFDs (Appendix A′), remote/lazy OFDs anywhere. The kernel populates the chosen arena range via **`kh_process_mem_write` (slice-1-implemented; ENOSYS today — B1)**; reads via the synchronous OPFS substrate / VFS read path.

- **`MAP_PRIVATE,fd`** — arena-allocate; `pread` then `kh_process_mem_write`. **Map-time snapshot** (not lazy Linux `MAP_PRIVATE`). `len > YURT_MMAP_MAX_COPY` → **`ENOMEM`** so consumers fall back to their non-mmap reader. Writes process-local. *(The snapshot-vs-lazy divergence is itself an enumerated-`UNSUPPORTED` conformance row — parity with `MAP_SHARED` below, per the doc's classify-every-divergence rule (B-consistency).)*
- **`MAP_SHARED,fd`** — **shadow-diff writeback** (fixes #187's silent-corruption footgun). Shadow at map time; on `msync(MS_SYNC)`/`munmap`, diff current-vs-shadow, `pwrite` **only the ranges the guest dirtied**, refresh shadow. This protects only *guest-untouched* ranges from clobber; a concurrent external write **into a range the guest also dirtied is still a lost update** (last-writer-wins at write-back) — strictly weaker than coherence, consistent with "not coherent" below. **Read coherency also lost (M3):** map-time snapshot for reads too — an external writer's updates are never observed; enumerated-`UNSUPPORTED`. Not destructive, not coherent. Cost 2× region + O(len) diff; same cap.
- **`mprotect`/`madvise`** — bookkeeping/no-op (the cross-tier P0b/M1 ruling; `madvise` keeps its existing advice-switch).
- **EOF** — `pread [offset, min(offset+len, file_size))`; **zero-fill** the remainder. Deterministic, lenient — **no `SIGBUS`**; documented divergence, enumerated-`UNSUPPORTED`.

**`YURT_MMAP_MAX_COPY` — defined (C).** Default **64 MiB** per mapping; a policy knob on the embedder/`PolicyEnforcer` config (raise for trusted large-data workloads, lower for constrained sandboxes). **Scope of the "sqlite default mmap survives" promise:** only via the **bundled cooperative sqlite VFS** (windowed `xFetch`/`xUnfetch` → tiny `pread`s, never hits the cap). A statically-linked sqlite *amalgamation* that does not use our VFS gets eager-copy-up-to-cap, then `ENOMEM` → sqlite's own `read()/pwrite()` fallback (correct, just not mmap-accelerated). Python `mmap` object is method-bounded; raw-pointer Polars/Arrow `memmap2` has no hook → eager-copy-+-cap, the justification for Tier A. State this honestly rather than implying universal sqlite acceleration.

**`MAP_ANONYMOUS|MAP_SHARED` without SAB — FAIL VISIBLY (P1b).** SAB-backed *user* memory (cross-origin-isolated, or native shared) → genuinely shared, real. **No SAB/COI → `ENOTSUP` + enumerated-`UNSUPPORTED`.** Never silently substitute private storage.

**Async.** OPFS sync handles are synchronous in a Worker → the copy needs no asyncify; a Tier-B map over an async VFS (S3/network) makes `mmap` a suspending syscall riding the AsyncBridge like any blocking `kh_*`.

---

## 6. `MmapTable`, fork/exec, errno

**Per-process `MmapTable`** (in `kernel.wasm`): `Mapping { guest_addr, len, prot, flags, ofd:Option<OfdRef>, file_offset, tier:{A|B}, backing, shadow:Option<ShadowBuf>, host_map:Option<HostMapHandle> }`. Interval tree keyed by `guest_addr`. **Partial unmap/mprotect splits entries** (POSIX; glibc/musl/jemalloc rely on it) — #187 ignored this.

**Lifecycle invariants:**
1. A Mapping holds its **own OFD ref** — survives the guest `close()`.
2. Arena ranges returned on `munmap`/`exec`/exit; the arena allocator is the sole authority for "is this an mmap address".
3. **Abnormal-death teardown is RAII on the user-instance store's `Drop`, not on the destroy-handle path (E + ownership fix).** `MmapTable` lives in `kernel.wasm`, but Tier-A host VA + host fd live in the embedder. On kill/panic/abnormal termination the guest never calls `munmap` and the kernel teardown may not run. Note the current `kh_destroy_instance` path is **insufficient as the owner**: `kernel_host_interface.rs:~1002` `destroy()` only does `live_handles.remove`/`pending.remove` (handle-cache eviction); the import at `:~4670` just delegates there — it does **not** own or drop the concrete `UserProcess` store/memory. So Tier-A host mappings/fds must be **fields of the concrete user-instance store object**, released by **its `Drop`** — which runs whenever the instance/store is torn down (normal exit, `execve`, *and* kill/panic). **Open slice-4 design fork (not settled here — §9-B, not the §9-A decision):** either attach mapping ownership to that store's `Drop`, or extend the destroy path to actually own+drop the store (today it does neither) — to be decided in slice 4, not pre-judged by this spec. Either way the *invariant* is fixed: a killed process **cannot leak host VA or an fd** because dropping the store unmaps, independent of whether `kernel.wasm` or `kh_destroy_instance` runs. (Tier B has no host mapping → nothing to leak.)

**fork (M5).** `packages/kernel-wasm/src/kh.rs:1059/1065/1073` declare `process_mem_read`/`process_mem_write`/`process_resume` (`#[allow(dead_code)] // Staged … consumed when kernel-driven spawn lands`) — host side currently `-ENOSYS` (B1). Cross-instance copy is one kernel-mediated copy `process_mem_read(parent)` → `process_mem_write(child)` once implemented. At fork the kernel rebuilds the child's `MmapTable`:
- `MAP_PRIVATE`: child = parent's **current** bytes via that copy (clean pages may re-`pread`).
- `MAP_SHARED,fd` **Tier A**: child re-issues `kh_mmap_*` for the same host fd `MAP_SHARED` → genuinely OS-coherent across the fork. Unique Tier-A win.
- `MAP_SHARED,fd` **Tier B**: independent copies, converge only via file writeback — enumerated-UNSUPPORTED.
- `MAP_ANONYMOUS|MAP_SHARED`: only via a shared SAB segment; else the original map already failed (`ENOTSUP`, P1b).

fork-of-mappings is **sequenced with #168** (consumes the then-implemented staged primitives); gated, not silently partial, if it would land first.

**exec** — POSIX destroys all mappings → full teardown (embedder host-munmap Tier A via the same RAII, free arena, clear table). exec ≈ a fresh user instance → the embedder-reserved arena is **re-provisioned fresh at the new instance's init**.

**errno** (program-visible return; "enumerated-UNSUPPORTED" = conformance classification of these same cases, not an extra return path):

| errno | Condition |
|---|---|
| `EBADF` | `fd` not open (non-anon) |
| `EACCES` | `MAP_SHARED|PROT_WRITE` on read-only OFD; fd not readable; prot vs file-mode mismatch |
| `EINVAL` | `len==0` (`mmap`/`munmap`); bad `prot`/`flags` (incl. `MAP_PRIVATE`+`MAP_SHARED`); non-page-aligned `offset`; **non-page-aligned `addr` to `MAP_FIXED`/`munmap`/`mprotect`**; `MAP_FIXED` outside arena or `addr+len > arena_end`; `addr/len/offset` overflow (Linux uses EINVAL, not EOVERFLOW) |
| `ENODEV` | OFD type unmappable (socket/pipe/char-special) — Linux/FUSE-direct_io precedent |
| `ENOMEM` | arena exhausted; Tier-B `len > YURT_MMAP_MAX_COPY` (default 64 MiB, per-mapping); total accessible arena would exceed `YURT_MMAP_ARENA_MAX` (default 256 MiB, per-process) |
| `ENOTSUP` | `MAP_ANONYMOUS|MAP_SHARED` without SAB/COI (visible, not silent — P1b) |
| `EOVERFLOW` | genuine `off_t`/file-size-domain overflow only |
| *(enumerated `UNSUPPORTED` — conformance tag; return is one of the above or success-with-divergence)* | `MAP_FIXED` outside arena (`EINVAL`); `PROT_*` enforcement both tiers; RO-fd `MAP_SHARED` as private-COW; Tier-B `MAP_PRIVATE` map-time snapshot; Tier-B `MAP_SHARED` read-incoherency; SIGBUS-past-EOF (+ Tier-A tail-page zero-fill, Tier-B zero-fill); cross-process `MAP_SHARED`; anon-shared w/o SAB (`ENOTSUP`) |

---

## 7. Conformance & testing

**Corpus lift — provenance stated.** Verified **in this session via `gh api`** (tool-confirmed; a network-less reviewer cannot independently re-check): bytecodealliance and emscripten Open POSIX forks carry identical `mmap`(33)+`munmap`(7) numbered tests; **neither** ships `mprotect`/`msync` (HTTP 404 both) → those fixtures authored from scratch. Source of record = bytecodealliance fork (wasmtime-org WASI lineage); emscripten fork = cross-reference for known-wasm-runnable cases.

**Tier is config-selected at runtime** — the harness runs an explicit **matrix**, not "tag cases": `memory-ownership {embedder-owned-user-instance, engine-default} × OFD-backing {host-fd, in-wasm-resident, remote/lazy, special} × fd-mode {O_RDONLY, O_RDWR}` → each cell asserts the expected tier (§2 table) and PASS / enumerated-`UNSUPPORTED(reason)` bound to a §4–6 corner. No silent skips (#52/#97; feeds #97).

**Consumer integration proofs:** sqlite-mmap B0 zero-diff (both tiers; Tier B via the cooperative VFS — also proves the windowing component and the bundled-VFS scoping of C); Polars/Arrow small correct both tiers + **large** asserts Tier-B `ENOMEM`→identical non-mmap-fallback output, Tier A correct + memory bounded; Python `mmap` **concurrent-writer regression** (external writer touches X; guest maps, writes Y elsewhere, `msync`; assert X intact) — proves shadow-diff; **EOF test** (non-page-aligned `file_size`, `len` ≥1 page past EOF: assert the last *partial* file page reads correct file bytes **and** zero tail with `MAP_SHARED` coherency intact on Tier A, whole beyond-`eof_pg` pages zero; Tier-B zero-fill no-crash); **RO-fd `MAP_SHARED` read test** (must succeed, not `EACCES`); **arena-cap test** (a no-`mmap` process pays ~0 accessible arena; mappings beyond `YURT_MMAP_ARENA_MAX` → `ENOMEM`, not OOM); **cross-runtime policy-parity test** (`kh_process_mem_*` denied by policy must fail identically on the JS host and the wasmtime host — guards the F1 divergence); **abnormal-death test** (kill a process holding a Tier-A map; assert the user-instance store's `Drop` released host VA+fd); **`MAP_FIXED` in-arena replace test** (overlay a live mapping — incl. a dirty `MAP_SHARED` victim — assert flush→munmap→anon-overlay→install order, partial-overlap split, old contents gone, file flushed); **alignment-`EINVAL` tests** (unaligned `addr` to `MAP_FIXED`/`munmap`/`mprotect`; `len==0`); anon-shared two-pthread (real under SAB, `ENOTSUP` otherwise).

**Gates:** mandatory wasm32-width overflow tests; each slice DoD includes `cargo clippy -p yurt-kernel-wasm` (CI skips it — excluded from workspace `default-members`); `MmapSelector` pure safe Rust → unit-tested without a runtime. Every slice its own TDD PR; B0 zero-diff is the integration gate.

---

## 8. Sequencing & relationship to #187

Supersedes #187's recommendation; #187's doc header is amended with a Superseded-by banner **in this PR**. Two ratification gates (§9).

Post-ratification slices (each its own TDD PR):

1. `SYS_*` ABI + `MmapSelector` (validates guest-supplied in-arena `addr`: bounds, page-alignment, overflow, overlap) + **net-new Rust arena↔heap isolation (base = heap ceiling, zero gap) + the guest-side bump-allocator + `memory.grow` helper (single-phase, `YURT_MMAP_ARENA_MAX`-bounded; no `NEED_GROW` sentinel)** + `MAP_FIXED` in-arena replace/split + addr/len alignment errno + wasm32-width overflow tests; **private-anon** (arena/zero-fill); **implement `kh_process_mem_write` end-to-end (wasmtime host side, currently `-ENOSYS`) AND add the missing `mayProcessMemory` hook to the JS `PolicyEnforcer` (F1 security-parity)**; **Tier-B `MAP_PRIVATE`** on it; makes `mmap/munmap/mprotect/msync` functional (`madvise` unchanged).
2. Tier-B `MAP_SHARED` shadow-diff + `msync` + concurrent-writer regression + the snapshot/read-incoherency/EOF UNSUPPORTED rows.
3. Cooperative sqlite VFS (+ proves the `YURT_MMAP_MAX_COPY` bundled-VFS scoping).
4. **New `kh_mmap_*` import** + Tier A host `MAP_FIXED` overlay in `runtime-wasmtime` + per-runtime user-instance memory ownership (wasmtime first) + fd-mode flag derivation + host-RW/prot-not-enforced + **Tier-A mappings owned by the user-instance store's `Drop`** (extend the destroy path, which today only evicts the handle cache, to own/drop the store — E) + page-level EOF hybrid.
5. Open POSIX wiring + the runtime×OFD×fd-mode harness matrix + #97 UNSUPPORTED enumeration.
6. Consumer fixtures (sqlite/Polars/Python/EOF/RO-fd-SHARED/abnormal-death/anon-shared) + B0 zero-diff.
7. fork/exec mapping replay — **sequenced with #168**.

Slices 1–3 are the universal floor — but note B1: this is *building* the cross-instance copy primitive (ENOSYS today), not reusing it. Slice 4 (the real win) is one new kh_* import + embedder user-memory ownership. Slice 7 depends on #168. shared-anon (post-private-anon, SAB-gated) is folded into slice 2.

## 9. Acceptance — two gates (G)

**9-A · Tiered DECISION — ratifiable now (small; this is what #93 actually asks for):**
- [x] Recommendation recorded (rev7): Tier B universal floor + Tier A native zero-copy + A′ deferred to #218.
- [x] #187 doc header amended to defer here (this PR).
- [ ] **maintainer ratifies the tiered decision** → then mark the parity matrix "Scope changes" + #83-descope list. *This alone is sufficient to close #93's decision obligation and unblock the #83/#52 B5 gate.*
- [ ] **separate** maintainer decision **#218** (shared kernel↔user resident-file segment) — gates whether Appendix A′ ever becomes a tier.

**9-B · Tier-A PROGRAM — separate, larger ratification (does not gate #93's decision):**
- [ ] slices 1–2 — ABI/selector/arena/isolation/guest-growth; private-anon; **implement `kh_process_mem_write`**; Tier-B `MAP_PRIVATE`/`MAP_SHARED`; #65 math.
- [ ] slice 3 — cooperative sqlite VFS + `MAX_COPY` scoping proof.
- [ ] slice 4 — `kh_mmap_*` + Tier A; fd-mode derivation; embedder RAII teardown; EOF hybrid.
- [ ] slices 5–6 — Open POSIX matrix + UNSUPPORTED enumeration; consumer fixtures; B0 zero-diff; clippy clean.
- [ ] slice 7 (sequenced with #168) — fork/exec replay.

## 10. Conclusion

Copy-emulation is the **universal floor** (Tier B) — but honestly: the copy primitive it rides is runtime-divergent (wasmtime host = `-ENOSYS`; JS host = implemented but **un-policy-gated**), so the floor requires *implementing* the wasmtime copy **and** closing the JS `mayProcessMemory` security gap, then building mmap on it (not reusing an existing path). Where the embedder owns the *user* instance's linear memory (native), one new `kh_mmap_*` import in the already-trampoline-tested `kh_*` family lets the host `MAP_FIXED` the file into the reserved anon-backed arena → lazy, zero-copy delivery (Tier A) — host flags derived from fd-mode, `PROT_*` recorded but not enforced, bounded by the wasm32 4 GiB budget. Resident ramfs/tmpfs zero-copy (A′) needs a sandbox relaxation, deferred to #218. One POSIX-shaped ABI; selection pure in `kernel.wasm`; every impossible corner enumerated with a concrete program-visible errno, never silent. The **decision** (§9-A) is ready now; the **Tier-A program** (§9-B) is a separate, larger commitment.

---

## Appendix A′ — In-wasm zero-copy view (future; separately gated #218; NOT a live tier)

Guest programs and `yurt-kernel-wasm` are **separate wasm instances with separate linear memories**; ramfs/tmpfs buffers live in **kernel** memory; the I/O path copies between them *because* they are isolated. A guest zero-copy view of resident bytes would require the guest to address kernel memory — forbidden by construction. A′ **collapses into Tier B today**; no "zero-copy everywhere incl. Safari". Unlocking it needs a deliberate, designed **shared linear-memory segment** between the kernel and a specific user instance — a real sandbox-isolation relaxation with its own threat model and **its own maintainer decision (#218)**. Out of scope here. If #218 is ratified, A′ returns as a third tier; until then ramfs/tmpfs is Tier-B copy everywhere.
