/* dup(2) and dup3(2) — the yurt kernel manages every fd that
 * crosses a process boundary, so dup'ing them needs to go through
 * the host.  wasi-libc has neither (the WASI core spec doesn't have
 * dup; only `fd_renumber`, which is dup2's semantics).
 *
 * dup3 is a Linux extension that bundles dup2 with an O_CLOEXEC
 * flag.  Since yurt has no exec(), CLOEXEC is implicit and the
 * flag bit is harmless to ignore — we forward to dup2 unconditionally.
 */

#include "yurt_runtime.h"
#include "yurt_markers.h"

#define YURT_FCNTL_NO_REMAP
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <wasi/api.h>

YURT_DECLARE_MARKER(dup);
YURT_DECLARE_MARKER(dup3);
YURT_DECLARE_MARKER(fcntl);

YURT_DEFINE_MARKER(dup,  0x64757020u) /* "dup " */
YURT_DEFINE_MARKER(dup3, 0x64757033u) /* "dup3" */
YURT_DEFINE_MARKER(fcntl, 0x66636e74u) /* "fcnt" */

static int yurt_fd_status_flags[65536];
static int yurt_fd_descriptor_flags[65536];

static int yurt_fd_get_status_flags(int fd) {
  if (fd < 0 || fd >= (int)(sizeof(yurt_fd_status_flags) / sizeof(yurt_fd_status_flags[0]))) {
    return 0;
  }
  return yurt_fd_status_flags[fd];
}

static void yurt_fd_set_status_flags(int fd, int flags) {
  if (fd < 0 || fd >= (int)(sizeof(yurt_fd_status_flags) / sizeof(yurt_fd_status_flags[0]))) {
    return;
  }
  yurt_fd_status_flags[fd] = flags;
}

static int yurt_fd_get_descriptor_flags(int fd) {
  if (fd < 0 || fd >= (int)(sizeof(yurt_fd_descriptor_flags) / sizeof(yurt_fd_descriptor_flags[0]))) {
    return 0;
  }
  return yurt_fd_descriptor_flags[fd];
}

static void yurt_fd_set_descriptor_flags(int fd, int flags) {
  if (fd < 0 || fd >= (int)(sizeof(yurt_fd_descriptor_flags) / sizeof(yurt_fd_descriptor_flags[0]))) {
    return;
  }
  yurt_fd_descriptor_flags[fd] = flags;
}

static int yurt_fd_apply_descriptor_flags(int fd, int flags) {
  flags &= FD_CLOEXEC;
  if (yurt_host_set_fd_descriptor_flags(fd, flags) != 0) {
    errno = EBADF;
    return -1;
  }
  yurt_fd_set_descriptor_flags(fd, flags);
  return 0;
}

int yurt_socket_is_tracked_fd(int fd);
int yurt_socket_is_guest_fd(int fd);
int yurt_socket_dup_fd(int fd);
int yurt_socket_dup_fd_min(int fd, int min_fd);
int yurt_socket_get_status_flags(int fd);
int yurt_socket_set_status_flags(int fd, int flags);
int yurt_socket_get_descriptor_flags(int fd);
int yurt_socket_set_descriptor_flags(int fd, int flags);

int dup(int oldfd) {
  YURT_MARKER_CALL(dup);

  if (oldfd < 0) {
    errno = EBADF;
    return -1;
  }
  if (yurt_socket_is_guest_fd(oldfd)) {
    return yurt_socket_dup_fd(oldfd);
  }

  int32_t new_fd = -1;
  int n = yurt_host_dup(oldfd, (int)(intptr_t)&new_fd, (int)sizeof(new_fd));
  if (n < 0) {
    errno = EBADF;
    return -1;
  }
  if (n != (int)sizeof(new_fd) || new_fd < 0) {
    errno = EBADF;
    return -1;
  }
  return (int)new_fd;
}

int dup3(int oldfd, int newfd, int flags) {
  YURT_MARKER_CALL(dup3);

  /* Linux dup3 differs from dup2 in two ways:
   *   1. It always closes newfd if it differs (dup2 already does this).
   *   2. It rejects the no-op case `oldfd == newfd` with EINVAL.
   *   3. It accepts an O_CLOEXEC bit; any other bit is EINVAL.
   * We honor (2) and (3); (1) is implicit in our dup2. */
  if (oldfd == newfd) {
    errno = EINVAL;
    return -1;
  }
  if ((flags & ~O_CLOEXEC) != 0) {
    errno = EINVAL;
    return -1;
  }
  int rc = dup2(oldfd, newfd);
  if (rc < 0) return rc;
  if ((flags & O_CLOEXEC) != 0 && yurt_fd_apply_descriptor_flags(newfd, FD_CLOEXEC) != 0) {
    return -1;
  }
  return rc;
}

static int yurt_fcntl_impl(int fd, int cmd, va_list ap) {
  YURT_MARKER_CALL(fcntl);

  switch (cmd) {
    case F_DUPFD:
#ifdef F_DUPFD_CLOEXEC
    case F_DUPFD_CLOEXEC:
#endif
    {
      int min_fd = va_arg(ap, int);
      if (fd < 0 || min_fd < 0) {
        errno = EINVAL;
        return -1;
      }

      int new_fd = yurt_socket_is_guest_fd(fd)
        ? yurt_socket_dup_fd_min(fd, min_fd)
        : yurt_host_dup_min(fd, min_fd);
      if (new_fd < 0) {
        errno = EBADF;
        return -1;
      }
#ifdef F_DUPFD_CLOEXEC
      if (cmd == F_DUPFD_CLOEXEC) {
        int rc = yurt_socket_is_guest_fd(new_fd)
          ? yurt_socket_set_descriptor_flags(new_fd, FD_CLOEXEC)
          : yurt_fd_apply_descriptor_flags(new_fd, FD_CLOEXEC);
        if (rc != 0) {
          close(new_fd);
          return -1;
        }
      }
#endif
      return new_fd;
    }

    case F_GETFD:
      if (fd < 0) {
        errno = EBADF;
        return -1;
      }
      if (yurt_socket_is_tracked_fd(fd)) {
        return yurt_socket_get_descriptor_flags(fd);
      }
      return yurt_fd_get_descriptor_flags(fd);

    case F_SETFD: {
      int flags = va_arg(ap, int);
      if (fd < 0) {
        errno = EBADF;
        return -1;
      }
      if (yurt_socket_is_tracked_fd(fd)) {
        return yurt_socket_set_descriptor_flags(fd, flags);
      }
      if (yurt_fd_apply_descriptor_flags(fd, flags) != 0) {
        return -1;
      }
      return 0;
    }

    case F_GETFL: {
      if (yurt_socket_is_tracked_fd(fd)) {
        return O_RDWR | yurt_socket_get_status_flags(fd);
      }
      __wasi_fdstat_t st;
      __wasi_errno_t rc = __wasi_fd_fdstat_get((__wasi_fd_t)fd, &st);
      if (rc != __WASI_ERRNO_SUCCESS) {
        errno = EBADF;
        return -1;
      }
      int flags = 0;
      int can_read = (st.fs_rights_base & __WASI_RIGHTS_FD_READ) != 0;
      int can_write = (st.fs_rights_base & __WASI_RIGHTS_FD_WRITE) != 0;
      if (can_read && can_write) flags |= O_RDWR;
      else if (can_write) flags |= O_WRONLY;
      else if (can_read) flags |= O_RDONLY;
      if ((st.fs_flags & __WASI_FDFLAGS_APPEND) != 0) flags |= O_APPEND;
      if ((st.fs_flags & __WASI_FDFLAGS_NONBLOCK) != 0) flags |= O_NONBLOCK;
      flags |= yurt_fd_get_status_flags(fd);
      return flags;
    }

    case F_SETFL: {
      int flags = va_arg(ap, int);
      if (yurt_socket_is_tracked_fd(fd)) {
        return yurt_socket_set_status_flags(
          fd,
          flags & (O_APPEND | O_NONBLOCK | O_DSYNC | O_SYNC | O_RSYNC)
        );
      }
      __wasi_fdstat_t st;
      __wasi_errno_t rc = __wasi_fd_fdstat_get((__wasi_fd_t)fd, &st);
      if (rc != __WASI_ERRNO_SUCCESS) {
        errno = EBADF;
        return -1;
      }
      __wasi_fdflags_t fdflags = st.fs_flags;
      if ((flags & O_APPEND) != 0) fdflags |= __WASI_FDFLAGS_APPEND;
      else fdflags &= ~__WASI_FDFLAGS_APPEND;
      if ((flags & O_NONBLOCK) != 0) fdflags |= __WASI_FDFLAGS_NONBLOCK;
      else fdflags &= ~__WASI_FDFLAGS_NONBLOCK;
      rc = __wasi_fd_fdstat_set_flags((__wasi_fd_t)fd, fdflags);
      if (rc != __WASI_ERRNO_SUCCESS) {
        errno = EINVAL;
        return -1;
      }
      yurt_fd_set_status_flags(fd, flags & (O_APPEND | O_NONBLOCK | O_DSYNC | O_SYNC | O_RSYNC));
      return 0;
    }

    default:
      errno = EINVAL;
      return -1;
  }
}

int fcntl(int fd, int cmd, ...) {
  va_list ap;
  va_start(ap, cmd);
  int result = yurt_fcntl_impl(fd, cmd, ap);
  va_end(ap);
  return result;
}

int yurt_fcntl(int fd, int cmd, ...) {
  va_list ap;
  va_start(ap, cmd);
  int result = yurt_fcntl_impl(fd, cmd, ap);
  va_end(ap);
  return result;
}

int __wrap_fcntl(int fd, int cmd, ...) {
  va_list ap;
  va_start(ap, cmd);
  int result = yurt_fcntl_impl(fd, cmd, ap);
  va_end(ap);
  return result;
}
