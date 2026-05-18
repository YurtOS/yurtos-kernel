#include <errno.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(epoll_create1);
YURT_DEFINE_MARKER(epoll_create1, 0x6570636cu) /* "epcl" */
YURT_DECLARE_MARKER(epoll_ctl);
YURT_DEFINE_MARKER(epoll_ctl, 0x65706374u) /* "epct" */
YURT_DECLARE_MARKER(epoll_wait);
YURT_DEFINE_MARKER(epoll_wait, 0x65707774u) /* "epwt" */

_Static_assert(sizeof(void *) == 4, "libyurt ABI requires wasm32 pointers");
_Static_assert(
    sizeof(struct epoll_event) == 12,
    "epoll_event ABI wire size: 12 B packed (u32 events + u64 data)");

/* Request byte-buffer marshalling lives in safe Rust
 * (abi/rust/yurt-libc/src/epoll.rs); this C file is a thin ABI shim that
 * only forwards (AGENTS.md: buffer/parse/format logic in Rust, C files
 * are thin shims). */
extern int yurt_rs_epoll_pack_ctl(unsigned char *out, unsigned int epfd,
                                  unsigned int op, unsigned int fd,
                                  const unsigned char *event);
extern int yurt_rs_epoll_pack_wait(unsigned char *out, unsigned int epfd,
                                   unsigned int maxevents, int timeout);

/* Linux-kernel errno -> wasi-libc errno translation. See the matching
 * helper + commentary in abi/src/yurt_select.c. */
static int yurt_epoll_errno_from_kernel(int kernel_errno) {
  switch (kernel_errno) {
    case 1:  return EPERM;
    case 2:  return ENOENT;
    case 5:  return EIO;
    case 9:  return EBADF;
    case 11: return EAGAIN;
    case 14: return EFAULT;
    case 17: return EEXIST;
    case 20: return ENOTDIR;
    case 22: return EINVAL;
    case 24: return EMFILE;
    case 32: return EPIPE;
    case 38: return ENOSYS;
    case 40: return ELOOP;
    default: return kernel_errno;
  }
}

int epoll_create1(int flags) {
  YURT_MARKER_CALL(epoll_create1);
  uint32_t req = (uint32_t)flags;
  long long rc = yurt_host_epoll_create1(
      (int)(intptr_t)&req, (int)sizeof(req), 0, 0);
  if (rc < 0) {
    errno = yurt_epoll_errno_from_kernel((int)(-rc));
    return -1;
  }
  return (int)rc;
}

int __wrap_epoll_create1(int flags) { return epoll_create1(flags); }

int epoll_ctl(int epfd, int op, int fd, struct epoll_event *event) {
  YURT_MARKER_CALL(epoll_ctl);
  /* Request: u32 epfd + u32 op + u32 fd + 12-byte epoll_event = 24 B.
   * `event` may be NULL for EPOLL_CTL_DEL (Linux allows it since 2.6.9
   * but the wire still needs a 12-byte slot — zero-filled). */
  unsigned char req[24];
  yurt_rs_epoll_pack_ctl(req, (unsigned int)epfd, (unsigned int)op,
                         (unsigned int)fd, (const unsigned char *)event);
  long long rc = yurt_host_epoll_ctl(
      (int)(intptr_t)req, (int)sizeof(req), 0, 0);
  if (rc < 0) {
    errno = yurt_epoll_errno_from_kernel((int)(-rc));
    return -1;
  }
  return 0;
}

int __wrap_epoll_ctl(int epfd, int op, int fd, struct epoll_event *event) {
  return epoll_ctl(epfd, op, fd, event);
}

int epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout) {
  YURT_MARKER_CALL(epoll_wait);
  if (maxevents <= 0) {
    errno = EINVAL;
    return -1;
  }
  /* Bound the response buffer against the 1 MiB guest-buffer cap
   * (#65 length-math discipline). Each record is 12 B. */
  if ((size_t)maxevents > YURT_MAX_REQUEST_LEN / 12u) {
    errno = EINVAL;
    return -1;
  }
  size_t resp_len = (size_t)maxevents * 12u;
  unsigned char req[12];
  yurt_rs_epoll_pack_wait(req, (unsigned int)epfd, (unsigned int)maxevents,
                          timeout);
  long long rc = yurt_host_epoll_wait(
      (int)(intptr_t)req, (int)sizeof(req),
      (int)(intptr_t)events, (int)resp_len);
  if (rc < 0) {
    errno = yurt_epoll_errno_from_kernel((int)(-rc));
    return -1;
  }
  /* Kernel returns bytes-written = ready_count * 12. */
  return (int)(rc / 12);
}

int __wrap_epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout) {
  return epoll_wait(epfd, events, maxevents, timeout);
}
