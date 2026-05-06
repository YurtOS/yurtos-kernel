/* pipe(2) / pipe2(2) — wired through to the yurt kernel.
 *
 * wasi-libc has no pipe primitive (the WASI spec has no native pipe;
 * pipes are a kernel-managed concept).  Yurt's process kernel
 * already creates pipes for shell pipelines via host_pipe.  This
 * file exposes the standard POSIX names so guest C code that just
 * calls pipe()/pipe2() — most upstream Unix C — gets a working
 * pipe without having to know about the host-import shape.
 *
 * pipe2(fds, flags) is a Linux extension that bundles the create-
 * with-flags path.  We accept the call but ignore most flags:
 *   - O_CLOEXEC    mark both descriptors close-on-exec in the kernel
 *   - O_NONBLOCK   we don't currently expose nonblocking pipes; the
 *                  flag is ignored, and the caller will see standard
 *                  blocking semantics.  Adding fcntl-driven O_NONBLOCK
 *                  on existing pipe fds is a separate item.
 *   - O_DIRECT     Linux-only "packet" mode; ignored.
 */

#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

YURT_DECLARE_MARKER(pipe);
YURT_DECLARE_MARKER(pipe2);

YURT_DEFINE_MARKER(pipe,  0x70697065u) /* "pipe" */
YURT_DEFINE_MARKER(pipe2, 0x70697032u) /* "pip2" */

/* Tiny inline parser: pull an unsigned-decimal field value from the
 * `{"read_fd":N,"write_fd":M}` JSON the host writes.  We don't pull
 * in the bigger yurt_command JSON helpers because pipe() is on
 * the hot path — startup of any pipeline-using program ends up here.
 *
 * Returns 0 on success and writes the parsed int into *out, or -1
 * if the field is missing or not a non-negative integer literal. */
static int pipe_parse_int_field(const char *json, size_t json_len,
                                const char *field, int *out) {
  char needle[16];
  int written = snprintf(needle, sizeof(needle), "\"%s\":", field);
  if (written <= 0 || (size_t)written >= sizeof(needle)) {
    return -1;
  }
  size_t needle_len = (size_t)written;
  if (needle_len > json_len) {
    return -1;
  }
  for (size_t i = 0; i + needle_len <= json_len; ++i) {
    if (memcmp(json + i, needle, needle_len) != 0) continue;
    const char *p = json + i + needle_len;
    const char *end = json + json_len;
    int val = 0;
    int saw = 0;
    while (p < end && *p >= '0' && *p <= '9') {
      val = val * 10 + (*p - '0');
      saw = 1;
      ++p;
    }
    if (!saw) return -1;
    *out = val;
    return 0;
  }
  return -1;
}

int pipe(int fds[2]) {
  YURT_MARKER_CALL(pipe);

  if (fds == NULL) {
    errno = EFAULT;
    return -1;
  }

  /* 64 bytes is enough for `{"read_fd":<10>,"write_fd":<10>}` (32
   * chars max).  Stack-allocated to keep pipe() malloc-free. */
  char buf[64];
  int n = yurt_host_pipe((int)(intptr_t)buf, (int)sizeof(buf));
  if (n <= 0 || (size_t)n > sizeof(buf)) {
    errno = EIO;
    return -1;
  }

  int rfd = -1, wfd = -1;
  if (pipe_parse_int_field(buf, (size_t)n, "read_fd", &rfd) != 0 ||
      pipe_parse_int_field(buf, (size_t)n, "write_fd", &wfd) != 0) {
    errno = EIO;
    return -1;
  }

  fds[0] = rfd;
  fds[1] = wfd;
  return 0;
}

int pipe2(int fds[2], int flags) {
  YURT_MARKER_CALL(pipe2);
  if (pipe(fds) != 0) return -1;
  if ((flags & O_CLOEXEC) != 0) {
    if (yurt_host_set_fd_descriptor_flags(fds[0], FD_CLOEXEC) != 0 ||
        yurt_host_set_fd_descriptor_flags(fds[1], FD_CLOEXEC) != 0) {
      int saved = errno;
      close(fds[0]);
      close(fds[1]);
      errno = saved ? saved : EBADF;
      return -1;
    }
  }
  return 0;
}
