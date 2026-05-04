#ifndef YURT_COMPAT_SYS_SYSINFO_H
#define YURT_COMPAT_SYS_SYSINFO_H

/* sysinfo(2) — Linux extension that wasi-libc doesn't ship.  Yurt
 * provides a real implementation in libyurt_guest_compat
 * (yurt_sysinfo.c) that reads /proc/uptime, /proc/meminfo, and
 * /proc/loadavg, so callers see live values rather than constants.
 *
 * The struct layout matches Linux's so existing C code (BusyBox,
 * sysstat, gnulib, etc.) keeps working unchanged. */

#include <sys/types.h>

struct sysinfo {
    long uptime;             /* seconds since boot */
    unsigned long loads[3];  /* 1/5/15 min load averages, fixed-point (<<16) */
    unsigned long totalram;  /* total usable main memory size, in mem_unit */
    unsigned long freeram;
    unsigned long sharedram;
    unsigned long bufferram;
    unsigned long totalswap;
    unsigned long freeswap;
    unsigned short procs;    /* number of current processes */
    unsigned short pad;
    unsigned long totalhigh;
    unsigned long freehigh;
    unsigned int mem_unit;   /* size of mem_unit fields in bytes */
    char _f[20 - 2 * sizeof(long) - sizeof(int)]; /* pad to 64 bytes */
};

int sysinfo(struct sysinfo *info);

#endif /* YURT_COMPAT_SYS_SYSINFO_H */
