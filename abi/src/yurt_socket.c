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
#include <sys/un.h>
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
YURT_DECLARE_MARKER(sendmsg);
YURT_DECLARE_MARKER(recvmsg);
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
YURT_DEFINE_MARKER(sendmsg,  0x736d7367u) /* "smsg" */
YURT_DEFINE_MARKER(recvmsg,  0x726d7367u) /* "rmsg" */
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

/* Forward declaration for SO_PEERCRED helper (Slice 6) */
static int yurt_getsockopt_peercred(int sockfd, void *optval, socklen_t *optlen);

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

  if (domain == AF_UNIX) {
    /* AF_UNIX: allow SOCK_STREAM (WASI=6) and SOCK_DGRAM (WASI=5). */
    int base_type = type & ~SOCK_CLOEXEC & ~SOCK_NONBLOCK;
    if (base_type != SOCK_STREAM && base_type != SOCK_DGRAM) {
      errno = EPROTOTYPE;
      return -1;
    }
    /* Allocate via the host socket open call. */
    int fd = yurt_host_socket_open(AF_UNIX, type, 0);
    if (fd < 0) { errno = EMFILE; return -1; }
    return fd;
  }
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

  if (!addr || addrlen < 2) {
    errno = EINVAL;
    return -1;
  }

  /* AF_UNIX: typed binary call — no JSON */
  if (addr->sa_family == AF_UNIX) {
    const struct sockaddr_un *un = (const struct sockaddr_un *)addr;
    if (un->sun_path[0] == '\0') {
      /* abstract address: bytes after the leading NUL */
      size_t namelen = (size_t)addrlen > offsetof(struct sockaddr_un, sun_path) + 1
        ? (size_t)addrlen - offsetof(struct sockaddr_un, sun_path) - 1
        : 0;
      if (yurt_host_socket_connect_unix(sockfd,
            (int)(intptr_t)(un->sun_path + 1), (int)namelen, 1) < 0) {
        errno = ECONNREFUSED;
        return -1;
      }
    } else {
      size_t pathlen = strnlen(un->sun_path, sizeof(un->sun_path) - 1);
      if (yurt_host_socket_connect_unix(sockfd,
            (int)(intptr_t)un->sun_path, (int)pathlen, 0) < 0) {
        errno = ECONNREFUSED;
        return -1;
      }
    }
    return 0;
  }

  if (addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) {
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

static int yurt_fill_sockaddr_un(
  struct sockaddr *addr,
  socklen_t *addrlen,
  const char *path
) {
  struct sockaddr_un un;
  if (!addr || !addrlen) { errno = EINVAL; return -1; }
  memset(&un, 0, sizeof(un));
  un.sun_family = AF_UNIX;
  if (path[0] == '\0') {
    /* abstract address: copy name (after leading NUL) into sun_path[1..] */
    un.sun_path[0] = '\0';
    strncpy(un.sun_path + 1, path + 1, sizeof(un.sun_path) - 2);
  } else {
    strncpy(un.sun_path, path, sizeof(un.sun_path) - 1);
  }
  size_t copy = (*addrlen < sizeof(un)) ? (size_t)*addrlen : sizeof(un);
  memcpy(addr, &un, copy);
  *addrlen = (socklen_t)sizeof(un);
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
  int is_peer = (strcmp(kind, "peer") == 0) ? 1 : 0;
  yurt_socket_addr_result_v1 result;
  int n;
  unsigned which = strcmp(host_field, "local_host") == 0
    ? YURT_SOCKET_ADDR_LOCAL
    : YURT_SOCKET_ADDR_PEER;

  /* Try typed AF_UNIX path first: avoids JSON for the common AF_UNIX case. */
  {
    char path_buf[108];
    int is_abstract = 0;
    int plen = yurt_host_socket_addr_unix(sockfd, is_peer,
                  (int)(intptr_t)path_buf, (int)sizeof(path_buf),
                  (int)(intptr_t)&is_abstract);
    if (plen >= 0) {
      char unix_path[109];
      if (is_abstract) {
        int n = plen < 107 ? plen : 107;
        unix_path[0] = '\0';
        memcpy(unix_path + 1, path_buf, (size_t)n);
        unix_path[1 + n] = '\0';
      } else {
        int n = plen < 108 ? plen : 107;
        memcpy(unix_path, path_buf, (size_t)n);
        unix_path[n] = '\0';
      }
      return yurt_fill_sockaddr_un(addr, addrlen, unix_path);
    }
    if (plen == -2) {
      errno = ENOTCONN;
      return -1;
    }
    /* plen == -1: not AF_UNIX; fall through to AF_INET native address. */
  }

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

  if (!addr || addrlen < 2) { errno = EINVAL; return -1; }

  /* AF_UNIX: typed binary call — no JSON */
  if (addr->sa_family == AF_UNIX) {
    const struct sockaddr_un *un = (const struct sockaddr_un *)addr;
    if (un->sun_path[0] == '\0') {
      /* abstract address: bytes after the leading NUL */
      size_t namelen = (size_t)addrlen > offsetof(struct sockaddr_un, sun_path) + 1
        ? (size_t)addrlen - offsetof(struct sockaddr_un, sun_path) - 1
        : 0;
      if (yurt_host_socket_bind_unix(sockfd,
            (int)(intptr_t)(un->sun_path + 1), (int)namelen, 1) < 0) {
        errno = EADDRINUSE;
        return -1;
      }
    } else {
      size_t pathlen = strnlen(un->sun_path, sizeof(un->sun_path) - 1);
      if (yurt_host_socket_bind_unix(sockfd,
            (int)(intptr_t)un->sun_path, (int)pathlen, 0) < 0) {
        errno = EADDRINUSE;
        return -1;
      }
    }
    return 0;
  }

  /* AF_INET path (existing) */
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

  /* SOCK_DGRAM sockets do not support listen(). */
  if (yurt_host_socket_is_dgram(sockfd) == 1) { errno = EOPNOTSUPP; return -1; }

  /* Try typed AF_UNIX path first. */
  int r = yurt_host_socket_listen_unix(sockfd, backlog);
  if (r == 0) return 0;
  if (r == -1) { errno = EADDRINUSE; return -1; }
  /* r == -2: not AF_UNIX, fall through to AF_INET native listen. */

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

  /* Try typed AF_UNIX path first. */
  int unix_fd = yurt_host_socket_accept_unix(sockfd);
  if (unix_fd >= 0) {
    if (addr && addrlen) {
      char path_buf[108];
      int is_abstract = 0;
      int plen = yurt_host_socket_addr_unix(unix_fd, 1,
                    (int)(intptr_t)path_buf, (int)sizeof(path_buf),
                    (int)(intptr_t)&is_abstract);
      if (plen >= 0) {
        char unix_path[109];
        if (is_abstract) {
          int k = plen < 107 ? plen : 107;
          unix_path[0] = '\0';
          memcpy(unix_path + 1, path_buf, (size_t)k);
          unix_path[1 + k] = '\0';
        } else {
          int k = plen < 108 ? plen : 107;
          memcpy(unix_path, path_buf, (size_t)k);
          unix_path[k] = '\0';
        }
        if (yurt_fill_sockaddr_un(addr, addrlen, unix_path) != 0) return -1;
      } else {
        *addrlen = sizeof(struct sockaddr_un);
      }
    }
    return unix_fd;
  }
  if (unix_fd == -1) { errno = EOPNOTSUPP; return -1; }
  /* unix_fd == -2: not AF_UNIX, fall through to AF_INET accept. */

  for (;;) {
    n = yurt_host_socket_accept(sockfd, (int)(intptr_t)&accepted, (int)sizeof(accepted));
    if (n == (int)sizeof(accepted)) break;
    if (n == -YURT_HOST_EAGAIN) {
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

  /* Try typed AF_UNIX STREAM path first (avoids base64). */
  {
    int r = yurt_host_socket_send_unix(sockfd, (int)(intptr_t)buf, (int)len);
    if (r >= 0) return (ssize_t)r;
    if (r == -1) { errno = EIO; return -1; }
    /* r == -2: not AF_UNIX STREAM, fall through to native AF_INET path. */
  }

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

  /* Try typed AF_UNIX STREAM path first (avoids base64). */
  {
    int is_peek = (flags == MSG_PEEK || flags == YURT_MSG_PEEK) ? 1 : 0;
    int r = yurt_host_socket_recv_unix(sockfd, (int)(intptr_t)buf, (int)len, is_peek);
    if (r >= 0) return (ssize_t)r;
    if (r == -2) { errno = EAGAIN; return -1; }
    if (r == -1) { errno = EIO; return -1; }
    /* r == -3: not AF_UNIX STREAM, fall through to native AF_INET path. */
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
  if (dest_addr != NULL && dest_addr->sa_family == AF_UNIX) {
    /* AF_UNIX SOCK_DGRAM sendto: typed binary call — no JSON, no base64 */
    const struct sockaddr_un *un = (const struct sockaddr_un *)dest_addr;
    int sent;
    (void)flags;
    if (un->sun_path[0] == '\0') {
      size_t namelen = (size_t)addrlen > offsetof(struct sockaddr_un, sun_path) + 1
        ? (size_t)addrlen - offsetof(struct sockaddr_un, sun_path) - 1 : 0;
      sent = yurt_host_socket_sendto_unix(sockfd,
               (int)(intptr_t)buf, (int)len,
               (int)(intptr_t)(un->sun_path + 1), (int)namelen, 1);
    } else {
      size_t pathlen = strnlen(un->sun_path, sizeof(un->sun_path) - 1);
      sent = yurt_host_socket_sendto_unix(sockfd,
               (int)(intptr_t)buf, (int)len,
               (int)(intptr_t)un->sun_path, (int)pathlen, 0);
    }
    if (sent < 0) { errno = ENOENT; return -1; }
    return (ssize_t)sent;
  }
  if (dest_addr != NULL) {
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
  /* Try typed AF_UNIX SOCK_DGRAM recvfrom first. */
  {
    char from_path_buf[108];
    int from_path_len = 0;
    int from_is_abstract = 0;
    if (len > YURT_SOCKET_RECV_MAX_RAW) len = YURT_SOCKET_RECV_MAX_RAW;
    int rc = yurt_host_socket_recvfrom_unix(sockfd,
               (int)(intptr_t)buf, (int)len,
               (int)(intptr_t)from_path_buf, (int)sizeof(from_path_buf),
               (int)(intptr_t)&from_path_len, (int)(intptr_t)&from_is_abstract);
    if (rc >= 0) {
      if (src_addr && addrlen) {
        if (from_path_len > 0) {
          char unix_path[109];
          if (from_is_abstract) {
            int n = from_path_len < 107 ? from_path_len : 107;
            unix_path[0] = '\0';
            memcpy(unix_path + 1, from_path_buf, (size_t)n);
            unix_path[1 + n] = '\0';
          } else {
            int n = from_path_len < 108 ? from_path_len : 107;
            memcpy(unix_path, from_path_buf, (size_t)n);
            unix_path[n] = '\0';
          }
          yurt_fill_sockaddr_un(src_addr, addrlen, unix_path);
        } else {
          *addrlen = 0;
        }
      }
      return (ssize_t)rc;
    }
    if (rc == -2) { errno = EAGAIN; return -1; }
    /* rc == -1: not an AF_UNIX dgram socket — fall through to recv() */
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

  /* SO_PEERCRED requires a struct ucred, not just int */
  if (optname == SO_PEERCRED) {
    return yurt_getsockopt_peercred(sockfd, optval, optlen);
  }

  switch (optname) {
    case SO_TYPE:
      value = (yurt_host_socket_is_dgram(sockfd) == 1) ? SOCK_DGRAM : SOCK_STREAM;
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

/* socketpair — backed by the in-kernel UnixSocketRegistry via
 * host_socket_socketpair.  Returns a connected AF_UNIX SOCK_STREAM or
 * SOCK_DGRAM pair.  Cleanup uses yurt_socketpair_release() so every early-exit
 * path frees any sockets already allocated. */
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
  if (domain != AF_UNIX && domain != AF_INET) { errno = EAFNOSUPPORT; return -1; }
  int base_type = type & ~SOCK_CLOEXEC & ~SOCK_NONBLOCK;
  if (base_type != SOCK_STREAM && base_type != SOCK_DGRAM) { errno = EPROTOTYPE; return -1; }
  (void)protocol;

  int fds[2] = { -1, -1 };
  if (yurt_host_socket_socketpair(AF_UNIX, base_type,
                                   (int)(intptr_t)fds) < 0) {
    errno = ENOTSUP;
    return -1;
  }
  if (fds[0] < 0 || fds[1] < 0) { errno = ENOTSUP; return -1; }

  if (yurt_socketpair_apply_type_flags(fds[0], type) < 0 ||
      yurt_socketpair_apply_type_flags(fds[1], type) < 0) {
    int saved = errno;
    yurt_socketpair_release(fds[0]); yurt_socketpair_release(fds[1]);
    errno = saved; return -1;
  }
  sv[0] = fds[0];
  sv[1] = fds[1];
  return 0;
}

/* ── sendmsg: gather iov, collect SCM_RIGHTS, call host_socket_sendmsg ── */
ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags) {
  YURT_MARKER_CALL(sendmsg);
  if (!msg) { errno = EINVAL; return -1; }

  /* Gather iovecs into one contiguous buffer */
  size_t total = 0;
  for (int i = 0; i < (int)msg->msg_iovlen; i++) total += msg->msg_iov[i].iov_len;
  unsigned char *data = malloc(total ? total : 1);
  if (!data) { errno = ENOMEM; return -1; }
  { size_t off = 0;
    for (int i = 0; i < (int)msg->msg_iovlen; i++) {
      memcpy(data + off, msg->msg_iov[i].iov_base, msg->msg_iov[i].iov_len);
      off += msg->msg_iov[i].iov_len;
    }
  }

  /* Collect SCM_RIGHTS fd numbers from ancillary data */
  int fds_buf[64];
  int fds_count = 0;
  if (msg->msg_control && msg->msg_controllen > 0) {
    struct cmsghdr *cmsg = CMSG_FIRSTHDR(msg);
    while (cmsg && fds_count < 64) {
      if (cmsg->cmsg_level == SOL_SOCKET && cmsg->cmsg_type == SCM_RIGHTS) {
        size_t fdcount = (cmsg->cmsg_len - CMSG_LEN(0)) / sizeof(int);
        int *cmsg_fds = (int *)CMSG_DATA(cmsg);
        for (size_t i = 0; i < fdcount && fds_count < 64; i++)
          fds_buf[fds_count++] = cmsg_fds[i];
      }
      cmsg = CMSG_NXTHDR(msg, cmsg);
    }
  }

  int rc = yurt_host_socket_sendmsg(sockfd,
    (int)(intptr_t)data, (int)total,
    fds_count > 0 ? (int)(intptr_t)fds_buf : 0, fds_count);
  free(data);
  (void)flags;
  if (rc < 0) { errno = EIO; return -1; }
  return (ssize_t)rc;
}

/* ── recvmsg: call host_socket_recvmsg, scatter data, write SCM_RIGHTS ── */
ssize_t recvmsg(int sockfd, struct msghdr *msg, int flags) {
  YURT_MARKER_CALL(recvmsg);
  if (!msg) { errno = EINVAL; return -1; }

  size_t total_iov = 0;
  for (int i = 0; i < (int)msg->msg_iovlen; i++) total_iov += msg->msg_iov[i].iov_len;
  if (total_iov > YURT_SOCKET_RECV_MAX_RAW) total_iov = YURT_SOCKET_RECV_MAX_RAW;

  unsigned char *buf = malloc(total_iov ? total_iov : 1);
  if (!buf) { errno = ENOMEM; return -1; }

  size_t orig_controllen = msg->msg_controllen;
  int max_fds = 0;
  if (msg->msg_control && orig_controllen >= CMSG_SPACE(0)) {
    max_fds = (int)((orig_controllen - CMSG_SPACE(0)) / sizeof(int));
    if (max_fds > 64) max_fds = 64;
  }

  int recv_fds[64];
  int n_fds = 0;
  int rc = yurt_host_socket_recvmsg(sockfd,
    (int)(intptr_t)buf, (int)total_iov,
    max_fds > 0 ? (int)(intptr_t)recv_fds : 0, max_fds,
    (int)(intptr_t)&n_fds);

  if (rc < 0) {
    free(buf);
    errno = (rc == -2) ? EAGAIN : EIO;
    return -1;
  }
  ssize_t nbytes = (ssize_t)rc;

  /* Scatter received bytes into iov */
  { size_t off = 0;
    for (int i = 0; i < (int)msg->msg_iovlen && off < (size_t)nbytes; i++) {
      size_t copy = msg->msg_iov[i].iov_len;
      if (off + copy > (size_t)nbytes) copy = (size_t)nbytes - off;
      memcpy(msg->msg_iov[i].iov_base, buf + off, copy);
      off += copy;
    }
  }
  free(buf);

  /* Write SCM_RIGHTS cmsg if fds were received */
  msg->msg_controllen = 0;
  msg->msg_flags = 0;
  if (n_fds > 0 && msg->msg_control && orig_controllen > 0) {
    struct cmsghdr *cmsg = (struct cmsghdr *)msg->msg_control;
    size_t needed = CMSG_SPACE(n_fds * sizeof(int));
    if (needed <= orig_controllen) {
      cmsg->cmsg_len = (socklen_t)CMSG_LEN(n_fds * sizeof(int));
      cmsg->cmsg_level = SOL_SOCKET;
      cmsg->cmsg_type = SCM_RIGHTS;
      memcpy(CMSG_DATA(cmsg), recv_fds, n_fds * sizeof(int));
      msg->msg_controllen = needed;
    } else {
      /* Control buffer too small: fit as many fds as possible, flag truncation */
      int fit = orig_controllen >= CMSG_SPACE(0)
        ? (int)((orig_controllen - CMSG_SPACE(0)) / sizeof(int)) : 0;
      if (fit > 0) {
        cmsg->cmsg_len = (socklen_t)CMSG_LEN((size_t)fit * sizeof(int));
        cmsg->cmsg_level = SOL_SOCKET;
        cmsg->cmsg_type = SCM_RIGHTS;
        memcpy(CMSG_DATA(cmsg), recv_fds, (size_t)fit * sizeof(int));
        msg->msg_controllen = CMSG_SPACE((size_t)fit * sizeof(int));
      }
      msg->msg_flags |= MSG_CTRUNC;
    }
  } else if (n_fds > 0) {
    /* Caller provided no control buffer but ancillary data arrived */
    msg->msg_flags |= MSG_CTRUNC;
  }

  (void)flags;
  return nbytes;
}

/* ── SO_PEERCRED getsockopt ─────────────────────────────────────────────── */
static int yurt_getsockopt_peercred(int sockfd, void *optval, socklen_t *optlen) {
  struct ucred cred;
  int pid = 0, uid = 0, gid = 0;

  if (!optval || !optlen || *optlen < (socklen_t)sizeof(struct ucred)) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_host_socket_peercred(sockfd, &pid, &uid, &gid) != 0) {
    errno = EOPNOTSUPP;
    return -1;
  }
  cred.pid = (pid_t)pid;
  cred.uid = (uid_t)uid;
  cred.gid = (gid_t)gid;
  memcpy(optval, &cred, sizeof(cred));
  *optlen = (socklen_t)sizeof(cred);
  return 0;
}
