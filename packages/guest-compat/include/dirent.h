#ifndef YURT_COMPAT_DIRENT_H
#define YURT_COMPAT_DIRENT_H

/* wasi-libc's <dirent.h> declares an `opendirat(int, const char *)`
 * (2-arg) entry that conflicts with gnulib's `opendirat(int, char
 * const *, int, int *)` (4-arg, accepts O_CLOEXEC and returns the
 * resolved fd alongside the DIR*).  POSIX defines neither shape;
 * coreutils + many gnulib-using ports rely on the 4-arg gnulib one.
 *
 * We hide wasi-libc's declaration via a temporary macro rename so
 * gnulib's lib/opendirat.h can declare its own opendirat without
 * collision.  The wasi-libc symbol lives on in libc.a as
 * `opendirat` (the link name isn't affected by our macro rename),
 * but no port we ship calls it — gnulib's 4-arg version wins for
 * everyone going through our compat headers.
 *
 * Rationale for hiding rather than aliasing: gnulib's opendirat
 * has different semantics (the extra args are non-trivial), so a
 * thin alias would silently misbehave.  Hiding forces the right
 * gnulib-side declaration to be the one in scope. */

#define opendirat   __yurt_hidden_wasilibc_opendirat
#define scandirat   __yurt_hidden_wasilibc_scandirat
#include_next <dirent.h>
#undef opendirat
#undef scandirat

#endif
