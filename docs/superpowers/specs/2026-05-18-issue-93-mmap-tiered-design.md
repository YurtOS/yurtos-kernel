# #93 — File-backed `mmap`/`munmap`/`mprotect`/`msync`: tiered design

**Status:** Design recorded — **supersedes the recommendation half of [#187](https://github.com/YurtOS/yurtos-kernel/pull/187)** (`2026-05-17-issue-93-mmap-descope-or-emulate-design.md`). Implementation **blocked on maintainer ratification** of the tiered recommendation. Part of #83; refs #52, #71, #65, #97. No code in this PR (#93 mandates "maintainer decision first, implementation second"; the brainstorming gate forbids implementation before an approved spec).

> #187 framed the choice as binary: (a) descope file-backed `mmap`, or (b) emulate by copy. This document keeps (b) as the **universal floor** but shows it is only the *lowest* of three tiers. The host-`mmap` instinct ("ask the host to map the file") is **not** dead — it is the *premier* path on native runtimes where the embedder owns linear-memory allocation. The design is therefore **tiered and per-mapping**, mirroring the capability-matrix discipline already used here (JSPI→asyncify; pluggable runtime/VFS).

---

## 1. Problem & why a single answer is wrong

A `wasm32` guest has one runtime-owned linear memory and no MMU. Three sub-capabilities make up "real `mmap`":

1. **Address-space projection / aliasing** — the bytes of a file appearing *in guest-addressable memory* without a copy.
2. **MMU semantics** — lazy fault-in, COW for `MAP_PRIVATE`, enforced `PROT_*`, `MAP_SHARED` page-cache coherency.
3. **An IO substrate** — `pread`/`pwrite` of the backing object.

Whether (1) and (2) are achievable is **not** a property of "wasm" in the abstract — it is a property of *who owns the linear memory* and *what backs the OFD*. That is why the answer must be tiered, not global.

### 1.1 Dead ends (considered & rejected — record so this is not re-derived)

- **Host `mmap` projected into linear memory, generically.** A `WebAssembly.Memory` is one engine-owned contiguous buffer; nothing can splice a foreign host mapping into a sub-range of it. Dead **in the browser** and on any runtime where the engine owns memory allocation. (It is *not* dead when the embedder owns the allocation — see Tier A.)
- **Multi-memory.** LLVM has only flag + MC/back-end infra ([D158409](https://reviews.llvm.org/D158409)); **no C-frontend / address-space lowering** — transparent use needs an LLVM fork, not our clang wrapper. Each memory is still its own engine buffer (no host aliasing). Memory is selected by a **static instruction immediate**, never by pointer bits. Safari has none of it. Rejected.
- **memory64 + fat/tagged pointers.** memory64 only widens the address operand (cap ~16 GB; "48-bit" is the host VA width, not a wasm limit); it adds no memory selector to the pointer. A `[memory-index:offset]` fat pointer is a *custom software-dispatch ABI* (a software MMU, per-access branch), not a spec/engine mechanism — same LLVM-fork cost, still no aliasing/MMU, Safari excluded. Rejected.

**Conclusion:** none of the exotic paths change the outcome. Copy-emulation is the universal floor; real `mmap` is reachable only where the embedder owns the memory or the bytes already live in guest-addressable memory.

---

## 2. Architecture — one ABI, capability-negotiated backend

A `MmapBackend` trait in `yurt-kernel-wasm`, at the `SYS_*`/`kh_*` boundary — **not** a new VFS backend (mirrors the browser-HostFs-emulation rule — microkernel `kh_real_*`→OPFS, emulation is a microkernel-level capability bound to the runtime/embedder, composed *with* the VFS, not a `kernel.wasm` mount).

`mmap` always operates on an OFD resolved through the existing pluggable VFS. Backend choice is **per-mapping**, by two independent facts:

1. **Runtime capability** (probed once at kernel init): did the embedder supply a reservable, `MAP_FIXED`-capable linear memory (wasmtime `MemoryCreator`/custom `LinearMemory`, WasmEdge custom allocator, wasmer `Tunables`)? Browser/Safari: always *no*.
2. **Per-mapping OFD backing**: real host fd at a stable offset? in-wasm-resident? neither?

Selection (analogue of Linux's per-fs `f_op->mmap` dispatch):

| OFD backing | Runtime owns memory (native) | Engine owns memory (browser/Safari) |
|---|---|---|
| Real host fd (host-fs, on-disk image) | **Tier A** — host `MAP_FIXED` overlay | **Tier B** — copy |
| In-wasm-resident (ramfs/tmpfs, resident image layers) | **Tier A′** — in-wasm zero-copy view | **Tier A′** (works everywhere) |
| Remote/lazy (S3, network VFS) | **Tier B** — copy + cap | **Tier B** — copy + cap |
| Socket/pipe/char-special | `ENODEV` | `ENODEV` |

Every `mmap` of a file is an outside-world crossing → passes the embedder `PolicyEnforcer` Allow/Deny gate before any backend acts. The libc shim and guest always call **one** ABI; dispatch is internal and invisible.

```
guest mmap() → libc shim (thin marshaller, no logic)
            → SYS_mmap typed ABI (no JSON)
            → PolicyEnforcer gate
            → MmapBackend::map(ofd, addr, len, prot, flags, off)
                 ├─ Tier A   HostFixedMap   (native + host-fd OFD)
                 ├─ Tier A′  InWasmView     (in-wasm-resident OFD; all platforms)
                 └─ Tier B   CopyEmulation  (everything else, incl. all browser)
            → per-process MmapTable records the mapping
```

---

## 3. The ABI primitive (typed, no JSON, WASI-#304-shaped)

WASI [issue #304](https://github.com/WebAssembly/WASI/issues/304) independently converged on this shape (fd-only, caller-supplied addr+len, no anonymous, non-persistent) and noted the host-native aspiration that Tier A realises.

Five imports; `abi/src/yurt_mman.c` (today all `ENOSYS` stubs) becomes a pure marshaller — no logic (buffer/parse logic stays in safe Rust):

```
sys_mmap(addr:u32, len:u32, prot:i32, flags:i32, fd:i32, offset:i64) -> i64
sys_munmap(addr:u32, len:u32)                                        -> i32
sys_mprotect(addr:u32, len:u32, prot:i32)                            -> i32
sys_msync(addr:u32, len:u32, flags:i32)                              -> i32
sys_madvise(addr:u32, len:u32, advice:i32)                           -> i32
```

**Two surfaces, deliberately.** The *libc surface* is bit-for-bit POSIX `mmap(2)` — same prototype, same parameter order, `MAP_FAILED`+`errno`; sqlite/Polars/CPython cannot tell it isn't musl. The *kernel ABI* is Linux/WASI-*syscall*-shaped: `sys_mmap` returns **i64** (`>=0` = guest ptr, `<0` = negated errno; no errno-TLS at the boundary). The shim reconciles: `<0` → `errno=-ret; return MAP_FAILED;`.

**Wart we deliberately do not copy.** Linux's real syscall is `mmap2` with `offset` in 4 KiB pages, purely to fit 64-bit offsets through 32-bit registers. We take `offset` as **raw bytes in i64** (the `mmap(2)` *function* contract) — wasm imports have no register constraint, so the `mmap2` page-shift and its bug class do not exist for us.

**Keystone — a kernel-owned per-process mmap *arena*.** The embedder reserves a contiguous, page-aligned VA window in linear memory at init (the same reservation Tier A needs to `MAP_FIXED` into). `mmap` is an allocator *within* that arena; all three tiers draw from it. This resolves three #187 holes **structurally**: addresses are page-aligned by construction; a dedicated arena VA range makes "is this an mmap pointer?" an O(1) range check then O(log n) interval probe (for `munmap`/`msync`/`mprotect`, which carry no handle); partial unmap is arena-range splitting.

**`addr`/`MAP_FIXED`.** Non-FIXED → hint ignored, kernel returns an arena address. `MAP_FIXED` to an arbitrary guest address → cannot remap arbitrary linear memory → enumerated `UNSUPPORTED` (`EINVAL`). `MAP_FIXED` *inside the arena at a free range* **is** honored (an honest partial-FIXED capability).

**Anonymous.** `MAP_ANONYMOUS` private → stays libc `malloc`/`memory.grow`, **not** intercepted — but this spec explicitly replaces today's blanket `ENOSYS` so anon-private actually works. `MAP_ANONYMOUS|MAP_SHARED` → SAB-backed shared path (§5).

**Overflow (#65 class, mandatory).** `offset+len`, `addr+len` via `checked_add` in safe Rust → `EINVAL`/`EOVERFLOW`, never wrap. Carries an explicit wasm32-width guard test (the kernel ships 32-bit `usize` but `cargo test` is 64-bit native — the guard must exercise the 32-bit bound even on a 64-bit host; the #65 additive-overflow class).

**Assumption to validate in slice 3:** Tier A′ zero-copy-view requires the ramfs/tmpfs storage buffer to live in *guest-addressable* linear memory. If kernel-wasm storage is a separate memory, A′ degrades to a copy for those OFDs (documented, not silent).

---

## 4. Tier A — host `MAP_FIXED` overlay

Real, lazy, MMU-correct, **zero-copy** `mmap` — the only tier that scales to Polars/Arrow on real-sized data.

1. Embedder builds the guest linear memory itself as an `mmap`'d region **plus extra reserved unmapped VA** = the arena (§3).
2. On `mmap(host-fd OFD)`: arena picks page-aligned `[A, A+len)`; kernel calls host `mmap(host_base+A, len, prot, MAP_FIXED|MAP_PRIVATE|MAP_SHARED, host_fd, offset)`.
3. Return `A`. The guest's ordinary load/store at `A` faults straight into the OS file mapping: lazy paging, real COW (`MAP_PRIVATE`), real coherency (`MAP_SHARED`), enforced `mprotect`, `msync`=host `msync`, `munmap`=host `munmap` + arena free.

**Per-runtime glue (the pluggable WASM-runtime seam):** wasmtime `MemoryCreator`/`LinearMemory` (first), WasmEdge custom allocator, wasmer `Tunables`. Engine-default memory (browser) → probe false → Tier A never selected.

**Still UNSUPPORTED even on Tier A (enumerated, written-reason):** `MAP_FIXED` outside the arena; cross-*process* `MAP_SHARED` coherency when two yurt processes don't deliberately share the host fd+mapping (separate wasm instances — the multi-process model, PR #129 / tracking #172); `PROT_EXEC` into linear memory (meaningless — accepted, inert). The host `MAP_FIXED` only ever targets the disjoint arena window, never guest heap/stack; every map passes the PolicyEnforcer first.

---

## 5. Tier B — copy-emulation + shadow-diff writeback; Tier A′; anon-shared

**Tier B** is selected for browser/Safari and for remote/lazy OFDs on any runtime.

- **`MAP_PRIVATE,fd`** — arena-allocate, eager `pread [offset,offset+len)` via the synchronous OPFS substrate (`FileSystemSyncAccessHandle`) / VFS read path. This is a **snapshot at mmap time** (not lazy Linux `MAP_PRIVATE`) — correct and more deterministic for read-only consumers; divergence documented. `len > YURT_MMAP_MAX_COPY` (policy) → **`ENOMEM`** so consumers fall back to their non-mmap reader (bounded, honest, never silent). Writes process-local.
- **`MAP_SHARED,fd`** — **shadow-diff writeback** (fixes the #187 silent-corruption footgun). Snapshot a *shadow* of the original bytes at map time; on `msync(MS_SYNC)`/`munmap`, diff current-vs-shadow and `pwrite` **only changed ranges**, then refresh shadow. Bytes the guest never touched are never written → concurrent external writers are not clobbered. Not cross-process coherent (no shared page cache) but **not destructive**. Cost: 2× region + O(len) diff; same size cap.
- **`mprotect`** — bookkeeping only: record `prot` (for `/proc` honesty + future fault-sim), no enforcement; `PROT_NONE` recorded not trapped; UNSUPPORTED-enforcement documented, not silently lied about. `madvise` stays the existing no-op.

**Tier A′ — in-wasm zero-copy view.** For OFDs whose bytes kernel-wasm already owns and that are guest-addressable (ramfs/tmpfs, resident image layers): map = alias that buffer; no copy; `MAP_SHARED` coherent *within the process/threads* because it is the same bytes. Works on **every** platform including Safari (no host, no copy). This is exactly why Linux ramfs/tmpfs `mmap` is first-class (the fs *is* the page cache); we own both sides, so we get the same property without an OS.

**`MAP_ANONYMOUS|MAP_SHARED`.** SAB-backed linear memory (cross-origin-isolated, or native shared) → genuinely shared across pthreads/workers, *real* not emulated. No SAB/COI → degrade to private-anon with a one-time diagnostic (enumerated UNSUPPORTED for the shared semantics; chosen over hard-fail because programs use it opportunistically).

**Cooperative windowing — above the seam, not in `MmapBackend`.** A bundled custom **sqlite VFS** maps sqlite's `xFetch(off,len)`/`xUnfetch` to tiny windowed `pread`s through the same primitive → sqlite gets lazy, memory-bounded `mmap` *even in the browser*, never hitting the cap. Python's `mmap` object is already method-bounded. Raw-pointer consumers (Polars/Arrow `memmap2`, mmap parsers) have no such hook → eager-copy-+-cap is the honest Tier-B answer, and the entire justification for Tier A.

**Async.** OPFS sync handles are synchronous in a Worker → the copy needs no asyncify. A Tier-B map over an async VFS (S3/network) makes `mmap` a suspending syscall riding the AsyncBridge like any blocking `kh_*`. Tier-B `mmap` is blocking; its async-ness inherits from the VFS read path.

---

## 6. `MmapTable`, fork/exec, errno

**Per-process `MmapTable`** (next to the fd table):

```
Mapping { guest_addr:u32, len:u32, prot:i32, flags:i32,
          ofd:Option<OfdRef>, file_offset:i64,
          tier:{A|A′|B}, backing:BackingKind,
          shadow:Option<ShadowBuf>, host_map:Option<HostMapHandle> }
```

Interval tree keyed by `guest_addr`. **Partial unmap/mprotect splits entries** (POSIX permits carving the middle of a mapping; glibc/musl/jemalloc rely on it) — #187 ignored this entirely.

**Lifecycle invariants (explicit):**
1. A Mapping holds its **own OFD ref** — survives the guest `close()` (POSIX).
2. Tier A holds a host-fd handle + host VA range; both released *exactly* on `munmap`/`exec`/exit — enumerated no-leak path.
3. Arena ranges returned on `munmap`/`exec`/exit; the arena allocator is the sole authority for "is this an mmap address".

**fork** (multi-process model, PR #129 / tracking #172 — separate wasm instances, memory not host-COW): kernel **replays** the table into the child:
- `MAP_PRIVATE`: child copies parent's **current** region bytes (post-write COW snapshot, *not* a fresh file re-read — POSIX).
- `MAP_SHARED,fd` **Tier A**: child re-maps the same host fd `MAP_SHARED` → genuinely OS-coherent across the fork (the file mapping is the shared substrate, even though the wasm instances are separate). Real win unique to Tier A.
- `MAP_SHARED,fd` **Tier B**: independent copies, converge only via file writeback — enumerated UNSUPPORTED ("not fork-coherent in memory").
- `MAP_ANONYMOUS|MAP_SHARED`: coherent only via a SAB segment both instances map; else child gets a private copy — enumerated UNSUPPORTED.

**exec**: all mappings destroyed (POSIX) → full teardown: host-munmap Tier A, free arena, clear table; must not leak host mappings (invariant 2).

**errno** (refines #187; adds the tier dimension; fixes the `EOVERFLOW`/`EINVAL` split):

| errno | Condition |
|---|---|
| `EBADF` | `fd` not open (non-anon) |
| `EACCES` | `MAP_SHARED` write-map on read-only OFD; fd not readable; prot vs file-mode mismatch |
| `EINVAL` | `len==0`; bad `prot`/`flags`; non-page-aligned `offset`; **`addr/len/offset` arithmetic overflow** (Linux returns EINVAL here, not EOVERFLOW) |
| `ENODEV` | OFD type unmappable (socket/pipe/char-special) — mirrors Linux/FUSE-direct_io precedent |
| `ENOMEM` | arena exhausted; Tier-B `len > YURT_MMAP_MAX_COPY`; no arena VA |
| `EOVERFLOW` | **only** genuine `off_t`/file-size-domain overflow (offset+len exceeds representable file size) |
| enumerated `UNSUPPORTED` | `MAP_FIXED` outside arena; cross-process `MAP_SHARED`; `mprotect` enforcement; anon-shared w/o SAB — each a written-reason conformance row (#52/#97), never a silent wrong answer |

---

## 7. Conformance & testing

**Corpus lift (verified via GitHub API):** the bytecodealliance and emscripten Open POSIX forks carry **identical** `mmap` (33) + `munmap` (7) numbered tests; **neither** ships `mprotect`/`msync` dirs (confirmed 404).

- Lift the `mmap`(33)+`munmap`(7) bodies **once**. Source of record = **bytecodealliance/open-posix-test-suite** (wasmtime org's WASI-maintained lineage — closest harness model). **emscripten-core/posixtestsuite** used only as a cross-reference for which cases are known wasm-runnable (its `run_tests` subset = prior-art triage for the Tier-B baseline; not authoritative for our tiers since emscripten has no Tier A).
- `mprotect`/`msync`: author fixtures + differ rows from scratch (unavoidable — confirmed).
- **Per-tier expectation matrix**: every case tagged PASS / enumerated-`UNSUPPORTED(reason)` *per tier* (A/A′/B), bound to a §4–6 corner; Tier A expected to PASS strictly more than Tier B (the point). No silent skips — #52/#97 written-reason path; feeds the #97 UNSUPPORTED list.

**Consumer integration proofs (the real bar — "binaries that use mmap now"):**
- **sqlite-mmap**: `PRAGMA mmap_size` workload, B0 zero-diff vs read()/write(); passes both tiers — Tier B via the cooperative VFS (also proves the windowing component).
- **Polars/Arrow**: small `read_parquet(memory_map=True)` → correct frame both tiers; **large** file → assert Tier B `ENOMEM` *and* Polars falls back to its non-mmap reader with identical output; Tier A → correct *and* memory bounded (proves zero-copy, not eager).
- **Python `mmap` + concurrent-writer regression**: external writer touches byte X; guest maps, writes byte Y elsewhere, `msync`; assert X **not** clobbered — the test that proves the shadow-diff fix.
- **anon-shared**: two pthreads `MAP_ANONYMOUS|MAP_SHARED` — real under SAB/COI, enumerated-UNSUPPORTED diagnostic otherwise.

**Gates:** mandatory wasm32-width overflow tests (exercise the 32-bit bound on a 64-bit host; #65 additive-overflow class); each slice's DoD includes `cargo clippy -p yurt-kernel-wasm` (CI skips it — `yurt-kernel-wasm` is excluded from workspace `default-members`); tier-selection logic is pure safe Rust → fully unit-tested without a real runtime. Every slice is its own TDD PR; B0 zero-diff is the integration gate.

---

## 8. Sequencing & relationship to #187

This **supersedes the recommendation half of #187** (decision-only, unmerged). #93 mandates maintainer decision before implementation, so the deliverable here is this spec; #187's doc should point to / be revised toward it, and the **tiered recommendation still needs maintainer ratification** before any code. No self-merge.

Post-ratification slices (each its own TDD PR):

1. ABI + arena allocator + `MmapBackend` trait + two-level selection + errno/overflow + wasm32-width tests; `MAP_PRIVATE` Tier-B eager-copy only; replaces the `yurt_mman.c` `ENOSYS` stubs. *(Satisfies #93 acceptance on the floor.)*
2. Tier-B `MAP_SHARED` shadow-diff + `msync` + concurrent-writer regression.
3. Tier A′ ramfs/tmpfs zero-copy view (+ validate the "ramfs buffer guest-addressable" assumption; documented fallback if false).
4. Tier A host `MAP_FIXED` overlay + per-runtime memory-creator glue (wasmtime first; WasmEdge/wasmer follow).
5. Cooperative sqlite VFS (windowed `xFetch`) above the primitive.
6. Open POSIX wiring + per-tier expectation matrices + #97 UNSUPPORTED enumeration.
7. Consumer fixtures: sqlite B0 zero-diff, Polars small+large, Python concurrent-writer, anon-shared.

Slices 1–2 unblock #93 on the floor; 3–4 deliver the real wins; 5–7 prove it. Coordinates with the AsyncBridge integration (Tier-B async-over-S3), the SAB/threads model (anon-shared), and the kernel-wasm clippy gate.

## 9. Acceptance mapping

- [x] maintainer **decision recommendation** recorded — tiered (A/A′/B), copy-emulation = floor not answer — **awaiting maintainer ratification** to mark the parity matrix "Scope changes" + the #83-descope list.
- [ ] (post-ratification) slices 1–2 — ABI + arena + selection + Tier-B `MAP_PRIVATE`/`MAP_SHARED`; C1-safe offset math (#65); replaces `ENOSYS` stubs.
- [ ] (post-ratification) slices 3–4 — Tier A′ + Tier A real `mmap`.
- [ ] (post-ratification) slices 5–7 — sqlite VFS; Open POSIX wired with per-tier UNSUPPORTED enumeration; consumer fixtures; B0 zero-diff; `fmt`/`clippy -p yurt-kernel-wasm` clean.

## 10. Conclusion

Copy-emulation is the **universal floor**, not the answer. Where the embedder owns linear memory (native runtimes) the host *can* map the file — `MAP_FIXED` overlay into the reserved arena gives real, lazy, zero-copy `mmap` (Tier A); where the bytes already live in guest-addressable memory (ramfs/tmpfs) we alias them with no OS at all (Tier A′, every platform incl. Safari); everything else degrades honestly to bounded copy + shadow-diff (Tier B). One POSIX-shaped ABI; per-mapping tier selection; every impossible corner enumerated, never silent.
