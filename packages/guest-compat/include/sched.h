#ifndef YURT_COMPAT_SCHED_H
#define YURT_COMPAT_SCHED_H

#include <stddef.h>
#include <sys/types.h>

#define CPU_SETSIZE (8 * sizeof(unsigned long))

typedef struct {
  unsigned long __bits[1];
} cpu_set_t;

#define CPU_ZERO(set) ((set)->__bits[0] = 0ul)
#define CPU_SET(cpu, set) ((void)((cpu) < CPU_SETSIZE ? ((set)->__bits[0] |= (1ul << (cpu))) : 0))
#define CPU_CLR(cpu, set) ((void)((cpu) < CPU_SETSIZE ? ((set)->__bits[0] &= ~(1ul << (cpu))) : 0))
#define CPU_ISSET(cpu, set) ((cpu) < CPU_SETSIZE ? (((set)->__bits[0] & (1ul << (cpu))) != 0) : 0)
#define CPU_COUNT(set) ((int)CPU_ISSET(0, (set)))

int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask);
int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask);
int sched_getcpu(void);
int sched_yield(void);

/* POSIX scheduling — wasi-libc has no <sched.h> beyond CPU sets, but
 * <spawn.h> needs `struct sched_param` for posix_spawnattr_setschedparam.
 * Yurt has no scheduling priority story (single-threaded sandbox);
 * we declare the struct so guest C compiles, and posix_spawnattr just
 * stores the value without honoring it. */
struct sched_param {
  int sched_priority;
};

#define SCHED_OTHER  0
#define SCHED_FIFO   1
#define SCHED_RR     2
#define SCHED_BATCH  3
#define SCHED_IDLE   5

#endif
