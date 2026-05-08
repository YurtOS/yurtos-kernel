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
#include "yurt_abi.h"

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

int pipe(int fds[2]) {
  YURT_MARKER_CALL(pipe);

  if (fds == NULL) {
    errno = EFAULT;
    return -1;
  }

  yurt_pipe_result_v1 result;
  int n = yurt_host_pipe((int)(intptr_t)&result, (int)sizeof(result));
  if (n < 0) {
    errno = EIO;
    return -1;
  }
  if (n != (int)sizeof(result)) {
    errno = EIO;
    return -1;
  }

  fds[0] = result.read_fd;
  fds[1] = result.write_fd;
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
