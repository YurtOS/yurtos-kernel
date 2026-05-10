#ifndef YURT_COMPAT_STDLIB_H
#define YURT_COMPAT_STDLIB_H

/* Pull in the real wasi-sdk stdlib.h. */
#include_next <stdlib.h>

/* wasi-libc gates mktemp / mkstemp / mkostemp / mkdtemp behind
 * __wasilibc_unmodified_upstream and they are absent from the wasm32-wasip1
 * sysroot.  Provide real implementations here against the VFS:
 *
 *   - mktemp(3):     replace the trailing XXXXXX of the template with
 *                    crypto-quality random alphanumerics (via getentropy
 *                    → WASI random_get → host crypto.getRandomValues).
 *   - mkstemp(3):    mktemp + open(O_CREAT|O_EXCL); retry on EEXIST.
 *   - mkostemp(3):   mkstemp variant that takes extra open flags.
 *   - mkdtemp(3):    mktemp + mkdir; retry on EEXIST.
 *
 * All four are header-inlined so any C/C++ guest binary that links
 * libyurt_abi (or just sees this header on its include path)
 * gets working temp-file primitives without having to define them. */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifdef __cplusplus
extern "C" {
#endif

/* getentropy(3) is provided by wasi-libc and routes through WASI
 * random_get, which the yurt host services with crypto.getRandomValues
 * (see packages/kernel/src/wasi/wasi-host.ts:randomGet).  This is
 * the canonical crypto-quality entropy source for the sandbox. */
extern int getentropy(void *buffer, size_t length);

/* Real impls in libyurt_abi.a (yurt_mktemp.c) — symbols
 * appear in libc.a's link probe so gnulib's autoconf accepts them as
 * available and skips compiling its own redundant replacements. */
char *mktemp(char *tmpl);
int   mkstemp(char *tmpl);
int   mkostemp(char *tmpl, int flags);
char *mkdtemp(char *tmpl);

/* qsort_r — GNU 5-arg signature.  Real impl in yurt_fs.c uses a
 * single-thread arg stash on top of qsort. */
void qsort_r(void *base, size_t nmemb, size_t size,
             int (*compar)(const void *, const void *, void *),
             void *arg);

/* PTY helpers — wasi-libc has no /dev/ptmx; stubs let callers compile.
 * grantpt/unlockpt succeed silently; ptsname_r returns ENOSYS. */
static inline int grantpt(int fd) { (void)fd; return 0; }
static inline int unlockpt(int fd) { (void)fd; return 0; }
static inline int ptsname_r(int fd, char *buf, size_t buflen) {
    (void)fd; (void)buf; (void)buflen;
    errno = ENOSYS; return -1;
}

#ifdef __cplusplus
}
#endif

#endif /* !__wasilibc_unmodified_upstream */

#endif /* YURT_COMPAT_STDLIB_H */
