# #93 — File-backed `mmap`/`munmap`/`mprotect`/`msync`: descope-or-emulate decision + design

> **⚠️ SUPERSEDED (2026-05-18).** The recommendation in this document (single-approach "emulate, option (b)") is superseded by the tiered design in [`2026-05-18-issue-93-mmap-tiered-design.md`](./2026-05-18-issue-93-mmap-tiered-design.md), which keeps copy-emulation as the *universal floor* (Tier B) and adds a native embedder host-`MAP_FIXED` tier (Tier A). Read the 2026-05-18 spec for the ratifiable design; this document is retained for the option-space rationale and history only. Do not implement from this doc.

**Status:** Superseded — see banner above. *(Original:* Decision recorded; implementation blocked on maintainer ratification. Part of #83; refs #52, #71, #65.*)*

> #93 is explicitly "a maintainer decision issue first, implementation second." This document delivers acceptance item #1 (the recorded decision + rationale + the design that ratification unlocks). It does **not** unilaterally land emulation; the implementation slices are gated on a maintainer signing off option (b).

## Scope recap

- *Anonymous private* `mmap` (`MAP_ANONYMOUS`, `fd == -1`) is already served by libc `malloc` over wasm linear memory → **out of scope, keep delegating to libc, do not intercept**.
- The gap is **file-backed** `mmap` (real `fd`). A `wasm32` guest has one linear memory and no MMU, so this needs an explicit ruling, not a silent hole (the status DNS got).

## Options

**(a) Descope.** `mmap` with a real `fd` ⇒ `-ENODEV`; record as a justified UNSUPPORTED conformance exception. Simplest. Breaks sqlite mmap mode (`PRAGMA mmap_size` is **on by default**), Python `mmap` module, mmap-based parsers/loaders.

**(b) Emulate over linear memory** (the issue's "recommended floor").

## Decision — RECOMMEND (b), emulate

Rationale:

1. **Real userland impact.** sqlite enables mmap by default; descoping silently degrades or breaks a flagship workload (and Python `mmap`). #52's contract is "maximal real-userland parity"; this is squarely a real need, not an exotic syscall.
2. **The emulation floor is small and self-contained.** `MAP_PRIVATE,fd` = "allocate + `pread` the region" — a few hundred lines of safe Rust behind a typed ABI; no MMU required. It reuses existing VFS read primitives.
3. **(a) is still partially required even under (b).** The unimplementable corners (protection faults, cross-process `MAP_SHARED` coherency, `MAP_FIXED` placement) become *enumerated* justified-`UNSUPPORTED` conformance rows — exactly the written-reason exception path #52/#97 mandate. So (b) does not avoid the exception list; it minimizes it to the genuinely-impossible cases.
4. Choosing (b) keeps the B5 gate evaluable for the `mmap` corpus area (currently unevaluable until this decision + exception list exists).

Residual limitations to **document explicitly** (not silently): `MAP_SHARED` is best-effort write-back on `msync`/`munmap`, **not** cross-process coherent; `mprotect` is bookkeeping-only (no faulting MMU); `MAP_FIXED` placement is unsupported.

## Design for (b) (unlocked on ratification)

### ABI (typed, no JSON — per the boundary rule)

Four host imports / `SYS_*` dispatch methods, fixed binary layout (caller-allocated result buffer where needed), mirroring the existing `SYS_*` shapes — **no JSON at the boundary**:

```
mmap(addr:i32, len:i32, prot:i32, flags:i32, fd:i32, offset:i64) -> i32  // guest ptr or -errno
munmap(addr:i32, len:i32) -> i32
mprotect(addr:i32, len:i32, prot:i32) -> i32
msync(addr:i32, len:i32, flags:i32) -> i32
```

`abi/include/sys/mman.h` already exists; extend it + the C shim is a thin marshaller only (buffer/parse logic stays in safe Rust, per the repo rule).

### Kernel state (safe Rust, `kernel-wasm`)

Per-process `MmapTable`: `Vec<Mapping { guest_addr, len, prot, flags, ofd_id, file_offset, dirty: bitset }>`. `guest_addr` is a region the guest allocator/loader provides (the guest passes a target buffer; the kernel does **not** invent linear-memory addresses — the wasm guest owns its memory). Concretely the libc shim allocates `len` bytes (page-rounded) via the normal allocator and passes that pointer as `addr`; the kernel records the mapping and fills the buffer.

- **`MAP_PRIVATE, fd`:** copy-on-read — `pread` `[offset, offset+len)` of the OFD into the guest buffer once at `mmap`. Writes are process-local, never written back. Covers the sqlite read path, mmap-as-fast-read, parsers.
- **`MAP_SHARED, fd`:** read region in; track dirty pages (page-granular bitset on guest writes is not interceptable without an MMU, so dirty-tracking is **whole-region** unless the guest calls `msync` with a sub-range — document this). On `msync(MS_SYNC)` / `munmap`, `pwrite` the (sub)region back. Best-effort, not cross-process coherent.
- **`mprotect`:** bookkeeping only. `PROT_NONE` may be recorded for future fault-simulation; otherwise success no-op.
- **`MAP_FIXED` / `MAP_ANONYMOUS,fd==-1`:** not intercepted — delegate to libc.

### Errno table

| errno | Condition |
|---|---|
| `EACCES` | `MAP_SHARED` write-map on a read-only fd; fd not open for read |
| `EBADF` | `fd` not an open descriptor |
| `EINVAL` | `len == 0`; bad `prot`/`flags` combo; unaligned `offset` |
| `ENODEV` | fd type cannot be mapped (socket/pipe/char special) |
| `ENOMEM` | allocation for the region fails |
| `EOVERFLOW` | `offset + len` overflows the off_t / file-size domain |

### Overflow safety (#65 class — mandatory)

`offset + len` and `addr + len` are the exact additive-overflow class #65 covers: compute with `u64::checked_add` / `usize::checked_add`, return `EOVERFLOW`/`EINVAL` on overflow, never wrap. Add the same wrap-safe caller-length guards used elsewhere; cover with the `usize`-width test note ([[project_kernel_usize_width_test_gap]] — wasm32 `usize` is 32-bit; a 64-bit native `cargo test` can mask the overflow, so add an explicit 32-bit-bound guard test).

### Conformance

- Wire the Open POSIX `mmap` and `munmap` interface dirs through the differ harness.
- **Enumerate** (do not skip) each non-PASS as a written-reason `UNSUPPORTED`: protection faults, `MAP_SHARED` cross-process coherency, `MAP_FIXED` placement — unimplementable in a no-MMU model. This is the #52/#97 exception path; feeds the #97 UNSUPPORTED list.
- `mprotect`/`msync` have no corpus dir → add fixtures + differ rows.
- sqlite-mmap fixture + B0 zero-diff as the integration proof.

## Sequencing / blocked-on

1. **(now, this PR)** Decision recorded + design. Acceptance #1.
2. **Blocked on maintainer ratification of (b).** On ratification, update the parity matrix "Scope changes" + the #83-descope list with "file-backed mmap = emulate (b); MMU-dependent corners = justified UNSUPPORTED".
3. Then implementation slices (each its own PR, TDD): (i) ABI + dispatch skeleton + `MAP_PRIVATE` copy-on-read + errno/overflow; (ii) `MAP_SHARED` dirty write-back + `msync`; (iii) `mprotect`/`msync` bookkeeping + fixtures; (iv) Open POSIX wiring + UNSUPPORTED enumeration; (v) sqlite-mmap fixture + B0 zero-diff.

## Acceptance mapping

- [x] maintainer **decision recommendation** recorded (b) + rationale (this doc) — **awaiting maintainer ratification to mark the matrix/#83-descope**
- [ ] (b) ABI + dispatch + safe-Rust emulation; C1-safe offset math (#65) — slices, post-ratification
- [ ] `mmap`/`munmap` Open POSIX dirs wired; non-PASS tagged UNSUPPORTED — post-ratification
- [ ] TDD green; `fmt`/`clippy` clean; sqlite-mmap fixture + B0 zero-diff — post-ratification

## Conclusion

Recommend **(b) emulate** with the floor above. The decision is delivered; the implementation is intentionally **not** started — #93 mandates the decision precede implementation, and the matrix/#83-descope edits + the multi-slice build should follow an explicit maintainer ratification of (b).
