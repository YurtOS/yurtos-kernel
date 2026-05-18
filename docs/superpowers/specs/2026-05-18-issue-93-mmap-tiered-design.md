# #93 — File-backed `mmap`/`munmap`/`mprotect`/`msync`: tiered design

**Status:** Design recorded — **supersedes the recommendation half of [#187](https://github.com/YurtOS/yurtos-kernel/pull/187)** (`2026-05-17-issue-93-mmap-descope-or-emulate-design.md`, header amended to defer here). Implementation **blocked on maintainer ratification**. Part of #83; refs #52, #71, #65, #97, #129/#168/#172. No code in this PR (#93 mandates "maintainer decision first"; the brainstorming gate forbids implementation before an approved spec).

> #187 framed the choice as binary: (a) descope file-backed `mmap`, or (b) emulate by copy. This keeps (b) as the **universal floor** (Tier B) and adds **Tier A**: real, lazy, zero-copy `mmap` on native runtimes where the embedder owns the *user process's* linear memory. There are exactly **two live tiers**. A third, **Tier A′** (in-wasm zero-copy view of resident ramfs/tmpfs), is **not implementable under the current sandbox model** and is recorded only as a *future, separately-gated* possibility (§Appendix A′; companion issue).

---

## 1. Problem & why a single answer is wrong

A `wasm32` guest has one runtime-owned linear memory and no MMU. "Real `mmap`" is three separable sub-capabilities: (1) **projection** — file bytes appearing in guest-addressable memory without a copy; (2) **MMU semantics** — lazy fault-in, COW, enforced `PROT_*`, `MAP_SHARED` coherency; (3) an **IO substrate** (`pread`/`pwrite`). Whether (1)/(2) are reachable is a property of *who owns the linear memory* and *what backs the OFD* — hence tiered, not global.

### 1.1 Dead ends (considered & rejected — recorded so they are not re-derived)

- **Host `mmap` projected into linear memory, generically.** A `WebAssembly.Memory` is one engine-owned contiguous buffer; nothing splices a foreign host mapping into a sub-range. Dead **wherever the engine owns the allocation** (all browsers). *Not* dead when the embedder owns the allocation — Tier A.
- **Multi-memory.** Rejected on three independent, non-stale grounds: (i) LLVM has only flag + MC/back-end infra ([D158409](https://reviews.llvm.org/D158409)) — **no C-frontend / address-space lowering**, so transparent C use needs an LLVM fork, not our clang wrapper; (ii) each memory is still its own engine buffer (no host aliasing); (iii) the memory is chosen by a **static instruction immediate**, never by pointer bits. (Browser availability is *not* part of the reasoning — multi-memory has in fact shipped in current engines incl. Safari ≥18; it still does not help, for (i)–(iii).)
- **memory64 + fat/tagged pointers.** memory64 only widens the address operand; it adds no memory selector to the pointer. A `[memory-index:offset]` fat pointer is a custom software-dispatch ABI (a software MMU), same LLVM-fork cost, still no aliasing/MMU. Rejected as a *projection* mechanism. (memory64 *does* survive as an orthogonal **arena-size lever** — see M2/§4.)

**Conclusion:** copy-emulation is the universal floor; real `mmap` is reachable only where the embedder owns the *user* memory (Tier A).

---

## 2. Architecture — one ABI; selection in `kernel.wasm`, mechanism split

`kernel.wasm` is itself a sandboxed guest: **no host syscalls, no access to the user process's linear memory**, and the existing trampoline is **user→kernel only** (bytes copied between the two isolated linear memories — see the kernel I/O trampoline). The design therefore splits cleanly:

**(A) Tier *selection* — pure, in `yurt-kernel-wasm`, unit-testable.** A `MmapSelector`: `runtime-capability × OFD-backing → tier + errno gating`, plus the per-process arena bookkeeping and `MmapTable`. No host access; no I/O; deterministic; fully unit-tested without a runtime (project rule: logic in safe Rust).

**(B) Tier *mechanism* — placement differs by tier:**
- **Tier B (universal floor)** runs **in `kernel.wasm`** over the *existing* user↔kernel trampoline copy path. This is essentially today's I/O model — which is what makes the floor implementable now.
- **Tier A (native only)** runs **in the native embedder** (`runtime-wasmtime`), invoked by a **new typed, no-JSON kernel→embedder upcall** (`kh_mmap_*`-shaped). This is a *new control-flow direction* (kernel→embedder) that the current trampoline does not have; the upcall ABI is itself part of this design and is load-bearing for slices 4. Only the embedder can (i) issue host `mmap(MAP_FIXED)` and (ii) own the *user-process* instance's linear memory.

Selection (analogue of Linux per-fs `f_op->mmap` dispatch):

| OFD backing | Embedder owns the *user* instance memory (native) | Engine owns memory (all browsers) |
|---|---|---|
| Real host fd (host-fs, on-disk image) | **Tier A** — embedder host `MAP_FIXED` overlay | **Tier B** — copy |
| In-wasm-resident (ramfs/tmpfs, resident layers) | **Tier B** — copy¹ | **Tier B** — copy¹ |
| Remote/lazy (S3, network VFS) | **Tier B** — copy + cap | **Tier B** — copy + cap |
| Socket/pipe/char-special | `ENODEV` | `ENODEV` |

¹ ramfs/tmpfs bytes live in **kernel** linear memory; the sandbox forbids the guest addressing it, so a zero-copy view is **impossible today** (see Appendix A′). Default is Tier-B copy via the kernel trampoline, on every platform.

Every `mmap` of a file is an outside-world crossing → `PolicyEnforcer` Allow/Deny gate before any mechanism. The libc shim and guest always call **one** ABI; selection/dispatch is internal.

```
guest mmap()
  → libc shim (thin marshaller, no logic)
  → SYS_mmap typed ABI (no JSON)
  → kernel.wasm:  PolicyEnforcer gate
                  MmapSelector  →  tier + arena addr + MmapTable entry
       ├─ Tier B  → in-kernel copy via existing user↔kernel trampoline
       └─ Tier A  → NEW kernel→embedder upcall (typed, no-JSON)
                    → runtime-wasmtime: host mmap(MAP_FIXED) into the
                      embedder-owned USER-instance arena
```

---

## 3. The ABI primitive (typed, no JSON, WASI-#304-shaped)

WASI [issue #304](https://github.com/WebAssembly/WASI/issues/304) independently converged on this shape (fd + caller addr/len, non-persistent). Five imports; `abi/src/yurt_mman.c` (today all `ENOSYS` stubs) becomes a pure marshaller — **no logic** (project rule):

```
sys_mmap(addr:u32, len:u32, prot:i32, flags:i32, fd:i32, offset:i64) -> i64
sys_munmap(addr:u32, len:u32)                                        -> i32
sys_mprotect(addr:u32, len:u32, prot:i32)                            -> i32
sys_msync(addr:u32, len:u32, flags:i32)                              -> i32
sys_madvise(addr:u32, len:u32, advice:i32)                           -> i32
```

**Two surfaces, deliberately.** *libc surface* = bit-for-bit POSIX `mmap(2)` (same prototype/order, `MAP_FAILED`+`errno`). *Kernel ABI* = Linux/WASI-syscall-shaped: `sys_mmap` returns **i64** (`>=0` guest ptr, `<0` negated errno; no errno-TLS). Shim: `<0 → errno=-ret; return MAP_FAILED;`. *(Sign boundary verified safe: max u32 guest ptr < i64 sign bit; the `-1..-4095` errno band cannot alias a valid arena address.)*

**Wart not copied.** Linux's real syscall is `mmap2` (offset in 4 KiB pages, a 32-bit-register hack). We take `offset` as **raw bytes in i64** (the `mmap(2)` function contract) — wasm imports have no register constraint; the page-shift bug class does not exist for us.

**Keystone — a per-process, embedder-reserved mmap *arena*.** For Tier A the embedder builds the *user* instance's linear memory itself as an `mmap`'d region **plus extra reserved, fully-anon-backed VA** = the arena. `mmap` is an allocator *within* it. This structurally dissolves three #187 holes: addresses are page-aligned by construction; a dedicated arena VA range makes "is this an mmap ptr?" an O(1) range check + O(log n) interval probe (for `munmap`/`msync`/`mprotect`, which carry no handle); partial unmap = arena-range split.

**Arena must be hole-free (M1).** The arena is **fully anonymous-backed** at all times. A Tier-A `MAP_FIXED` overlay *replaces* anon pages with the file mapping; on partial `munmap` the freed sub-range is **re-overlaid with anon**, never left as an OS hole. Rationale: a stray guest load into a reserved-but-unmapped sub-range must not become a **native SIGSEGV in the embedder** — with anon backing it reads zero-fill (benign) instead of crashing the host. (On Tier B there is no OS mapping at all; the arena is ordinary accessible linear memory.)

**Arena ↔ heap isolation contract (slice 1, load-bearing).** Arena VA is a fixed high window `[__yurt_mmap_arena_base, __yurt_mmap_arena_end)` placed **above** the libc heap ceiling at link time. The guest allocator's `brk`/`sbrk` ceiling is pinned strictly below `__yurt_mmap_arena_base`; `malloc`/heap `memory.grow` can never enter the arena. Arena *accessible* size is grown by the kernel/embedder (Tier A: embedder `LinearMemory::grow_to()` — accessible `byte_size()` is distinct from `reserved_size_in_bytes`; Tier B: kernel grows the arena segment) **before** an address is returned, so a returned pointer is always backed (no trap-on-load). The loader comment that currently treats `brk`/`sbrk`/`mmap` as one growth limit is **explicitly in scope to reconcile in slice 1**.

**`addr`/`MAP_FIXED`.** Non-FIXED → hint ignored, kernel returns an arena address. `MAP_FIXED` to an arbitrary guest address → cannot remap arbitrary linear memory → enumerated `UNSUPPORTED` (`EINVAL`). `MAP_FIXED` *inside the arena at a free range* **is** honored.

**Anonymous (M4 — single consistent path).** `MAP_ANONYMOUS`/`fd==-1` (private *and* shared) is **not** "left to libc". It is a first-class `SYS_mmap` call: `MmapSelector` sees `ofd=None` → allocate arena range, **zero-fill, no `pread`**, full `munmap`/page-align/`MAP_FIXED`-in-arena/`mprotect`-bookkeeping via the same `MmapTable`. The C shim still only marshals (the "is anon" branch is safe-Rust selector logic, not shim logic) — so the thin-C-shim rule and the bit-for-bit-POSIX claim both hold. This replaces today's blanket `ENOSYS`. `MAP_ANONYMOUS|MAP_SHARED` across threads → SAB path (§5), which requires a SAB-backed *user* linear memory.

**Overflow (#65, mandatory).** `offset+len`, `addr+len` via `checked_add` in safe Rust → `EINVAL`/`EOVERFLOW`, never wrap. Explicit wasm32-width guard test (kernel ships 32-bit `usize`; `cargo test` is 64-bit native — the guard must exercise the 32-bit bound on a 64-bit host).

---

## 4. Tier A — embedder host `MAP_FIXED` overlay (native only)

Real, lazy, MMU-correct, **zero-copy** `mmap`. Runs in `runtime-wasmtime`, reached via the §2 kernel→embedder upcall.

1. Embedder builds the *user* instance's linear memory as an `mmap`'d region + reserved anon-backed arena (§3).
2. On a Tier-A upcall for a host-fd OFD: arena picks page-aligned `[A,A+len)`; embedder calls host `mmap(host_base+A, len, prot, MAP_FIXED | (MAP_PRIVATE **xor** MAP_SHARED per the guest request), host_fd, offset)`.
3. Guest load/store at `A` faults into the OS file mapping: lazy paging, real COW (`MAP_PRIVATE`), real coherency (`MAP_SHARED`), `msync`/`munmap` = host `msync`/`munmap` + arena free (freed range re-overlaid anon, §3).

**Per-runtime glue (pluggable-runtime seam):** the embedder must own the *user-process* instance memory — wasmtime `MemoryCreator`/`LinearMemory` (first), WasmEdge custom allocator, wasmer `Tunables`. Engine-default/browser memory → probe false → Tier A never selected.

**`mprotect` is best-effort/UNSUPPORTED even on Tier A (M1).** wasm linear memory has no per-page protection enforceable *to the guest*. Host `mprotect` on the arena pages would turn a guest violation into a **native SIGSEGV in the embedder**, not a guest-visible `SIGSEGV`/`EFAULT` — there is no portable wasm "guest trap on protected page". So `mprotect` is **bookkeeping-only on both tiers** (record `prot`, no enforcement) **unless** an engine-specific host-SIGSEGV→guest-trap story is separately specified. Enforcement is enumerated-`UNSUPPORTED`, never silently claimed.

**Scale, honestly (M2).** Tier A removes the eager-copy and double-buffer cost and is lazy — far better than Tier B for large files — **but the arena lives inside the user instance's single linear memory**: on `wasm32` the mappable ceiling is the ~4 GiB budget *shared with heap+stack*, not "unbounded". `memory64` (where available; orthogonal to and not contingent on the §1.1 pointer-aliasing rejection) raises the arena ceiling and is the only lever that lets Tier A exceed 4 GiB.

**Still enumerated-UNSUPPORTED on Tier A:** `MAP_FIXED` outside the arena; cross-*process* `MAP_SHARED` coherency between separate yurt user instances unless they deliberately share the host fd+mapping (multi-process model — #129/#168/#172); `PROT_EXEC` into linear memory (inert). Host `MAP_FIXED` only ever targets the disjoint arena window; every map passes `PolicyEnforcer` first.

---

## 5. Tier B — copy-emulation + shadow-diff (universal floor; in-kernel)

Selected for **all browsers**, all in-wasm-resident OFDs (ramfs/tmpfs — see Appendix A′), and remote/lazy OFDs on any runtime. Runs in `kernel.wasm` over the existing user↔kernel trampoline.

- **`MAP_PRIVATE,fd`** — arena-allocate; eager `pread [offset,offset+len)` via the synchronous OPFS substrate / VFS read path. **Snapshot at mmap time** (not lazy Linux `MAP_PRIVATE`) — correct & deterministic for read-only consumers; documented divergence. `len > YURT_MMAP_MAX_COPY` (policy) → **`ENOMEM`** so consumers fall back to their non-mmap reader (bounded, honest, never silent). Writes process-local.
- **`MAP_SHARED,fd`** — **shadow-diff writeback** (fixes #187's silent-corruption footgun). Snapshot a *shadow* at map time; on `msync(MS_SYNC)`/`munmap`, diff current-vs-shadow, `pwrite` **only changed ranges**, refresh shadow. Untouched bytes never written → concurrent external writers not clobbered. **Read coherency is also lost (M3):** a Tier-B `MAP_SHARED` map is a map-time snapshot for *reads too* — an external writer's later updates are **never observed** (breaks lock-/control-file polling patterns). Stated explicitly; gets its own enumerated-`UNSUPPORTED` corpus case. Not destructive, not coherent. Cost: 2× region + O(len) diff; same cap.
- **`mprotect`/`madvise`** — bookkeeping/no-op (same as the cross-tier M1 ruling above).

**`MAP_ANONYMOUS|MAP_SHARED`.** SAB-backed *user* linear memory (cross-origin-isolated, or native shared) → genuinely shared across pthreads/workers, real. No SAB/COI → degrade to private-anon with a one-time diagnostic (enumerated-UNSUPPORTED for the shared semantics; chosen over hard-fail because programs use it opportunistically).

**Cooperative windowing — above the seam, not in the mechanism.** A bundled custom **sqlite VFS** maps `xFetch`/`xUnfetch` to tiny windowed `pread`s through the same primitive → sqlite gets lazy, memory-bounded `mmap` *in the browser*, never hitting the cap. Python's `mmap` object is method-bounded. Raw-pointer consumers (Polars/Arrow `memmap2`, mmap parsers) have no hook → eager-copy-+-cap is the honest Tier-B answer, and the entire justification for Tier A.

**Async.** OPFS sync handles are synchronous in a Worker → the copy needs no asyncify; a Tier-B map over an async VFS (S3/network) makes `mmap` a suspending syscall riding the AsyncBridge like any blocking `kh_*`.

---

## 6. `MmapTable`, fork/exec, errno

**Per-process `MmapTable`** (in `kernel.wasm`, next to the fd table):
```
Mapping { guest_addr:u32, len:u32, prot:i32, flags:i32,
          ofd:Option<OfdRef>, file_offset:i64,
          tier:{A|B}, backing:BackingKind,
          shadow:Option<ShadowBuf>, host_map:Option<HostMapHandle> }
```
Interval tree keyed by `guest_addr`. **Partial unmap/mprotect splits entries** (POSIX permits carving the middle; glibc/musl/jemalloc rely on it) — #187 ignored this.

**Lifecycle invariants:** (1) a Mapping holds its **own OFD ref** — survives the guest `close()` (POSIX); (2) Tier A holds an embedder host-fd handle + host VA range, released *exactly* on `munmap`/`exec`/exit (enumerated no-leak path; freed arena range re-overlaid anon); (3) arena ranges returned on `munmap`/`exec`/exit; the arena allocator is the sole authority for "is this an mmap address".

**fork (M5 — cross-instance, scoped to the process model).** fork creates a new *user instance*; copying parent's current mapped bytes is a user↔user transfer the current user↔kernel trampoline does not do. Mechanism, explicitly **kernel-mediated** and **gated on the multi-process work (#129 merged Phase1+2 / fork #168 / tracking #172)**: at fork the kernel rebuilds the child's `MmapTable` and re-creates each mapping in the child —
- `MAP_PRIVATE`: child contents = parent's **current** region bytes, transferred *user→kernel→user* (two trampoline hops, kernel-mediated; not a direct user↔user copy), i.e. clean pages re-`pread` + parent dirty bytes carried through kernel.
- `MAP_SHARED,fd` **Tier A**: child re-issues the embedder upcall for the same host fd `MAP_SHARED` → genuinely OS-coherent across the fork (file mapping is the shared substrate even with separate instances). Unique Tier-A win.
- `MAP_SHARED,fd` **Tier B**: independent copies, converge only via file writeback — enumerated-UNSUPPORTED ("not fork-coherent in memory").
- `MAP_ANONYMOUS|MAP_SHARED`: coherent only via a SAB segment both instances map; else child gets a private copy — enumerated-UNSUPPORTED.

If fork-of-mappings would land before #168, it is gated/deferred with #168, not silently partial.

**exec** — POSIX destroys all mappings → full teardown: embedder host-munmap Tier A, free arena, clear table; no host-mapping leak (invariant 2). exec ≈ a fresh user instance, so the **embedder-reserved arena is re-provisioned fresh at the new instance's init** (the init-time reservation is per-instance, not carried across `execve`).

**errno** (refines #187; adds the tier dimension; fixes the `EOVERFLOW`/`EINVAL` split):

| errno | Condition |
|---|---|
| `EBADF` | `fd` not open (non-anon) |
| `EACCES` | `MAP_SHARED` write-map on read-only OFD; fd not readable; prot vs file-mode mismatch |
| `EINVAL` | `len==0`; bad `prot`/`flags` (incl. `MAP_PRIVATE`+`MAP_SHARED` together); non-page-aligned `offset`; **`addr/len/offset` arithmetic overflow** (Linux uses EINVAL here, not EOVERFLOW) |
| `ENODEV` | OFD type unmappable (socket/pipe/char-special) — mirrors Linux/FUSE-direct_io precedent |
| `ENOMEM` | arena exhausted; Tier-B `len > YURT_MMAP_MAX_COPY`; no arena VA |
| `EOVERFLOW` | **only** genuine `off_t`/file-size-domain overflow |
| enumerated `UNSUPPORTED` | `MAP_FIXED` outside arena; cross-process `MAP_SHARED`; `mprotect` *enforcement* (both tiers); Tier-B `MAP_SHARED` read-coherency; anon-shared w/o SAB — each a written-reason conformance row (#52/#97), never a silent wrong answer |

---

## 7. Conformance & testing

**Corpus lift (verified via GitHub API):** bytecodealliance and emscripten Open POSIX forks carry **identical** `mmap`(33)+`munmap`(7) numbered tests; **neither** ships `mprotect`/`msync` (confirmed 404). Lift the bodies **once**; source of record = **bytecodealliance/open-posix-test-suite** (wasmtime-org WASI lineage). emscripten fork = cross-reference for known-wasm-runnable cases only. `mprotect`/`msync` fixtures authored from scratch (unavoidable).

**Tier is config-selected at runtime, not per-case** — so the harness must run an explicit **matrix**, not "tag cases":

`memory-ownership { embedder-owned-user-instance, engine-default } × OFD-backing { host-fd, in-wasm-resident, remote/lazy, special }`

→ each cell asserts the expected tier (per the §2 table) and PASS / enumerated-`UNSUPPORTED(reason)` bound to a §4–6 corner. Embedder-owned×host-fd exercises Tier A; every other cell exercises Tier B / `ENODEV`. No silent skips (#52/#97; feeds the #97 list).

**Consumer integration proofs (the real bar):** sqlite-mmap `PRAGMA mmap_size` B0 zero-diff (both tiers; Tier B via the cooperative VFS — proves the windowing component); Polars/Arrow small `read_parquet(memory_map=True)` correct both tiers + **large** file asserts Tier-B `ENOMEM` *and* Polars non-mmap fallback identical output, Tier A correct + memory bounded; Python `mmap` **concurrent-writer regression** (external writer touches byte X; guest maps, writes byte Y elsewhere, `msync`; assert X not clobbered) — proves shadow-diff; anon-shared two-pthread test (real under SAB/COI, enumerated-UNSUPPORTED otherwise).

**Gates:** mandatory wasm32-width overflow tests (32-bit bound on a 64-bit host; #65); each slice's DoD includes `cargo clippy -p yurt-kernel-wasm` (CI skips it — excluded from workspace `default-members`); `MmapSelector` is pure safe Rust → fully unit-tested without a runtime. Every slice its own TDD PR; B0 zero-diff is the integration gate.

---

## 8. Sequencing & relationship to #187

This **supersedes #187's recommendation**. As part of *this* deliverable, #187's doc header (`2026-05-17-issue-93-mmap-descope-or-emulate-design.md`) is amended with a "Superseded by" banner pointing here (done in this PR — concrete, not deferred). The tiered recommendation still needs **maintainer ratification** before any code; no self-merge.

Post-ratification slices (each its own TDD PR):

1. `SYS_*` ABI + `MmapSelector` + arena allocator + **arena↔heap isolation contract + loader-comment reconciliation** + errno/overflow + wasm32-width tests; **anon (private+shared via arena/zero-fill)** + **Tier-B `MAP_PRIVATE`** eager-copy; replaces `yurt_mman.c` `ENOSYS` stubs. *(Satisfies #93 acceptance on the floor.)*
2. Tier-B `MAP_SHARED` shadow-diff + `msync` + concurrent-writer regression + read-coherency UNSUPPORTED row.
3. Cooperative sqlite VFS (windowed `xFetch`) above the primitive.
4. **New typed kernel→embedder upcall ABI** + Tier A host `MAP_FIXED` overlay in `runtime-wasmtime` + per-runtime user-instance memory ownership (wasmtime first; WasmEdge/wasmer follow).
5. Open POSIX wiring + the runtime×OFD-backing harness matrix + #97 UNSUPPORTED enumeration.
6. Consumer fixtures: sqlite B0 zero-diff, Polars small+large, Python concurrent-writer, anon-shared.
7. fork/exec mapping replay — **gated on / sequenced with #168** (cross-instance kernel-mediated copy).

Slices 1–3 are ratifiable largely as-is and deliver the universal floor (Tier B is essentially the existing trampoline-copy model). Slice 4 (the real win) depends on the new upcall + embedder user-memory ownership. Slice 7 depends on #168.

## 9. Acceptance mapping

- [x] maintainer **decision recommendation** recorded — two live tiers (A native-embedder host-`MAP_FIXED`; B universal in-kernel copy+shadow-diff); A′ not implementable today (Appendix). **Awaiting ratification** to mark the parity matrix "Scope changes" + #83-descope list.
- [x] #187 doc header amended to defer here (this PR).
- [ ] (post-ratification) slices 1–2 — ABI/selector/arena/isolation-contract; anon; Tier-B `MAP_PRIVATE`/`MAP_SHARED`; C1-safe offset math (#65); replaces `ENOSYS`.
- [ ] (post-ratification) slice 3 — cooperative sqlite VFS.
- [ ] (post-ratification) slice 4 — kernel→embedder upcall + Tier A real `mmap`.
- [ ] (post-ratification) slices 5–6 — Open POSIX matrix + UNSUPPORTED enumeration; consumer fixtures; B0 zero-diff; `fmt`/`clippy -p yurt-kernel-wasm` clean.
- [ ] (post-ratification, gated on #168) slice 7 — fork/exec replay.
- [ ] **Separate** maintainer decision: "shared kernel↔user resident-file segment, yes/no" — **companion issue #218** — gates whether Appendix A′ ever becomes a tier.

## 10. Conclusion

Copy-emulation is the **universal floor** (Tier B), implementable now on the existing trampoline. Where the embedder owns the *user* instance's linear memory (native runtimes), a new kernel→embedder upcall lets the host `MAP_FIXED` the file into the reserved anon-backed arena → real, lazy, zero-copy `mmap` (Tier A), bounded by the wasm32 4 GiB budget (memory64 lifts that). Resident ramfs/tmpfs zero-copy (A′) is **not possible under the current sandbox** and is deferred to a separate architecture decision (#218). One POSIX-shaped ABI; selection pure in `kernel.wasm`; every impossible corner enumerated, never silent.

---

## Appendix A′ — In-wasm zero-copy view (future; separately gated; NOT a live tier)

**Why it is not implementable today.** Guest programs and `yurt-kernel-wasm` are **separate wasm instances with separate linear memories**; ramfs/tmpfs buffers live in **kernel** memory; the entire I/O path is a trampoline that copies between the two *precisely because they are isolated*. A guest "zero-copy view" of resident bytes would require the guest instance to address kernel linear memory — which the sandbox model forbids by construction. So A′ **collapses into Tier B today**; there is no "zero-copy everywhere incl. Safari".

**What would unlock it.** A deliberate, designed **shared linear-memory segment** between the kernel and a specific user instance for resident-file buffers — a real relaxation of the sandbox isolation model, with its own threat-model analysis and **its own maintainer decision**. That decision is captured in **companion architecture-decision issue #218** ("shared kernel↔user resident-file segment: yes/no"); it is explicitly *out of scope* for this spec and must not be smuggled in. If and only if that is ratified does A′ return as a third tier (zero-copy ramfs/tmpfs on all platforms including browsers); until then, ramfs/tmpfs is Tier-B copy everywhere.
