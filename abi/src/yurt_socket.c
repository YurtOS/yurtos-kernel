#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <wasi/wasip1.h>

#ifndef SO_ERROR
#define SO_ERROR 0x1007
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef MSG_PEEK
#define MSG_PEEK 0x02
#endif
#ifndef SOL_IP
#define SOL_IP 0
#endif
#ifndef IP_BIND_ADDRESS_NO_PORT
#define IP_BIND_ADDRESS_NO_PORT 24
#endif

#define YURT_SO_REUSEADDR 0x0004
#define YURT_SO_ERROR 0x1007
#define YURT_SO_KEEPALIVE 9
#define YURT_MSG_PEEK 0x02
#define YURT_IPPROTO_TCP 6
#define YURT_TCP_NODELAY 1

YURT_DECLARE_MARKER(socket);
YURT_DECLARE_MARKER(socketpair);
YURT_DECLARE_MARKER(connect);
YURT_DECLARE_MARKER(getpeername);
YURT_DECLARE_MARKER(getsockname);
YURT_DECLARE_MARKER(bind);
YURT_DECLARE_MARKER(listen);
YURT_DECLARE_MARKER(accept);
YURT_DECLARE_MARKER(send);
YURT_DECLARE_MARKER(recv);
YURT_DECLARE_MARKER(shutdown);

YURT_DEFINE_MARKER(socket,     0x736f636bu) /* "sock" */
YURT_DEFINE_MARKER(socketpair, 0x73706169u) /* "spai" */
YURT_DEFINE_MARKER(connect,  0x636f6e6eu) /* "conn" */
YURT_DEFINE_MARKER(getpeername, 0x70656572u) /* "peer" */
YURT_DEFINE_MARKER(getsockname, 0x736e616du) /* "snam" */
YURT_DEFINE_MARKER(bind,     0x62696e64u) /* "bind" */
YURT_DEFINE_MARKER(listen,   0x6c73746eu) /* "lstn" */
YURT_DEFINE_MARKER(accept,   0x61636370u) /* "accp" */
YURT_DEFINE_MARKER(send,     0x73656e64u) /* "send" */
YURT_DEFINE_MARKER(recv,     0x72656376u) /* "recv" */
YURT_DEFINE_MARKER(shutdown, 0x73687574u) /* "shut" */

#define YURT_SOCKET_RECV_MAX_RAW 3000
#define YURT_SOCKET_ADDR_LOCAL 0u
#define YURT_SOCKET_ADDR_PEER 1u
#define YURT_SOCKET_OPT_TCP_NODELAY 1u

#define YURT_HOST_EPERM 1
#define YURT_HOST_EIO 5
#define YURT_HOST_EBADF 9
#define YURT_HOST_EACCES 13
#define YURT_HOST_EINVAL 22
#define YURT_HOST_EAGAIN 11
#define YURT_HOST_ECONNREFUSED 111
#define YURT_HOST_EOPNOTSUPP 95

/* wasi-libc already ships strong definitions for some POSIX socket names.
 * yurt-cc/cargo-yurt pass --wrap for the duplicate-owned symbols we implement
 * here (`accept`, `send`, `recv`, `getsockopt`) so Rust and C guests both route
 * through libyurt without using yurt-specific symbol names. */

typedef struct yurt_socket_addr_result_v1 {
  uint32_t host_be;
  uint16_t port_be;
  uint16_t reserved;
} yurt_socket_addr_result_v1;

typedef struct yurt_socket_accept_result_v1 {
  int fd;
  uint32_t peer_host_be;
  uint16_t peer_port_be;
  uint16_t local_port_be;
  uint32_t local_host_be;
} yurt_socket_accept_result_v1;

static int yurt_errno_from_host(int rc, int fallback) {
  if (rc >= 0) return fallback;
  switch (-rc) {
    case YURT_HOST_EPERM:
      return EPERM;
    case YURT_HOST_EIO:
      return EIO;
    case YURT_HOST_EBADF:
      return EBADF;
    case YURT_HOST_EACCES:
      return EACCES;
    case YURT_HOST_EINVAL:
      return EINVAL;
    case YURT_HOST_EAGAIN:
      return EAGAIN;
    case YURT_HOST_ECONNREFUSED:
      return ECONNREFUSED;
    case YURT_HOST_EOPNOTSUPP:
      return EOPNOTSUPP;
    default:
      return fallback;
  }
}

int socket(int domain, int type, int protocol) {
  YURT_MARKER_CALL(socket);

  if (domain != AF_INET || (type & SOCK_STREAM) != SOCK_STREAM) {
    errno = EAFNOSUPPORT;
    return -1;
  }

  int fd = yurt_host_socket_open(domain, type, protocol);
  if (fd < 0) {
    errno = EMFILE;
    return -1;
  }
  return fd;
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  YURT_MARKER_CALL(connect);
  char host[256];
  int rc;

  if (!addr || addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) {
    errno = EAFNOSUPPORT;
    return -1;
  }

  const struct sockaddr_in *in = (const struct sockaddr_in *)addr;
  const char *mapped_host = yurt_netdb_host_for_addr(in->sin_addr.s_addr);
  if (mapped_host) {
    if (strlen(mapped_host) >= sizeof(host)) {
      errno = EOVERFLOW;
      return -1;
    }
    strcpy(host, mapped_host);
  } else {
    if (!inet_ntop(AF_INET, &in->sin_addr, host, sizeof(host))) {
      errno = EINVAL;
      return -1;
    }
  }

  rc = yurt_host_socket_connect(
    sockfd,
    (int)(intptr_t)host,
    (int)strlen(host),
    (unsigned)ntohs(in->sin_port),
    0
  );
  if (rc < 0) {
    errno = yurt_errno_from_host(rc, ECONNREFUSED);
    return -1;
  }
  return 0;
}

static int yurt_fill_sockaddr_from_native(
  struct sockaddr *addr,
  socklen_t *addrlen,
  uint32_t host_be,
  uint16_t port_be
) {
  struct sockaddr_in in;

  if (!addr || !addrlen || *addrlen < (socklen_t)sizeof(in)) {
    errno = EINVAL;
    return -1;
  }

  memset(&in, 0, sizeof(in));
  in.sin_family = AF_INET;
  in.sin_port = port_be;
  in.sin_addr.s_addr = host_be;
  memcpy(addr, &in, sizeof(in));
  *addrlen = (socklen_t)sizeof(in);
  return 0;
}

static int yurt_sockaddr_to_host_port(
  const struct sockaddr *addr,
  socklen_t addrlen,
  char *host,
  size_t host_cap,
  int *port
) {
  const struct sockaddr_in *in;
  if (!addr || addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) {
    errno = EAFNOSUPPORT;
    return -1;
  }
  in = (const struct sockaddr_in *)addr;
  if (!inet_ntop(AF_INET, &in->sin_addr, host, host_cap)) {
    errno = EINVAL;
    return -1;
  }
  *port = (int)ntohs(in->sin_port);
  return 0;
}

static int yurt_sockname_impl(
  int sockfd,
  struct sockaddr *addr,
  socklen_t *addrlen,
  const char *kind,
  const char *host_field,
  const char *port_field
) {
  yurt_socket_addr_result_v1 result;
  int n;
  unsigned which = strcmp(host_field, "local_host") == 0
    ? YURT_SOCKET_ADDR_LOCAL
    : YURT_SOCKET_ADDR_PEER;

  (void)kind;
  (void)port_field;
  n = yurt_host_socket_addr(
    sockfd,
    which,
    (int)(intptr_t)&result,
    (int)sizeof(result)
  );
  if (n != (int)sizeof(result)) {
    errno = yurt_errno_from_host(n, ENOTCONN);
    return -1;
  }
  return yurt_fill_sockaddr_from_native(addr, addrlen, result.host_be, result.port_be);
}

int getpeername(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(getpeername);
  return yurt_sockname_impl(
    sockfd,
    addr,
    addrlen,
    "peer",
    "peer_host",
    "peer_port"
  );
}

int getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(getsockname);
  return yurt_sockname_impl(
    sockfd,
    addr,
    addrlen,
    "local",
    "local_host",
    "local_port"
  );
}

int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  YURT_MARKER_CALL(bind);
  char host[INET_ADDRSTRLEN];
  int port;
  int rc;

  if (yurt_sockaddr_to_host_port(addr, addrlen, host, sizeof(host), &port) != 0) {
    return -1;
  }
  rc = yurt_host_socket_bind(
    sockfd,
    (int)(intptr_t)host,
    (int)strlen(host),
    (unsigned)port
  );
  if (rc < 0) {
    errno = yurt_errno_from_host(rc, EOPNOTSUPP);
    return -1;
  }
  return 0;
}

int listen(int sockfd, int backlog) {
  YURT_MARKER_CALL(listen);
  int rc = yurt_host_socket_listen(sockfd, backlog);
  if (rc < 0) {
    if (rc == -YURT_HOST_EACCES ||
        rc == -YURT_HOST_EPERM ||
        rc == -YURT_HOST_EOPNOTSUPP) {
      errno = EOPNOTSUPP;
    } else {
      errno = yurt_errno_from_host(rc, EOPNOTSUPP);
    }
    return -1;
  }
  return 0;
}

static int yurt_accept_impl(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(accept);
  yurt_socket_accept_result_v1 accepted;
  int n;
  int attempts = 0;

  for (;;) {
    n = yurt_host_socket_accept(sockfd, (int)(intptr_t)&accepted, (int)sizeof(accepted));
    if (n == (int)sizeof(accepted)) break;
    if (n == -EAGAIN) {
      if (++attempts > 100000) {
        errno = EAGAIN;
        return -1;
      }
      yurt_host_yield();
      continue;
    }
    errno = yurt_errno_from_host(n, EOPNOTSUPP);
    return -1;
  }
  if (addr && addrlen && *addrlen >= sizeof(struct sockaddr_in)) {
    if (yurt_fill_sockaddr_from_native(addr, addrlen, accepted.peer_host_be, accepted.peer_port_be) != 0) {
      return -1;
    }
  } else if (addrlen) {
    *addrlen = sizeof(struct sockaddr_in);
  }
  return accepted.fd;
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return yurt_accept_impl(sockfd, addr, addrlen);
}

int __wrap_accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return yurt_accept_impl(sockfd, addr, addrlen);
}

static ssize_t yurt_send_impl(int sockfd, const void *buf, size_t len, int flags) {
  YURT_MARKER_CALL(send);
  int n;

  if (len > (size_t)INT32_MAX) {
    errno = EOVERFLOW;
    return -1;
  }
  n = yurt_host_socket_send(sockfd, (int)(intptr_t)buf, (int)len, flags);
  if (n < 0) {
    errno = yurt_errno_from_host(n, EIO);
    return -1;
  }
  return (ssize_t)n;
}

ssize_t send(int sockfd, const void *buf, size_t len, int flags) {
  return yurt_send_impl(sockfd, buf, len, flags);
}

ssize_t __wrap_send(int sockfd, const void *buf, size_t len, int flags) {
  return yurt_send_impl(sockfd, buf, len, flags);
}

static ssize_t yurt_recv_impl(int sockfd, void *buf, size_t len, int flags) {
  YURT_MARKER_CALL(recv);
  int n;

  if (flags != 0 && flags != MSG_PEEK && flags != YURT_MSG_PEEK) {
    errno = EOPNOTSUPP;
    return -1;
  }

  if (len > YURT_SOCKET_RECV_MAX_RAW) {
    len = YURT_SOCKET_RECV_MAX_RAW;
  }

  if (len > (size_t)INT32_MAX) {
    errno = EOVERFLOW;
    return -1;
  }
  n = yurt_host_socket_recv(sockfd, (int)(intptr_t)buf, (int)len, flags);
  if (n < 0) {
    errno = yurt_errno_from_host(n, EIO);
    return -1;
  }
  return (ssize_t)n;
}

ssize_t recv(int sockfd, void *buf, size_t len, int flags) {
  return yurt_recv_impl(sockfd, buf, len, flags);
}

ssize_t __wrap_recv(int sockfd, void *buf, size_t len, int flags) {
  return yurt_recv_impl(sockfd, buf, len, flags);
}

ssize_t sendto(
  int sockfd,
  const void *buf,
  size_t len,
  int flags,
  const struct sockaddr *dest_addr,
  socklen_t addrlen
) {
  if (dest_addr != NULL || addrlen != 0) {
    errno = EOPNOTSUPP;
    return -1;
  }
  return send(sockfd, buf, len, flags);
}

ssize_t recvfrom(
  int sockfd,
  void *buf,
  size_t len,
  int flags,
  struct sockaddr *src_addr,
  socklen_t *addrlen
) {
  if (src_addr && addrlen) {
    *addrlen = 0;
  }
  return recv(sockfd, buf, len, flags);
}

int setsockopt(int sockfd, int level, int optname, const void *optval, socklen_t optlen) {
  if (!optval || optlen < (socklen_t)sizeof(int)) {
    errno = EINVAL;
    return -1;
  }

  if (level == SOL_SOCKET
      && (optname == SO_REUSEADDR || optname == YURT_SO_REUSEADDR
          || optname == SO_KEEPALIVE || optname == YURT_SO_KEEPALIVE)) {
    return 0;
  }

  if (level == SOL_IP && optname == IP_BIND_ADDRESS_NO_PORT) {
    return 0;
  }

  if ((level == IPPROTO_TCP || level == YURT_IPPROTO_TCP)
      && (optname == TCP_NODELAY || optname == YURT_TCP_NODELAY)) {
    int enabled = (*(const int *)optval) != 0;
    int rc = yurt_host_socket_option(sockfd, YURT_SOCKET_OPT_TCP_NODELAY, 1, enabled);
    if (rc < 0) {
      errno = yurt_errno_from_host(rc, EOPNOTSUPP);
      return -1;
    }
    return 0;
  }

  errno = EOPNOTSUPP;
  return -1;
}

static int yurt_getsockopt_impl(int sockfd, int level, int optname, void *optval, socklen_t *optlen) {
  int value = 0;

  if (!optval || !optlen || *optlen < (socklen_t)sizeof(int)) {
    errno = EINVAL;
    return -1;
  }

  (void)level;

  switch (optname) {
    case SO_TYPE:
      value = SOCK_STREAM;
      break;
    case SO_ERROR:
#if YURT_SO_ERROR != SO_ERROR
    case YURT_SO_ERROR:
#endif
      value = 0;
      break;
    case TCP_NODELAY:
#if YURT_TCP_NODELAY != TCP_NODELAY
    case YURT_TCP_NODELAY:
#endif
    {
      int rc = yurt_host_socket_option(sockfd, YURT_SOCKET_OPT_TCP_NODELAY, 0, 0);
      if (rc < 0) {
        errno = yurt_errno_from_host(rc, EOPNOTSUPP);
        return -1;
      }
      value = rc;
      break;
    }
    default:
      errno = EOPNOTSUPP;
      return -1;
  }

  memcpy(optval, &value, sizeof(value));
  *optlen = (socklen_t)sizeof(value);
  errno = 0;
  return 0;
}

int getsockopt(int sockfd, int level, int optname, void *optval, socklen_t *optlen) {
  return yurt_getsockopt_impl(sockfd, level, optname, optval, optlen);
}

int __wrap_getsockopt(int sockfd, int level, int optname, void *optval, socklen_t *optlen) {
  return yurt_getsockopt_impl(sockfd, level, optname, optval, optlen);
}

int shutdown(int sockfd, int how) {
  YURT_MARKER_CALL(shutdown);

  (void)how;
  int rc = yurt_host_socket_close(sockfd);
  if (rc < 0) {
    errno = yurt_errno_from_host(rc, EIO);
    return -1;
  }
  return 0;
}

/* socketpair — wasi-libc lacks it (gated behind
 * __wasilibc_unmodified_upstream). Emulate via TCP loopback: bind a
 * listener on 127.0.0.1:0, accept-side and connect-side become the
 * pair. AF_UNIX is folded onto AF_INET because yurt has no Unix
 * domain sockets — callers (libzmq's signaler in particular) treat
 * the pair as opaque, so the underlying transport is a transparent
 * implementation detail. SOCK_DGRAM is rejected (EPROTOTYPE) — only
 * SOCK_STREAM (with optional SOCK_CLOEXEC/SOCK_NONBLOCK bits) maps
 * onto our TCP-loopback emulation. Add a UDP-loopback path here
 * when a guest needs datagram pairs.
 *
 * Cleanup uses yurt_socketpair_release() — yurt's `shutdown()`
 * already routes through host_socket_close internally (see the
 * shutdown impl above), but a sibling helper here keeps each call
 * site unambiguous about the intent ("release this fd") and lets
 * us swap to a real close() if/when the host fd table accepts
 * wasi-libc's close path. Every early-exit frees any sockets the
 * function has already allocated. */
static void yurt_socketpair_release(int fd) {
  if (fd < 0) return;
  /* SHUT_RDWR (= 2) — on yurt this triggers host_socket_close. */
  shutdown(fd, 2);
}

/* Honor the SOCK_NONBLOCK / SOCK_CLOEXEC bits Linux lets callers fold
 * into socket() / socketpair() type. wasi-libc's socket() ignores
 * those bits, so we route them through fcntl() after the fact. */
static int yurt_socketpair_apply_type_flags(int fd, int type) {
  if ((type & SOCK_NONBLOCK) != 0) {
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    if (fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0) return -1;
  }
  if ((type & SOCK_CLOEXEC) != 0) {
    int fd_fl = fcntl(fd, F_GETFD, 0);
    if (fd_fl < 0) return -1;
    if (fcntl(fd, F_SETFD, fd_fl | FD_CLOEXEC) < 0) return -1;
  }
  return 0;
}

int socketpair(int domain, int type, int protocol, int sv[2]) {
  YURT_MARKER_CALL(socketpair);

  if (!sv) { errno = EFAULT; return -1; }
  /* Accept the AF_UNIX form libzmq calls with; remap to AF_INET. */
  if (domain != AF_UNIX && domain != AF_INET) { errno = EAFNOSUPPORT; return -1; }
  if ((type & ~SOCK_CLOEXEC & ~SOCK_NONBLOCK) != SOCK_STREAM) { errno = EPROTOTYPE; return -1; }
  (void)protocol;

  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return -1;

  struct sockaddr_in sa;
  memset(&sa, 0, sizeof(sa));
  sa.sin_family = AF_INET;
  sa.sin_port = 0; /* ephemeral */
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  if (bind(listener, (const struct sockaddr *)&sa, sizeof(sa)) < 0) {
    int saved = errno; yurt_socketpair_release(listener); errno = saved; return -1;
  }
  if (listen(listener, 1) < 0) {
    int saved = errno; yurt_socketpair_release(listener); errno = saved; return -1;
  }
  /* Read back the assigned ephemeral port so connect() can target it. */
  socklen_t sa_len = sizeof(sa);
  if (getsockname(listener, (struct sockaddr *)&sa, &sa_len) < 0) {
    int saved = errno; yurt_socketpair_release(listener); errno = saved; return -1;
  }

  int connector = socket(AF_INET, SOCK_STREAM, 0);
  if (connector < 0) {
    int saved = errno; yurt_socketpair_release(listener); errno = saved; return -1;
  }
  if (connect(connector, (const struct sockaddr *)&sa, sizeof(sa)) < 0) {
    int saved = errno;
    yurt_socketpair_release(connector); yurt_socketpair_release(listener);
    errno = saved; return -1;
  }

  int acceptor = accept(listener, NULL, NULL);
  if (acceptor < 0) {
    int saved = errno;
    yurt_socketpair_release(connector); yurt_socketpair_release(listener);
    errno = saved; return -1;
  }
  /* Listener has done its job — release it; the pair is the
   * acceptor (read end) and the connector (write end). */
  yurt_socketpair_release(listener);

  /* Propagate SOCK_NONBLOCK / SOCK_CLOEXEC bits onto both ends.
   * Linux socketpair() applies these atomically; we apply
   * post-creation, which is the best wasi-libc allows today. */
  if (yurt_socketpair_apply_type_flags(acceptor, type) < 0 ||
      yurt_socketpair_apply_type_flags(connector, type) < 0) {
    int saved = errno;
    yurt_socketpair_release(acceptor); yurt_socketpair_release(connector);
    errno = saved; return -1;
  }

  sv[0] = acceptor;
  sv[1] = connector;
  return 0;
}
