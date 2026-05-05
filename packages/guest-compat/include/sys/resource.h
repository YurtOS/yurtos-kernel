#ifndef YURT_COMPAT_SYS_RESOURCE_H
#define YURT_COMPAT_SYS_RESOURCE_H

/* wasi-libc has no <sys/resource.h>.  Provide the priority / rlimit /
 * rusage surface that POSIX programs reach for.  rlimit and rusage
 * are real symbols in libyurt_guest_compat.a (yurt_resource.c) so
 * they appear in the link's symbol table — autoconf probes that
 * test-link a function reference will find them.  getpriority /
 * setpriority / getrusage stay as static inline since they're truly
 * stateless no-ops. */

#include <errno.h>
#include <sys/time.h>
#include <sys/types.h>

#define PRIO_PROCESS 0
#define PRIO_PGRP    1
#define PRIO_USER    2

#include <stdint.h>

typedef uint64_t rlim_t;
struct rlimit {
    rlim_t rlim_cur;
    rlim_t rlim_max;
};

#define RLIMIT_CPU      0
#define RLIMIT_FSIZE    1
#define RLIMIT_DATA     2
#define RLIMIT_STACK    3
#define RLIMIT_CORE     4
#define RLIMIT_RSS      5
#define RLIMIT_NPROC    6
#define RLIMIT_NOFILE   7
#define RLIMIT_MEMLOCK  8
#define RLIMIT_AS       9
#define RLIMIT_LOCKS   10
#define RLIMIT_SIGPENDING 11
#define RLIMIT_MSGQUEUE 12
#define RLIMIT_NICE    13
#define RLIMIT_RTPRIO  14
#define RLIM_INFINITY ((rlim_t)-1)

struct rusage {
    struct timeval ru_utime;
    struct timeval ru_stime;
    long ru_maxrss, ru_ixrss, ru_idrss, ru_isrss;
    long ru_minflt, ru_majflt, ru_nswap;
    long ru_inblock, ru_oublock, ru_msgsnd, ru_msgrcv;
    long ru_nsignals, ru_nvcsw, ru_nivcsw;
};
#define RUSAGE_SELF     0
#define RUSAGE_CHILDREN (-1)

/* getpriority / setpriority / getrusage — real symbols (not static
 * inline) so gnulib's REPLACE_* probes accept them and skip
 * compiling its own replacements.  All are sandbox no-ops:
 * priorities default to 0, rusage zeroes the struct. */
int getpriority(int which, id_t who);
int setpriority(int which, id_t who, int prio);
int getrusage(int who, struct rusage *r);

/* Real impls in yurt_resource.c — provide per-resource defaults
 * (RLIMIT_NOFILE = 1024, RLIMIT_STACK = 1MB, etc.) instead of
 * blanket RLIM_INFINITY, so guest code that probes "is this absurdly
 * low / high" sees believable values. */
int getrlimit(int resource, struct rlimit *rlim);
int setrlimit(int resource, const struct rlimit *rlim);


#endif /* YURT_COMPAT_SYS_RESOURCE_H */
