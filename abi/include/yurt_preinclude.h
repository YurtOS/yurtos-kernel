#ifndef YURT_COMPAT_PREINCLUDE_H
#define YURT_COMPAT_PREINCLUDE_H

/* Do NOT add `#include <…>` for system headers here. yurt-cc passes
 * this file as `-include` at the start of every TU, before the source
 * defines feature-test macros like _GNU_SOURCE / _POSIX_C_SOURCE.
 * Including a header (or any header that transitively pulls in
 * <sys/types.h>) here trips its include guard with the wrong macro
 * state, and downstream `#include`s become no-ops that silently skip
 * feature-gated declarations (e.g. clock_gettime in <time.h>, fd_set/
 * FD_SETSIZE transitively from <sys/types.h>). Forward-declare what
 * you need; per-header decoration belongs in `abi/include/<header>`,
 * picked up via the `-I` path when source code includes it itself. */
#if !defined(__ASSEMBLER__)
#ifdef __cplusplus
extern "C" {
#endif
void qsort_r(void *base, __SIZE_TYPE__ nmemb, __SIZE_TYPE__ size,
             int (*compar)(const void *, const void *, void *),
             void *arg);
#ifdef __cplusplus
}
#endif
#endif

#endif
