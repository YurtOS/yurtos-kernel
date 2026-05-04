/* sysinfo(2) — Linux-style system info, sourced from the yurt
 * /proc files (proc-provider.ts in the kernel):
 *   /proc/uptime   "<seconds_up> <seconds_idle>"
 *   /proc/meminfo  "MemTotal: NNNN kB\nMemFree: ...\n..."
 *   /proc/loadavg  "<1m> <5m> <15m> <runnable>/<total> <last_pid>"
 *
 * Everything goes through fopen/fscanf — no host imports — because
 * /proc is already a first-class VFS surface.  This means future work
 * on per-PID proc and load sampling lands in proc-provider.ts and
 * sysinfo() picks it up for free.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysinfo.h>
#include <unistd.h>

#include "yurt_markers.h"

YURT_DECLARE_MARKER(sysinfo);
YURT_DEFINE_MARKER(sysinfo, 0x73797369u) /* sysi */

/* Linux's loadavg fields are fixed-point with FSHIFT=16. */
#define YURT_LOADAVG_FSHIFT 16

static long yurt_read_uptime_seconds(void) {
    FILE *f = fopen("/proc/uptime", "r");
    if (!f) return 0;
    double up = 0.0;
    if (fscanf(f, "%lf", &up) != 1) up = 0.0;
    fclose(f);
    if (up < 0) up = 0;
    return (long)up;
}

static void yurt_read_meminfo(unsigned long *totalram_kb,
                                 unsigned long *freeram_kb,
                                 unsigned long *bufferram_kb,
                                 unsigned long *cached_kb) {
    *totalram_kb = *freeram_kb = *bufferram_kb = *cached_kb = 0;
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f) return;
    char line[256];
    while (fgets(line, sizeof line, f)) {
        unsigned long v = 0;
        if (sscanf(line, "MemTotal: %lu kB", &v) == 1) *totalram_kb = v;
        else if (sscanf(line, "MemFree: %lu kB", &v) == 1) *freeram_kb = v;
        else if (sscanf(line, "Buffers: %lu kB", &v) == 1) *bufferram_kb = v;
        else if (sscanf(line, "Cached: %lu kB", &v) == 1) *cached_kb = v;
    }
    fclose(f);
}

static void yurt_read_loadavg(unsigned long loads[3], unsigned short *procs) {
    loads[0] = loads[1] = loads[2] = 0;
    *procs = 0;
    FILE *f = fopen("/proc/loadavg", "r");
    if (!f) return;
    double l1 = 0, l5 = 0, l15 = 0;
    unsigned int running = 0, total = 0, last_pid = 0;
    /* "1m 5m 15m running/total last_pid" */
    int matched = fscanf(f, "%lf %lf %lf %u/%u %u",
                         &l1, &l5, &l15, &running, &total, &last_pid);
    fclose(f);
    if (matched >= 3) {
        loads[0] = (unsigned long)(l1 * (1UL << YURT_LOADAVG_FSHIFT));
        loads[1] = (unsigned long)(l5 * (1UL << YURT_LOADAVG_FSHIFT));
        loads[2] = (unsigned long)(l15 * (1UL << YURT_LOADAVG_FSHIFT));
    }
    if (matched >= 5) {
        *procs = (unsigned short)total;
    }
}

int sysinfo(struct sysinfo *info) {
    YURT_MARKER_CALL(sysinfo);
    if (!info) {
        errno = EFAULT;
        return -1;
    }
    memset(info, 0, sizeof *info);
    info->mem_unit = 1024;  /* report memory in KiB units */

    info->uptime = yurt_read_uptime_seconds();
    yurt_read_loadavg(info->loads, &info->procs);

    unsigned long mem_total_kb, mem_free_kb, buffer_kb, cached_kb;
    yurt_read_meminfo(&mem_total_kb, &mem_free_kb, &buffer_kb, &cached_kb);
    info->totalram = mem_total_kb;
    info->freeram = mem_free_kb;
    info->bufferram = buffer_kb;
    info->sharedram = cached_kb;  /* approximation: cached pages */

    /* Swap isn't modelled.  totalhigh/freehigh are zero. */
    return 0;
}
