#ifndef YURT_COMPAT_SYS_STAT_H
#define YURT_COMPAT_SYS_STAT_H

/* wasi-libc gates `umask` behind __wasilibc_unmodified_upstream, so
 * it's invisible on wasm32-wasip1 by default.  Yurt ships a real
 * `umask` impl in libyurt_abi.a (yurt_process.c) that
 * tracks a process-wide mask (default 022, POSIX).  Pull in wasi-sdk's
 * <sys/stat.h> for the bulk of the surface, then declare umask
 * unconditionally so guest C code that reads/writes the mask compiles. */

#include_next <sys/stat.h>

#ifndef __wasilibc_unmodified_upstream
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

mode_t umask(mode_t mask);
int chmod(const char *path, mode_t mode);

/* mknod — creating device nodes is not supported in the WASI sandbox;
 * callers (tar, cp) silently fall back when EPERM is returned. */
#include <errno.h>
static inline int mknod(const char *p, mode_t m, dev_t d) {
    (void)p; (void)m; (void)d; errno = EPERM; return -1;
}
static inline int mkfifo(const char *p, mode_t m) {
    (void)p; (void)m; errno = EPERM; return -1;
}

#ifdef __cplusplus
}
#endif

#endif /* !__wasilibc_unmodified_upstream */

#endif
