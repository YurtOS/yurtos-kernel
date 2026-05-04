/* sys/prctl.h — stub for wasm32/wasi.
 * prctl() is a Linux-specific syscall; we return -1/ENOSYS so callers
 * know it's unsupported but can still compile and run. */

#ifndef _SYS_PRCTL_H
#define _SYS_PRCTL_H

#include <errno.h>

#define PR_SET_PDEATHSIG  1
#define PR_GET_PDEATHSIG  2
#define PR_GET_DUMPABLE   3
#define PR_SET_DUMPABLE   4
#define PR_GET_UNALIGN    5
#define PR_SET_UNALIGN    6
#define PR_GET_KEEPCAPS   7
#define PR_SET_KEEPCAPS   8
#define PR_GET_FPEMU      9
#define PR_SET_FPEMU      10
#define PR_SET_NAME       15
#define PR_GET_NAME       16
#define PR_SET_CHILD_SUBREAPER 36
#define PR_GET_CHILD_SUBREAPER 37

static inline int prctl(int option, ...) {
    (void)option; errno = ENOSYS; return -1;
}

#endif /* _SYS_PRCTL_H */
