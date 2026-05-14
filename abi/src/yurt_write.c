#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <unistd.h>
#include <wasi/api.h>

ssize_t write(int fd, const void *buf, size_t count) {
  __wasi_ciovec_t iov;
  __wasi_size_t written = 0;
  __wasi_errno_t rc;

  iov.buf = buf;
  iov.buf_len = count;
  rc = __wasi_fd_write((__wasi_fd_t)fd, &iov, 1, &written);
  if (rc != __WASI_ERRNO_SUCCESS) {
    errno = (int)rc;
    if (rc == __WASI_ERRNO_PIPE) {
      raise(SIGPIPE);
    }
    return -1;
  }
  return (ssize_t)written;
}
