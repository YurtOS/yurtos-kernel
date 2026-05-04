/* sys/time.h — extends wasi-sdk's sys/time.h for wasm32/wasi.
 * settimeofday is gated behind __wasilibc_unmodified_upstream in wasi-sdk;
 * provide a stub that returns EPERM so callers compile and degrade cleanly. */

#ifndef YURT_COMPAT_SYS_TIME_H
#define YURT_COMPAT_SYS_TIME_H

#include_next <sys/time.h>

#include <errno.h>

/* settimeofday — gated behind __wasilibc_unmodified_upstream in wasi-sdk
 * (WASI has no way to set the clock); declare it as an EPERM stub. */
#ifndef __wasilibc_unmodified_upstream
static inline int settimeofday(const struct timeval *tv,
                               const struct timezone *tz) {
    (void)tv; (void)tz; errno = EPERM; return -1;
}
#endif

#endif /* YURT_COMPAT_SYS_TIME_H */
