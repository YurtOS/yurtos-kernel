#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <stdint.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(poll);
YURT_DEFINE_MARKER(poll, 0x706f6c6cu) /* "poll" */

_Static_assert(sizeof(void *) == 4, "libyurt ABI requires wasm32 pointers");
_Static_assert(sizeof(struct pollfd) == 8, "pollfd layout mismatch");
_Static_assert(POLLERR == 0x0008, "poll ABI expects Linux POLLERR");
_Static_assert(POLLHUP == 0x0010, "poll ABI expects Linux POLLHUP");
_Static_assert(POLLNVAL == 0x0020, "poll ABI expects Linux POLLNVAL");

static int yurt_poll_impl(struct pollfd *fds, nfds_t nfds, int timeout) {
  YURT_MARKER_CALL(poll);
  if (nfds > (nfds_t)INT_MAX) {
    errno = EINVAL;
    return -1;
  }
  if (nfds > 0 && fds == NULL) {
    errno = EFAULT;
    return -1;
  }

  int rc = yurt_host_poll((int)(intptr_t)fds, (int)nfds, timeout);
  if (rc < 0) {
    errno = -rc;
    return -1;
  }
  return rc;
}

int poll(struct pollfd *fds, nfds_t nfds, int timeout) {
  return yurt_poll_impl(fds, nfds, timeout);
}

int __wrap_poll(struct pollfd *fds, nfds_t nfds, int timeout) {
  return yurt_poll_impl(fds, nfds, timeout);
}
