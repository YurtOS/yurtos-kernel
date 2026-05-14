#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <unistd.h>
#include <wasi/api.h>

extern ssize_t __real_read(int fd, void *buf, size_t count);

ssize_t __wrap_read(int fd, void *buf, size_t count) {
  return __real_read(fd, buf, count);
}

static ssize_t yurt_write_impl(int fd, const void *buf, size_t count) {
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

ssize_t write(int fd, const void *buf, size_t count) {
  return yurt_write_impl(fd, buf, count);
}

ssize_t __wrap_write(int fd, const void *buf, size_t count) {
  return yurt_write_impl(fd, buf, count);
}
