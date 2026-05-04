#ifndef YURT_COMPAT_FCNTL_H
#define YURT_COMPAT_FCNTL_H

/* wasi-libc's fcntl.h ships F_GETFD=1, F_SETFD=2, F_GETFL=3, F_SETFL=4
 * but lacks F_DUPFD entirely — dup() / dup2() in wasi go through
 * fd_renumber, not fcntl().  When gnulib-using ports compile, gnulib's
 * lib/fcntl.h sees F_DUPFD undefined and assigns it the value 1 as a
 * "made-up but unique" placeholder.  That collides with wasi-libc's
 * F_GETFD=1, producing duplicate-case errors in any switch that lists
 * both (lib/fcntl.c does).
 *
 * Linux convention puts F_DUPFD at 0, which doesn't conflict with the
 * wasi-libc set.  Define it here BEFORE gnulib's fcntl.h has a chance
 * to assign its own value, and gnulib's `#ifndef F_DUPFD` skips the
 * collision-prone fallback. */

#define F_DUPFD 0

#include_next <fcntl.h>

#endif
