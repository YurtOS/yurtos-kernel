/* sys/times.h — stub for wasm32/wasi.
 * Overrides the wasi-sdk error-raising header; returns zero CPU-time
 * measurements (the wall clock is inaccessible in WASI without emulation). */

#ifndef _SYS_TIMES_H
#define _SYS_TIMES_H

/* Include time.h to get the correct clock_t definition from wasi-sdk.
 * On wasm32-wasip1 clock_t is long long; don't redefine it. */
#include <time.h>
#include <sys/types.h>

struct tms {
    clock_t tms_utime;
    clock_t tms_stime;
    clock_t tms_cutime;
    clock_t tms_cstime;
};

static inline clock_t times(struct tms *buf) {
    if (buf) {
        buf->tms_utime  = 0;
        buf->tms_stime  = 0;
        buf->tms_cutime = 0;
        buf->tms_cstime = 0;
    }
    return 0;
}

#endif /* _SYS_TIMES_H */
