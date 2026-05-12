/* Phase 1 shared-library main-module exports.
 *
 * Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md (§86)
 *
 * The dlopen loader (packages/kernel/src/process/dynlink.ts ::
 * mainAccessFromInstance) requires every PIE main module to export
 * `__alloc` and `__dealloc` so it can reserve a memory region for the
 * side module's data segments and free that region on dlclose. The
 * spec phrases this as "the existing YurtOS shell already exports
 * `__alloc`" — that's the contract we make true here.
 *
 * Implementation: thin wrappers around wasi-libc's `malloc` / `free`.
 * That keeps the allocator policy in one place (no separate
 * bookkeeping, no second arena), and matches the cpython / shell
 * convention where the main module's heap is the source of truth.
 * The size argument to __dealloc is ignored — free() doesn't need it
 * — but the parameter is preserved for symmetry with the spec's
 * `__alloc(size_t) / __dealloc(void*, size_t)` shape, which mirrors
 * an arena-style allocator. A future implementation that swaps in a
 * tracking allocator (e.g. dlopen's memory accounting per side
 * module) can use the size hint.
 *
 * The functions are marked `visibility("default")` and force-exported
 * by yurt-cc's YURT_INTERNAL_EXPORTS list (see
 * abi/toolchain/yurt-toolchain/src/lib.rs). Together that puts them
 * in the wasm export section of every PIE main module built with
 * yurt-cc — no per-port wiring needed.
 */

#include <stdlib.h>

__attribute__((visibility("default"))) void *__alloc(size_t n) {
  return malloc(n);
}

__attribute__((visibility("default"))) void __dealloc(void *p, size_t n) {
  (void)n;
  free(p);
}

/* Pin `__wasi_init_tp` so wasm-ld retains the symbol in the binary's
 * function table, where yurt-cc's `-Wl,--export=__wasi_init_tp` flag
 * (added via YURT_INTERNAL_EXPORTS) can pick it up. Without this
 * reference, wasm-ld's gc-sections drops the symbol from wasi-libc's
 * archive — the canary doesn't call it directly, and wasi-libc's own
 * startup may or may not reference it depending on which subsystems
 * are pulled in. The function pointer in a `used`-marked, default-
 * visibility array forces both the keep-alive and the symbol's
 * presence as a regular function (callable, which is what the side
 * module's `env.__wasi_init_tp` import expects).
 *
 * The actual definition is in wasi-libc; we only need the reference. */
extern void __wasi_init_tp(void);
__attribute__((used, visibility("default")))
void (*const __yurt_keep_wasi_init_tp)(void) = __wasi_init_tp;
