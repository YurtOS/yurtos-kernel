#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/select.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(select);
YURT_DEFINE_MARKER(select, 0x73656c65u) /* "sele" */

static int yurt_select_timeout_ms(const struct timeval *timeout) {
  if (timeout == NULL) return -1;
  if (timeout->tv_sec < 0 || timeout->tv_usec < 0 ||
      timeout->tv_usec >= 1000000) {
    errno = EINVAL;
    return -2;
  }

  unsigned long long ms = (unsigned long long)timeout->tv_sec * 1000ull;
  ms += ((unsigned long long)timeout->tv_usec + 999ull) / 1000ull;
  return ms > (unsigned long long)INT_MAX ? INT_MAX : (int)ms;
}

static int yurt_select_impl(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    struct timeval *timeout) {
  YURT_MARKER_CALL(select);

  if (nfds < 0 || nfds > FD_SETSIZE) {
    errno = EINVAL;
    return -1;
  }

  int timeout_ms = yurt_select_timeout_ms(timeout);
  if (timeout_ms == -2) return -1;

  if (nfds == 0) {
    int rc = yurt_host_poll(0, 0, timeout_ms);
    if (rc < 0) {
      errno = -rc;
      return -1;
    }
    return 0;
  }

  struct pollfd pollfds[FD_SETSIZE];
  int indexes[FD_SETSIZE];
  int active = 0;

  for (int fd = 0; fd < nfds; fd++) {
    short events = 0;
    if (readfds != NULL && FD_ISSET(fd, readfds)) events |= POLLIN;
    if (writefds != NULL && FD_ISSET(fd, writefds)) events |= POLLOUT;
    if (exceptfds != NULL && FD_ISSET(fd, exceptfds)) events |= POLLERR;
    if (events == 0) continue;

    indexes[active] = fd;
    pollfds[active].fd = fd;
    pollfds[active].events = events;
    pollfds[active].revents = 0;
    active++;
  }

  int rc = yurt_host_poll((int)(intptr_t)pollfds, active, timeout_ms);
  if (rc < 0) {
    errno = -rc;
    return -1;
  }

  if (readfds != NULL) FD_ZERO(readfds);
  if (writefds != NULL) FD_ZERO(writefds);
  if (exceptfds != NULL) FD_ZERO(exceptfds);

  int ready = 0;
  for (int i = 0; i < active; i++) {
    int fd = indexes[i];
    short revents = pollfds[i].revents;
    if ((revents & POLLNVAL) != 0) {
      errno = EBADF;
      return -1;
    }

    if (readfds != NULL &&
        (revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
      FD_SET(fd, readfds);
      ready++;
    }
    if (writefds != NULL && (revents & (POLLOUT | POLLERR)) != 0) {
      FD_SET(fd, writefds);
      ready++;
    }
    if (exceptfds != NULL && (revents & POLLERR) != 0) {
      FD_SET(fd, exceptfds);
      ready++;
    }
  }

  return ready;
}

int select(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    struct timeval *timeout) {
  return yurt_select_impl(nfds, readfds, writefds, exceptfds, timeout);
}

int __wrap_select(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    struct timeval *timeout) {
  return yurt_select_impl(nfds, readfds, writefds, exceptfds, timeout);
}
