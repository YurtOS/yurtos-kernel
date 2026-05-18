#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(poll);
YURT_DEFINE_MARKER(poll, 0x706f6c6cu) /* "poll" */
YURT_DECLARE_MARKER(ppoll);
YURT_DEFINE_MARKER(ppoll, 0x70706f6cu) /* "ppol" */

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

/* Keep in sync with abi/src/yurt_select.c:yurt_compact_sigset_to_canonical
 * and abi/src/yurt_signal.c. */
static unsigned long long yurt_ppoll_sigset_to_canonical(sigset_t set) {
  static const unsigned long long slot_bits[8] = {
      1ull << (1 - 1),   1ull << (2 - 1),   1ull << (3 - 1),
      1ull << (15 - 1),  1ull << (17 - 1),  1ull << (28 - 1),
      1ull << (13 - 1),
      (1ull << (10 - 1)) | (1ull << (12 - 1)) | (1ull << (14 - 1)),
  };
  unsigned long long out = 0;
  unsigned bits = (unsigned)set;
  for (int slot = 0; slot < 8; slot++) {
    if (bits & (1u << slot)) out |= slot_bits[slot];
  }
  return out;
}

int ppoll(
    struct pollfd *fds,
    nfds_t nfds,
    const struct timespec *timeout,
    const sigset_t *sigmask) {
  YURT_MARKER_CALL(ppoll);
  if (nfds > (nfds_t)INT_MAX) {
    errno = EINVAL;
    return -1;
  }
  if (nfds > 0 && fds == NULL) {
    errno = EFAULT;
    return -1;
  }
  /* D3 — bound BEFORE any allocation. nfds_t is unsigned, multiplication
   * by 8 can overflow on wasm32 (32-bit size_t). Use a subtraction-form
   * guard against the documented 1 MiB cap. */
  if ((size_t)nfds > (SIZE_MAX - 24u) / 8u) {
    errno = EINVAL;
    return -1;
  }
  size_t tail = (size_t)nfds * 8u; /* 8 B per pollfd */
  size_t req_len = 24u + tail;
  if (req_len > YURT_MAX_REQUEST_LEN) {
    errno = EINVAL;
    return -1;
  }

  unsigned char *req = (unsigned char *)malloc(req_len);
  if (req == NULL) {
    errno = ENOMEM;
    return -1;
  }
  memset(req, 0, 24);

  if (timeout == NULL) {
    req[12] = 1; /* timeout_null */
  } else {
    int64_t s = (int64_t)timeout->tv_sec;
    int32_t n = (int32_t)timeout->tv_nsec;
    memcpy(req + 0, &s, 8);
    memcpy(req + 8, &n, 4);
  }
  if (sigmask == NULL) {
    req[13] = 1; /* sigmask_null */
  } else {
    unsigned long long m = yurt_ppoll_sigset_to_canonical(*sigmask);
    memcpy(req + 16, &m, 8);
  }
  if (tail > 0) memcpy(req + 24, fds, tail);

  long long rc = yurt_host_ppoll(
      (int)(intptr_t)req, (int)req_len, (int)(intptr_t)req + 24,
      (int)tail);
  if (rc >= 0 && tail > 0) memcpy(fds, req + 24, tail);
  free(req);
  if (rc < 0) {
    errno = (int)(-rc);
    return -1;
  }
  return (int)rc;
}

int __wrap_ppoll(
    struct pollfd *fds,
    nfds_t nfds,
    const struct timespec *timeout,
    const sigset_t *sigmask) {
  return ppoll(fds, nfds, timeout, sigmask);
}
