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

/* POSIX record-locking — wasi-sdk's WASI-mode path (__header_fcntl.h)
 * does not define these constants.  Provide the standard Linux values. */
/* O_NDELAY is a historical synonym for O_NONBLOCK (POSIX 1003.1g). */
#ifndef O_NDELAY
#define O_NDELAY O_NONBLOCK
#endif

#ifndef F_RDLCK
#define F_RDLCK  0
#endif
#ifndef F_WRLCK
#define F_WRLCK  1
#endif
#ifndef F_UNLCK
#define F_UNLCK  2
#endif
#ifndef F_GETLK
#define F_GETLK  5
#endif
#ifndef F_SETLK
#define F_SETLK  6
#endif
#ifndef F_SETLKW
#define F_SETLKW 7
#endif

#endif
