#include <sched.h>

#include <errno.h>
#include <stddef.h>
#include <string.h>
#include "yurt_markers.h"

YURT_DECLARE_MARKER(sched_getaffinity);
YURT_DECLARE_MARKER(sched_setaffinity);
YURT_DECLARE_MARKER(sched_getcpu);

YURT_DEFINE_MARKER(sched_getaffinity, 0x73676166u) /* sgaf */
YURT_DEFINE_MARKER(sched_setaffinity, 0x73736166u) /* ssaf */
YURT_DEFINE_MARKER(sched_getcpu,      0x73676370u) /* sgcp */

static int yurt_sched_validate_size(size_t cpusetsize) {
  if (cpusetsize < sizeof(cpu_set_t)) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask) {
  YURT_MARKER_CALL(sched_getaffinity);
  (void)pid;

  if (!mask) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sched_validate_size(cpusetsize) != 0) {
    return -1;
  }

  memset(mask, 0, cpusetsize);
  CPU_SET(0, mask);
  return 0;
}

int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask) {
  YURT_MARKER_CALL(sched_setaffinity);
  const unsigned char *bytes;
  size_t i;
  unsigned long first_word;

  (void)pid;

  if (!mask) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sched_validate_size(cpusetsize) != 0) {
    return -1;
  }

  first_word = mask->__bits[0];
  if (first_word != 1ul) {
    errno = EINVAL;
    return -1;
  }

  bytes = (const unsigned char *)mask;
  for (i = sizeof(unsigned long); i < cpusetsize; ++i) {
    if (bytes[i] != 0) {
      errno = EINVAL;
      return -1;
    }
  }

  return 0;
}

int sched_getcpu(void) {
  YURT_MARKER_CALL(sched_getcpu);
  return 0;
}

int sched_get_priority_max(int policy) {
  return (policy == SCHED_FIFO || policy == SCHED_RR) ? 99 : 0;
}

int sched_get_priority_min(int policy) {
  return (policy == SCHED_FIFO || policy == SCHED_RR) ? 1 : 0;
}

int sched_getscheduler(pid_t pid) {
  (void)pid; return SCHED_OTHER;
}

int sched_setscheduler(pid_t pid, int policy, const struct sched_param *param) {
  (void)pid; (void)policy; (void)param;
  errno = EPERM; return -1;
}

int sched_getparam(pid_t pid, struct sched_param *param) {
  (void)pid;
  if (param) param->sched_priority = 0;
  return 0;
}

int sched_setparam(pid_t pid, const struct sched_param *param) {
  (void)pid; (void)param;
  errno = EPERM; return -1;
}
