#include <sched.h>

#include <errno.h>
#include <stddef.h>
#include <string.h>
#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(sched_getaffinity);
YURT_DECLARE_MARKER(sched_setaffinity);
YURT_DECLARE_MARKER(sched_getcpu);
YURT_DECLARE_MARKER(sched_getscheduler);
YURT_DECLARE_MARKER(sched_setscheduler);
YURT_DECLARE_MARKER(sched_getparam);
YURT_DECLARE_MARKER(sched_setparam);

YURT_DEFINE_MARKER(sched_getaffinity, 0x73676166u) /* sgaf */
YURT_DEFINE_MARKER(sched_setaffinity, 0x73736166u) /* ssaf */
YURT_DEFINE_MARKER(sched_getcpu,      0x73676370u) /* sgcp */
YURT_DEFINE_MARKER(sched_getscheduler, 0x73677363u) /* sgsc */
YURT_DEFINE_MARKER(sched_setscheduler, 0x73747363u) /* stsc */
YURT_DEFINE_MARKER(sched_getparam,     0x73677061u) /* sgpa */
YURT_DEFINE_MARKER(sched_setparam,     0x73747061u) /* stpa */

static int yurt_sched_validate_size(size_t cpusetsize) {
  if (cpusetsize < sizeof(cpu_set_t)) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int sched_getaffinity(pid_t pid, size_t cpusetsize, cpu_set_t *mask) {
  YURT_MARKER_CALL(sched_getaffinity);

  if (!mask) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sched_validate_size(cpusetsize) != 0) {
    return -1;
  }

  int rc = yurt_host_sched_getaffinity((int)pid, mask, cpusetsize);
  if (rc < 0) {
    errno = (rc == -22) ? EINVAL : (rc == -1) ? ESRCH : ENOSYS;
    return -1;
  }
  return 0;
}

int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask) {
  YURT_MARKER_CALL(sched_setaffinity);

  if (!mask) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sched_validate_size(cpusetsize) != 0) {
    return -1;
  }

  int rc = yurt_host_sched_setaffinity((int)pid, mask, cpusetsize);
  if (rc < 0) {
    errno = (rc == -22) ? EINVAL : (rc == -1) ? ESRCH : ENOSYS;
    return -1;
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
  YURT_MARKER_CALL(sched_getscheduler);
  int rc = yurt_host_sched_getscheduler((int)pid);
  if (rc < 0) {
    errno = (rc == -22) ? EINVAL : ESRCH;
    return -1;
  }
  return rc;
}

int sched_setscheduler(pid_t pid, int policy, const struct sched_param *param) {
  YURT_MARKER_CALL(sched_setscheduler);
  if (!param) {
    errno = EINVAL;
    return -1;
  }
  int rc = yurt_host_sched_setscheduler((int)pid, policy, param->sched_priority);
  if (rc < 0) {
    errno = (rc == -38) ? ENOSYS : (rc == -22) ? EINVAL : (rc == -2) ? EPERM : ESRCH;
    return -1;
  }
  return 0;
}

int sched_getparam(pid_t pid, struct sched_param *param) {
  YURT_MARKER_CALL(sched_getparam);
  if (!param) {
    errno = EINVAL;
    return -1;
  }
  int rc = yurt_host_sched_getparam((int)pid);
  if (rc < 0) {
    errno = (rc == -22) ? EINVAL : ESRCH;
    return -1;
  }
  param->sched_priority = rc;
  return 0;
}

int sched_setparam(pid_t pid, const struct sched_param *param) {
  YURT_MARKER_CALL(sched_setparam);
  if (!param) {
    errno = EINVAL;
    return -1;
  }
  int rc = yurt_host_sched_setparam((int)pid, param->sched_priority);
  if (rc < 0) {
    errno = (rc == -38) ? ENOSYS : (rc == -22) ? EINVAL : (rc == -2) ? EPERM : ESRCH;
    return -1;
  }
  return 0;
}
