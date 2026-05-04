#ifndef YURT_MARKERS_H
#define YURT_MARKERS_H

#include <stdint.h>

/*
 * Implementation-signature markers for §Verifying Precedence.
 *
 * The yurt compat library can run in two verification modes:
 *
 * - **Production / default** (no `-DYURT_GUEST_COMPAT_MARKERS`):
 *   The macros below compile to nothing.  No marker functions are
 *   emitted, no extra exports are forced.  cpcheck verifies link
 *   precedence *structurally*: every Tier 1 symbol must be exported
 *   from the wasm, and *none* of them may appear in the import
 *   section (which would mean a wasi syscall stub won the link).
 *   This works because cpcc `--whole-archive`-links our compat lib,
 *   so our symbol is structurally present and wins by link order.
 *
 * - **Debug / instrumented** (`-DYURT_GUEST_COMPAT_MARKERS=1`):
 *   Each Tier 1 symbol's body emits a side-effecting call to a
 *   companion marker function returning a distinct magic constant.
 *   cpcheck's `--mode=markers` then verifies the body in the
 *   pre-opt wasm contains that call — proving the bytes that ran
 *   came from our compat source, not a wasi-libc stub of the same
 *   name.  Useful while iterating on the compat layer; brittle for
 *   trivial bodies (LTO loves to inline `(void)args; return 0;`).
 *
 * Constants are arbitrary distinct non-zero magic numbers; they
 * exist only to make the marker bodies individually identifiable in
 * binary dumps when markers are enabled.
 */

#ifdef YURT_GUEST_COMPAT_MARKERS

/* A volatile static prevents the compiler from constant-folding the
 * marker's return value into its callers at -O2, so that callers contain a
 * real `call` instruction (not an inlined constant) in the pre-opt .wasm —
 * which is what §Verifying Precedence stage 3 inspects.
 * export_name forces wasm-ld to emit the function as a wasm export, which
 * stage 2 of the check requires. */
#define YURT_MARKER_ATTR(sym)                                            \
  __attribute__((visibility("default"), used, noinline,                     \
                 export_name("__yurt_guest_compat_marker_" #sym)))

#define YURT_DEFINE_MARKER(sym, magic)                                   \
  static volatile uint32_t __yurt_marker_val_##sym = (uint32_t)(magic); \
  YURT_MARKER_ATTR(sym) uint32_t __yurt_guest_compat_marker_##sym(void) { \
    return __yurt_marker_val_##sym;                                      \
  }

#define YURT_DECLARE_MARKER(sym) \
  uint32_t __yurt_guest_compat_marker_##sym(void)

/* The call goes through a volatile function-pointer indirection so
 * the compiler can't fold the marker function inline — even when LTO
 * sees that the marker's body is a single volatile load. */
#define YURT_MARKER_CALL(sym)                                              \
  do {                                                                        \
    typedef uint32_t (*_yurt_marker_fn_##sym)(void);                       \
    volatile _yurt_marker_fn_##sym _yurt_marker_call_##sym =            \
      &__yurt_guest_compat_marker_##sym;                                   \
    volatile uint32_t _yurt_marker_sink = _yurt_marker_call_##sym();    \
    (void)_yurt_marker_sink;                                               \
  } while (0)

#else /* !YURT_GUEST_COMPAT_MARKERS — production / default */

/* Production: no marker plumbing.  cpcheck switches to structural
 * verification (no Tier 1 symbol may appear in the wasm imports,
 * meaning our --whole-archive'd compat impl wins by link order). */
#define YURT_DEFINE_MARKER(sym, magic) /* nothing */
#define YURT_DECLARE_MARKER(sym)       /* nothing */
#define YURT_MARKER_CALL(sym)          ((void)0)

#endif /* YURT_GUEST_COMPAT_MARKERS */

#endif /* YURT_MARKERS_H */
