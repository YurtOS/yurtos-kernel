# #93 — File-backed `mmap`/`munmap`/`mprotect`/`msync`: tiered design

**Status:** Design recorded (rev3) — **supersedes the recommendation half of [#187](https://github.com/YurtOS/yurtos-kernel/pull/187)** (`2026-05-17-…`, header amended to defer here). Implementation **blocked on maintainer ratification**. Part of #83; refs #52, #71, #65, #97, #129/#168/#172, #218. No code in this PR (#93 mandates "maintainer decision first"; the brainstorming gate forbids implementation before an approved spec).

> #187 framed it binary: (a) descope, or (b) emulate-by-copy. This keeps copy-emulation as the **universal floor** (Tier B) and adds **Tier A**: real, lazy, zero-copy *content delivery* on native runtimes where the embedder owns the *user* instance's linear memory. Two live tiers. A third — **A′** (zero-copy view of resident ramfs/tmpfs) — is **not implementable under today's sandbox** and is recorded only as a separately-gated future (Appendix A′ / issue #218).

---

## 1. Problem & why a single answer is wrong

A `wasm32` guest has one runtime-owned linear memory and no MMU. "Real `mmap`" = three separable sub-capabilities: (1) **projection** — file bytes guest-addressable without a copy; (2) **MMU semantics** — lazy fault-in, COW, enforced `PROT_*`, `MAP_SHARED` coherency; (3) an **IO substrate**. Reachability of (1)/(2) depends on *who owns the linear memory* and *what backs the OFD* — hence tiered.

### 1.1 Dead ends (considered & rejected — recorded so they are not re-derived)

- **Host `mmap` projected into linear memory, generically.** A `WebAssembly.Memory` is one engine-owned contiguous buffer; nothing splices a foreign host mapping into a sub-range. Dead wherever the engine owns the allocation (all browsers). Not dead when the embedder owns it — Tier A.
- **Multi-memory.** Rejected on three non-stale grounds: (i) LLVM has flag + MC/back-end only ([D158409](https://reviews.llvm.org/D158409)) — **no C-frontend / address-space lowering**, so transparent C use needs an LLVM fork, not our clang wrapper; (ii) each memory is still its own engine buffer (no host aliasing); (iii) memory is chosen by a **static instruction immediate**, never by pointer bits. (Multi-memory has in fact shipped in current engines incl. Safari ≥18; availability is *not* part of the reasoning — it still does not help, for (i)–(iii).)
- **memory64 + fat/tagged pointers.** memory64 only widens the address operand; adds no memory selector to the pointer. A `[mem-index:offset]` fat pointer is a custom software-dispatch ABI (a software MMU), same LLVM-fork cost, still no aliasing/MMU. Rejected as a *projection* mechanism; memory64 survives only as an orthogonal **arena-size lever** (§4/M2).

**Conclusion:** copy-emulation is the universal floor; real zero-copy `mmap` is reachable only where the embedder owns the *user* memory (Tier A).

---

## 2. Architecture — one ABI; selection in `kernel.wasm`, mechanism split

**The kernel→host ABI already exists and is the right foundation.** `packages/kernel-wasm/src/kh.rs` is headed `//! Kernel→Host imports (kh_*)` and declares **72** `kh_*` imports; `runtime-wasmtime/tests/kernel_wasm_trampoline.rs` exercises the trampoline **in both directions** (user→kernel via `kernel_dispatch`; kernel→host via `kh_*`, e.g. `kernel_host_interface_serves_kh_call_during_kernel_dispatch`). So Tier A is **not a new control-flow direction** — it is **one new `kh_mmap_*` import in the established, trampoline-tested `kh_*` family**. The genuinely new, hard requirement is narrower and specific: **the native embedder must own the *user* instance's linear memory well enough to host-`mmap(MAP_FIXED)` a sub-range of it** (wasmtime `MemoryCreator`/custom `LinearMemory`, WasmEdge/wasmer equivalents). Slice-4 risk should be assessed against *that*, not against an imagined missing direction.

The design splits:

**(A) Tier *selection* — pure, in `yurt-kernel-wasm`, unit-testable.** A `MmapSelector`: `runtime-capability × OFD-backing → tier + errno gating`, plus per-process arena bookkeeping and `MmapTable`. No host access, deterministic, fully unit-tested without a runtime.

**(B) Tier *mechanism*:**
- **Tier B (universal floor)** runs in `kernel.wasm`. The kernel chose the arena address, so it **pushes the initial file bytes into the user instance's arena via the staged `process_mem_write(user_handle, guest_addr, bytes)`** primitive (`kh.rs:1065`, currently `#[allow(dead_code)] // Staged wasm-engine ABI; consumed when kernel-driven spawn lands`). This is the same kh_*-family copy path read-style syscalls use to deliver bytes to a user buffer — **existing/staged, not new**. Slices 1–2 *consume* that staged primitive (status: declared, not yet wired — state honestly).
- **Tier A (native only)** runs in `runtime-wasmtime` via a **new `kh_mmap_*` import** (typed, no-JSON, in the existing `kh_*` family). Only the embedder can issue host `mmap(MAP_FIXED)` into the user-instance arena it owns.

Selection (analogue of Linux per-fs `f_op->mmap` dispatch):

| OFD backing | Embedder owns the *user* instance memory (native) | Engine owns memory (all browsers) |
|---|---|---|
| Real host fd (host-fs, on-disk image) | **Tier A** — embedder host `MAP_FIXED` overlay | **Tier B** — copy |
| In-wasm-resident (ramfs/tmpfs, resident layers) | **Tier B** — copy¹ | **Tier B** — copy¹ |
| Remote/lazy (S3, network VFS) | **Tier B** — copy + cap | **Tier B** — copy + cap |
| Socket/pipe/char-special | `ENODEV` | `ENODEV` |

¹ ramfs/tmpfs bytes live in **kernel** linear memory; the sandbox forbids the guest addressing it (Appendix A′). Tier-B copy on every platform; A′ is gated on #218.

Every `mmap` of a file is an outside-world crossing → `PolicyEnforcer` gate before any mechanism. One ABI; selection/dispatch internal.

```
guest mmap() → libc shim (thin marshaller, no logic) → SYS_mmap (no JSON)
  → kernel.wasm:  PolicyEnforcer gate
                  MmapSelector → tier + arena addr + MmapTable entry
       ├─ Tier B  → kernel populates arena via STAGED process_mem_write
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

**Two surfaces, deliberately.** *libc surface* = bit-for-bit POSIX `mmap(2)` (`MAP_FAILED`+`errno`). *Kernel ABI* = Linux/WASI-syscall-shaped: `sys_mmap` returns **i64** (`>=0` guest ptr, `<0` negated errno). Shim: `<0 → errno=-ret; return MAP_FAILED;`. *(Sign boundary verified: max u32 guest ptr < i64 sign bit; the `-1..-4095` errno band cannot alias a valid arena address.)*

**Wart not copied.** Linux's real syscall is `mmap2` (offset in 4 KiB pages, a 32-bit-register hack). We take `offset` as **raw bytes in i64** (the `mmap(2)` function contract) — wasm imports have no register constraint; the page-shift bug class does not exist for us.

**Keystone — a per-process, embedder-reserved mmap *arena*.** For Tier A the embedder builds the *user* instance's linear memory as an `mmap`'d region + extra reserved, fully-anon-backed VA = the arena. `mmap` is an allocator within it. This structurally dissolves three #187 holes: page-aligned by construction; a dedicated arena VA range makes "is this an mmap ptr?" an O(1) range check + O(log n) interval probe; partial unmap = arena-range split.

**Arena must be hole-free (M1).** The arena is **fully anonymous-backed** at all times. A Tier-A `MAP_FIXED` overlay *replaces* anon pages; on partial `munmap` the freed sub-range is **re-overlaid with anon**, never an OS hole — a stray guest load into a reserved-but-unmapped sub-range must not become a **native SIGSEGV in the embedder**; with anon backing it reads zero-fill (benign). (Tier B: no OS mapping; the arena is ordinary accessible linear memory.)

**Arena ↔ heap isolation is NET-NEW Rust design (not a TS reconciliation).** The Rust `yurt-kernel-wasm`/`runtime-wasmtime` path has **no** `brk`/`sbrk`/arena ceiling today (grep-confirmed). The arena needs a fixed high window `[__yurt_mmap_arena_base, __yurt_mmap_arena_end)` above the libc heap ceiling at link time, with the guest allocator's `brk`/`sbrk` ceiling pinned strictly below it, and arena *accessible* size grown by the kernel/embedder (Tier A: embedder `LinearMemory::grow_to()` — accessible `byte_size()` is distinct from `reserved_size_in_bytes`; Tier B: kernel grows the arena segment) **before** an address is returned. The `packages/kernel/src/process/loader.ts:52` "brk/sbrk/mmap can grow up to that bound" comment is the **TypeScript** kernel and a *separate legacy concern*; slice 1 builds the Rust-side mechanism new — it does not "reconcile" the TS comment (only note the TS path if/when it needs the parallel).

**`addr`/`MAP_FIXED`.** Non-FIXED → hint ignored, kernel returns an arena address. `MAP_FIXED` outside the arena → cannot remap arbitrary linear memory → returns **`EINVAL` to the program** *and* is recorded as an enumerated-`UNSUPPORTED` conformance row (the UNSUPPORTED tag is the conformance classification, **not** a separate return path). `MAP_FIXED` inside the arena at a free range **is** honored.

**Anonymous (single consistent path).** `MAP_ANONYMOUS`/`fd==-1` (private *and* shared) is a first-class `SYS_mmap`: `MmapSelector` sees `ofd=None` → arena range, **zero-fill, no `pread`**, full `munmap`/page-align/`MAP_FIXED`-in-arena/bookkeeping via the same `MmapTable`. The C shim still only marshals (the "is anon" branch is safe-Rust selector logic). This is what makes the four ENOSYS symbols functional. anon-shared across threads → §5.

**Overflow (#65, mandatory).** `offset+len`, `addr+len` via `checked_add` in safe Rust → `EINVAL`/`EOVERFLOW`, never wrap. Explicit wasm32-width guard test (kernel ships 32-bit `usize`; `cargo test` is 64-bit native — guard must exercise the 32-bit bound on a 64-bit host).

---

## 4. Tier A — embedder host `MAP_FIXED` overlay (native only)

Lazy, zero-copy content delivery. Runs in `runtime-wasmtime`, reached via the new `kh_mmap_*` import (existing kh_* family — §2).

1. Embedder builds the *user* instance's linear memory as an `mmap`'d region + reserved anon-backed arena (§3).
2. Tier-A call for a host-fd OFD: arena picks page-aligned `[A,A+len)`; embedder calls host `mmap(host_base+A, len, PROT_READ|PROT_WRITE, MAP_FIXED | (MAP_PRIVATE **xor** MAP_SHARED per the guest request), host_fd, offset)` — host pages are **always RW** regardless of guest `prot` (see the prot ruling below).
3. Guest load/store at `A` faults into the OS file mapping: lazy paging, real COW (`MAP_PRIVATE`), real `MAP_SHARED` write coherency; `msync`/`munmap` = host `msync`/`munmap` + arena free (freed range re-overlaid anon, §3).

**`PROT_*` is NOT enforced — bookkeeping-only on BOTH tiers (P0b/M1, corrected scope).** Tier A maps host pages **read-write regardless of the guest's `prot`**. Rationale: if the host mapping carried a restrictive `prot`, a guest *store* to a `PROT_READ` page — or *any* access to `PROT_NONE` — would raise a **native SIGSEGV in the embedder**, not a guest-visible `SIGSEGV`/`EFAULT`; there is no portable wasm host-fault→guest-fault delivery. This applies to the **initial mapping `prot`**, not only `mprotect`. So: `prot` is recorded in `MmapTable` (for `/proc` honesty) and **never enforced** on either tier; enforcement is enumerated-`UNSUPPORTED`, never silently claimed. A real host-fault→guest-trap mechanism is a separate future design (out of scope, akin to the #218 pattern).

Therefore Tier A is **"lazy + COW + `MAP_SHARED`-write-coherency correct; `PROT_*` not enforced"** — *not* "full MMU-correct". That is the honest claim.

**Scale, honestly (M2).** Tier A removes the eager-copy/double-buffer cost and is lazy — far better than Tier B for large files — but the arena lives in the user instance's single linear memory: on `wasm32` the ceiling is the ~4 GiB budget *shared with heap+stack*. `memory64` (where available; orthogonal to and not contingent on the §1.1 aliasing rejection) is the only lever past 4 GiB.

**Per-runtime glue:** embedder must own the *user-process* instance memory — wasmtime `MemoryCreator`/`LinearMemory` (first), WasmEdge custom allocator, wasmer `Tunables`. Engine-default/browser memory → probe false → Tier A never selected.

**Still enumerated-UNSUPPORTED on Tier A:** `MAP_FIXED` outside the arena (returns `EINVAL`); cross-*process* `MAP_SHARED` coherency between separate user instances unless they deliberately share the host fd+mapping (#129/#168/#172); `PROT_*` enforcement (above); `PROT_EXEC` into linear memory (inert).

---

## 5. Tier B — copy-emulation + shadow-diff (universal floor; in-kernel)

All browsers, all in-wasm-resident OFDs (Appendix A′), remote/lazy OFDs anywhere. The kernel populates the chosen arena range via the **staged `process_mem_write`** (§2); reads come from the synchronous OPFS substrate / VFS read path.

- **`MAP_PRIVATE,fd`** — arena-allocate; `pread` then `process_mem_write` into the arena. **Snapshot at mmap time** (not lazy Linux `MAP_PRIVATE`) — deterministic for read-only consumers; documented divergence. `len > YURT_MMAP_MAX_COPY` (policy) → **`ENOMEM`** so consumers fall back to their non-mmap reader. Writes process-local.
- **`MAP_SHARED,fd`** — **shadow-diff writeback** (fixes #187's silent-corruption footgun). Shadow at map time; on `msync(MS_SYNC)`/`munmap`, diff current-vs-shadow, `pwrite` **only changed ranges**, refresh shadow. Untouched bytes never written → concurrent external writers not clobbered. **Read coherency is also lost (M3):** a Tier-B `MAP_SHARED` map is a map-time snapshot for *reads too* — an external writer's later updates are **never observed** (breaks lock-/control-file polling). Behaves as a snapshot; enumerated-`UNSUPPORTED` conformance row (classification, not a separate return). Not destructive, not coherent. Cost: 2× region + O(len) diff; same cap.
- **`mprotect`/`madvise`** — bookkeeping/no-op (the cross-tier P0b/M1 ruling; `madvise` keeps its existing advice-switch behavior).

**EOF / past-end-of-file (P1a — explicit policy).** POSIX: `mmap` may extend past EOF; `[file_size, round_up(file_size,page))` reads as zero; access at/after `round_up(file_size,page)` raises `SIGBUS`. We have no guest-fault delivery (same root as P0b), so:
- **Tier B:** `pread` `[offset, min(offset+len, file_size))`; **zero-fill** the remainder of the mapped length. Deterministic and lenient — **no `SIGBUS`**; documented divergence from Linux SIGBUS-past-last-page.
- **Tier A:** a host file mapping accessed past the file's last page would `SIGBUS` the *embedder*. So when `offset+len > round_up(file_size, page)` the over-EOF span **disqualifies Tier A** → that mapping falls back to **Tier B** (zero-filled tail). If it is also over-cap/remote → `ENOMEM`/enumerated-UNSUPPORTED.
- **Conformance:** true POSIX `SIGBUS`-past-EOF is an enumerated-`UNSUPPORTED` row (no guest-fault delivery), with the zero-fill divergence written down.

**`MAP_ANONYMOUS|MAP_SHARED` without SAB — FAIL VISIBLY, do not silently degrade (P1b).** SAB-backed *user* linear memory (cross-origin-isolated, or native shared) → genuinely shared across pthreads/workers, real. **No SAB/COI → return a visible error (`ENOTSUP`) + enumerated-`UNSUPPORTED`.** Silently substituting private storage would corrupt a caller that relies on sharing (lost updates / broken synchronization) — exactly the silent-wrong-answer the spec's discipline forbids. (Removes the rev2 "degrade to private-anon with a diagnostic" and its §5/§6 inconsistency.)

**Cooperative windowing — above the seam.** A bundled custom **sqlite VFS** maps `xFetch`/`xUnfetch` to tiny windowed `pread`s through the same primitive → sqlite gets lazy, memory-bounded `mmap` even in the browser, never hitting the cap. Python's `mmap` object is method-bounded. Raw-pointer consumers (Polars/Arrow `memmap2`, parsers) have no hook → eager-copy-+-cap is the honest Tier-B answer, and the justification for Tier A.

**Async.** OPFS sync handles are synchronous in a Worker → the copy needs no asyncify; a Tier-B map over an async VFS (S3/network) makes `mmap` a suspending syscall riding the AsyncBridge like any blocking `kh_*`.

---

## 6. `MmapTable`, fork/exec, errno

**Per-process `MmapTable`** (in `kernel.wasm`): `Mapping { guest_addr, len, prot, flags, ofd:Option<OfdRef>, file_offset, tier:{A|B}, backing, shadow:Option<ShadowBuf>, host_map:Option<HostMapHandle> }`. Interval tree keyed by `guest_addr`. **Partial unmap/mprotect splits entries** (POSIX; glibc/musl/jemalloc rely on it) — #187 ignored this.

**Lifecycle invariants:** (1) a Mapping holds its **own OFD ref** — survives the guest `close()`; (2) Tier A holds an embedder host-fd handle + host VA range, released *exactly* on `munmap`/`exec`/exit (freed arena range re-overlaid anon); (3) arena ranges returned on `munmap`/`exec`/exit; the arena allocator is the sole authority for "is this an mmap address".

**fork (M5 — uses already-declared staged primitives, not a new mechanism).** `kh.rs:1059-1074` already declares `process_mem_read(handle,addr,dst)`, `process_mem_write(handle,addr,src)`, `process_resume(...)`, alongside `kh_spawn_process`/`kh_destroy_instance` — `#[allow(dead_code)] // Staged … consumed when kernel-driven spawn lands`. A cross-instance copy is **one kernel-mediated copy**: `process_mem_read(parent_handle, …)` → `process_mem_write(child_handle, …)` — *not* a bespoke "two-hop" invention. At fork the kernel rebuilds the child's `MmapTable` and re-creates each mapping:
- `MAP_PRIVATE`: child contents = parent's **current** bytes via `process_mem_read(parent)`→`process_mem_write(child)` (clean pages may instead re-`pread`; dirty pages carried via the staged primitives).
- `MAP_SHARED,fd` **Tier A**: child re-issues the `kh_mmap_*` call for the same host fd `MAP_SHARED` → genuinely OS-coherent across the fork. Unique Tier-A win.
- `MAP_SHARED,fd` **Tier B**: independent copies, converge only via file writeback — enumerated-UNSUPPORTED.
- `MAP_ANONYMOUS|MAP_SHARED`: coherent only via a shared SAB segment; else enumerated-UNSUPPORTED (and, per P1b, the original map would already have failed without SAB).

Accurate caveat: these primitives are **declared but staged (not yet consumed)** — they are wired by/with the kernel-driven spawn work. fork-of-mappings is therefore **sequenced with #168**; if it would land first it is gated, not silently partial.

**exec** — POSIX destroys all mappings → full teardown (embedder host-munmap Tier A, free arena, clear table; no host-mapping leak). exec ≈ a fresh user instance → the embedder-reserved arena is **re-provisioned fresh at the new instance's init** (per-instance, not carried across `execve`).

**errno** (the program-visible return; "enumerated-UNSUPPORTED" is the *conformance classification* of these same cases, not an extra return path):

| errno | Condition |
|---|---|
| `EBADF` | `fd` not open (non-anon) |
| `EACCES` | `MAP_SHARED` write-map on read-only OFD; fd not readable; prot vs file-mode mismatch |
| `EINVAL` | `len==0`; bad `prot`/`flags` (incl. `MAP_PRIVATE`+`MAP_SHARED` together); non-page-aligned `offset`; **`MAP_FIXED` outside the arena**; `addr/len/offset` arithmetic overflow (Linux uses EINVAL, not EOVERFLOW) |
| `ENODEV` | OFD type unmappable (socket/pipe/char-special) — mirrors Linux/FUSE-direct_io |
| `ENOMEM` | arena exhausted; Tier-B `len > YURT_MMAP_MAX_COPY`; over-EOF span that also can't fall back |
| `ENOTSUP` | `MAP_ANONYMOUS\|MAP_SHARED` without SAB/COI (visible failure, not silent degrade — P1b) |
| `EOVERFLOW` | genuine `off_t`/file-size-domain overflow only |
| *(enumerated `UNSUPPORTED` — conformance tag, return is one of the above or success-with-divergence)* | `MAP_FIXED` outside arena (`EINVAL`); `PROT_*` enforcement both tiers (success, not enforced); Tier-B `MAP_SHARED` read-incoherency (success, snapshot); SIGBUS-past-EOF (Tier-B zero-fill divergence); cross-process `MAP_SHARED`; anon-shared w/o SAB (`ENOTSUP`) |

---

## 7. Conformance & testing

**Corpus lift — provenance stated.** Verified **in this session via `gh api`** (tooling-confirmed, not merely asserted; a network-less reviewer cannot independently re-check): bytecodealliance and emscripten Open POSIX forks carry identical `mmap`(33)+`munmap`(7) numbered tests; **neither** ships `mprotect`/`msync` (HTTP 404 on both) → those fixtures are authored from scratch. Lift the bodies once; source of record = bytecodealliance fork (wasmtime-org WASI lineage); emscripten fork = cross-reference for known-wasm-runnable cases only.

**Tier is config-selected at runtime** — the harness runs an explicit **matrix**, not "tag cases": `memory-ownership { embedder-owned-user-instance, engine-default } × OFD-backing { host-fd, in-wasm-resident, remote/lazy, special }` → each cell asserts the expected tier (§2 table) and PASS / enumerated-`UNSUPPORTED(reason)` bound to a §4–6 corner. Embedder-owned×host-fd exercises Tier A; all other cells exercise Tier B / `ENODEV`. No silent skips (#52/#97; feeds #97).

**Consumer integration proofs:** sqlite-mmap `PRAGMA mmap_size` B0 zero-diff (both tiers; Tier B via the cooperative VFS); Polars/Arrow small `read_parquet(memory_map=True)` correct both tiers + **large** asserts Tier-B `ENOMEM` *and* identical non-mmap-fallback output, Tier A correct + memory bounded; Python `mmap` **concurrent-writer regression** (external writer touches X; guest maps, writes Y elsewhere, `msync`; assert X intact) — proves shadow-diff; **EOF test** (map length past EOF; assert Tier-B zero-fill, no crash; assert Tier A falls back); anon-shared two-pthread (real under SAB, `ENOTSUP` otherwise).

**Gates:** mandatory wasm32-width overflow tests; each slice DoD includes `cargo clippy -p yurt-kernel-wasm` (CI skips it — excluded from workspace `default-members`); `MmapSelector` pure safe Rust → unit-tested without a runtime. Every slice its own TDD PR; B0 zero-diff is the integration gate.

---

## 8. Sequencing & relationship to #187

Supersedes #187's recommendation; #187's doc header is amended with a Superseded-by banner **in this PR** (concrete). Tiered recommendation needs **maintainer ratification** before code; no self-merge.

Post-ratification slices (each its own TDD PR):

1. `SYS_*` ABI + `MmapSelector` + arena allocator + **net-new Rust arena↔heap isolation** + errno/overflow + wasm32-width tests; **anon (priv+shared via arena/zero-fill)**; **Tier-B `MAP_PRIVATE`** consuming the staged `process_mem_write`; makes `mmap/munmap/mprotect/msync` functional (`madvise` unchanged).
2. Tier-B `MAP_SHARED` shadow-diff + `msync` + concurrent-writer regression + read-incoherency & EOF UNSUPPORTED rows.
3. Cooperative sqlite VFS.
4. **New `kh_mmap_*` import** (existing kh_* family) + Tier A host `MAP_FIXED` overlay in `runtime-wasmtime` + per-runtime user-instance memory ownership (wasmtime first) + host-RW/prot-not-enforced + EOF fallback.
5. Open POSIX wiring + the runtime×OFD-backing harness matrix + #97 UNSUPPORTED enumeration.
6. Consumer fixtures (sqlite/Polars/Python/EOF/anon-shared) + B0 zero-diff.
7. fork/exec mapping replay — **sequenced with #168**; consumes the staged `process_mem_read`/`process_mem_write`.

Slices 1–3 are the ratifiable universal floor (Tier B = existing copy path + a staged primitive). Slice 4 (the real win) is one new kh_* import + embedder user-memory ownership — proven-precedent direction, narrow new requirement. Slice 7 depends on #168.

## 9. Acceptance mapping

- [x] maintainer **decision recommendation** recorded (rev3) — two live tiers; A′ deferred (#218). **Awaiting ratification** to mark the parity matrix + #83-descope list.
- [x] #187 doc header amended to defer here (this PR).
- [ ] (post-ratification) slices 1–2 — ABI/selector/arena/isolation; anon; Tier-B `MAP_PRIVATE`/`MAP_SHARED` via staged `process_mem_write`; #65 math.
- [ ] (post-ratification) slice 3 — cooperative sqlite VFS.
- [ ] (post-ratification) slice 4 — new `kh_mmap_*` import + Tier A; host-RW prot-not-enforced; EOF fallback.
- [ ] (post-ratification) slices 5–6 — Open POSIX matrix + UNSUPPORTED enumeration; consumer fixtures; B0 zero-diff; clippy clean.
- [ ] (post-ratification, sequenced with #168) slice 7 — fork/exec replay via staged `process_mem_*`.
- [ ] **Separate** maintainer decision — **#218** (shared kernel↔user resident-file segment) — gates whether Appendix A′ ever becomes a tier.

## 10. Conclusion

Copy-emulation is the **universal floor** (Tier B), implementable now on the existing copy path plus a *declared, staged* `process_mem_write`. Where the embedder owns the *user* instance's linear memory (native), **one new `kh_mmap_*` import in the already-trampoline-tested `kh_*` family** lets the host `MAP_FIXED` the file into the reserved anon-backed arena → lazy, zero-copy delivery (Tier A) — `PROT_*` recorded but **not enforced** (no guest-fault delivery), bounded by the wasm32 4 GiB budget (memory64 lifts that). Resident ramfs/tmpfs zero-copy (A′) is not possible under today's sandbox and is deferred to #218. One POSIX-shaped ABI; selection pure in `kernel.wasm`; every impossible corner enumerated with a concrete program-visible errno, never silent.

---

## Appendix A′ — In-wasm zero-copy view (future; separately gated #218; NOT a live tier)

Guest programs and `yurt-kernel-wasm` are **separate wasm instances with separate linear memories**; ramfs/tmpfs buffers live in **kernel** memory; the I/O path copies between them *because* they are isolated. A guest zero-copy view of resident bytes would require the guest to address kernel memory — forbidden by construction. A′ **collapses into Tier B today**; there is no "zero-copy everywhere incl. Safari". Unlocking it needs a deliberate, designed **shared linear-memory segment** between the kernel and a specific user instance — a real sandbox-isolation relaxation with its own threat model and **its own maintainer decision (#218)**. Out of scope here; must not be smuggled in. If #218 is ratified, A′ returns as a third tier; until then ramfs/tmpfs is Tier-B copy everywhere.
