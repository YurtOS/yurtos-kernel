/* getrlimit(2) / setrlimit(2) — wasi-sdk declares them in
 * <sys/resource.h> but ships no implementation.  Yurt routes them
 * to the host process kernel so limits are inherited and enforceable
 * by the backend.  RLIMIT_NOFILE is enforced by WASI path_open. */

#include "yurt_markers.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <stddef.h>
#include <sys/resource.h>

YURT_DECLARE_MARKER(getrlimit);
YURT_DECLARE_MARKER(setrlimit);

YURT_DEFINE_MARKER(getrlimit, 0x67726c6du) /* "grlm" */
YURT_DEFINE_MARKER(setrlimit, 0x73726c6du) /* "srlm" */

__attribute__((visibility("default")))
int getrlimit(int resource, struct rlimit *rlim) {
  YURT_MARKER_CALL(getrlimit);

  if (rlim == NULL) {
    errno = EFAULT;
    return -1;
  }

  int rc = yurt_host_getrlimit(resource, rlim);
  if (rc < 0) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

__attribute__((visibility("default")))
int setrlimit(int resource, const struct rlimit *rlim) {
  YURT_MARKER_CALL(setrlimit);

  if (rlim == NULL) {
    errno = EFAULT;
    return -1;
  }

  int rc = yurt_host_setrlimit(resource, rlim->rlim_cur, rlim->rlim_max);
  if (rc < 0) {
    errno = rc == -2 ? EPERM : EINVAL;
    return -1;
  }
  return 0;
}
