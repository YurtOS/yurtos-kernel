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
#define YURT_HOST_ERR_AGAIN 11

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

#define YURT_SOCKET_RESP_CAP 4096
#define YURT_SOCKET_RECV_MAX_RAW 3000
#define YURT_SOCKET_MAX_TRACKED 128
#define YURT_SOCKET_FIRST_GUEST_FD 10000

/* wasi-libc already ships strong definitions for POSIX socket names.
 * yurt-cc/cargo-yurt pass --wrap for the duplicate-owned symbols we implement
 * here so Rust and C guests both route through libyurt without using
 * yurt-specific symbol names. */

typedef struct {
  int guest_fd;
  int host_fd;
  int status_flags;
  int descriptor_flags;
  int no_delay;
  char bound_host[64];
  int bound_port;
  char peer_host[64];
  int peer_port;
} yurt_socket_entry;

static yurt_socket_entry yurt_sockets[YURT_SOCKET_MAX_TRACKED];
static int yurt_next_guest_fd = YURT_SOCKET_FIRST_GUEST_FD;

static yurt_socket_entry *yurt_socket_find(int fd) {
  if (fd < YURT_SOCKET_FIRST_GUEST_FD) return NULL;
  for (size_t i = 0; i < YURT_SOCKET_MAX_TRACKED; i++) {
    if (yurt_sockets[i].guest_fd == fd) return &yurt_sockets[i];
  }
  return NULL;
}

static yurt_socket_entry *yurt_socket_alloc(void) {
  for (size_t i = 0; i < YURT_SOCKET_MAX_TRACKED; i++) {
    if (yurt_sockets[i].guest_fd == 0) {
      memset(&yurt_sockets[i], 0, sizeof(yurt_sockets[i]));
      yurt_sockets[i].guest_fd = yurt_next_guest_fd++;
      yurt_sockets[i].host_fd = -1;
      strcpy(yurt_sockets[i].bound_host, "127.0.0.1");
      return &yurt_sockets[i];
    }
  }
  errno = EMFILE;
  return NULL;
}

static yurt_socket_entry *yurt_socket_alloc_at_least(int min_fd) {
  yurt_socket_entry *entry = yurt_socket_alloc();
  if (!entry) return NULL;
  if (entry->guest_fd < min_fd) {
    entry->guest_fd = min_fd;
    if (yurt_next_guest_fd <= min_fd) yurt_next_guest_fd = min_fd + 1;
  }
  while (yurt_socket_find(entry->guest_fd) != entry) {
    entry->guest_fd++;
    if (yurt_next_guest_fd <= entry->guest_fd) yurt_next_guest_fd = entry->guest_fd + 1;
  }
  return entry;
}

static yurt_socket_entry *yurt_socket_track_host_fd(int host_fd) {
  yurt_socket_entry *entry = yurt_socket_alloc();
  if (!entry) return NULL;
  entry->host_fd = host_fd;
  return entry;
}

static int yurt_socket_host_fd(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (!entry) return fd;
  return entry->host_fd >= 0 ? entry->host_fd : fd;
}

static int yurt_socket_host_ref_count(int host_fd) {
  int count = 0;
  for (size_t i = 0; i < YURT_SOCKET_MAX_TRACKED; i++) {
    if (yurt_sockets[i].guest_fd != 0 && yurt_sockets[i].host_fd == host_fd) count++;
  }
  return count;
}

static void yurt_socket_forget(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) memset(entry, 0, sizeof(*entry));
}

int yurt_socket_is_tracked_fd(int fd) {
  return yurt_socket_find(fd) != NULL;
}

int yurt_socket_dup_fd_min(int fd, int min_fd) {
  yurt_socket_entry *src = yurt_socket_find(fd);
  yurt_socket_entry *dst;
  if (!src || min_fd < 0) {
    errno = EBADF;
    return -1;
  }
  dst = yurt_socket_alloc_at_least(min_fd);
  if (!dst) return -1;
  dst->host_fd = src->host_fd;
  dst->status_flags = src->status_flags;
  dst->descriptor_flags = src->descriptor_flags;
  dst->no_delay = src->no_delay;
  memcpy(dst->bound_host, src->bound_host, sizeof(dst->bound_host));
  dst->bound_port = src->bound_port;
  memcpy(dst->peer_host, src->peer_host, sizeof(dst->peer_host));
  dst->peer_port = src->peer_port;
  return dst->guest_fd;
}

int yurt_socket_dup_fd(int fd) {
  return yurt_socket_dup_fd_min(fd, 0);
}

int yurt_socket_get_status_flags(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  return entry ? entry->status_flags : 0;
}

int yurt_socket_set_status_flags(int fd, int flags) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (!entry) {
    errno = EBADF;
    return -1;
  }
  entry->status_flags = flags;
  return 0;
}

int yurt_socket_get_descriptor_flags(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  return entry ? entry->descriptor_flags : 0;
}

int yurt_socket_set_descriptor_flags(int fd, int flags) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (!entry) {
    errno = EBADF;
    return -1;
  }
  entry->descriptor_flags = flags & FD_CLOEXEC;
  return 0;
}

static int yurt_socket_close_tracked(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  int host_fd;
  if (!entry) return 0;
  host_fd = entry->host_fd;
  if (host_fd >= 0 && yurt_socket_host_ref_count(host_fd) <= 1) {
    if (yurt_host_socket_close(host_fd) != 0) {
      errno = EIO;
      return -1;
    }
  }
  yurt_socket_forget(fd);
  return 0;
}

extern int __real_close(int fd);

static int yurt_socket_addr_string(const char *host, int port, char *dst, size_t cap) {
  int n = snprintf(dst, cap, "%s:%d", host, port);
  if (n < 0 || (size_t)n >= cap) {
    errno = EOVERFLOW;
    return -1;
  }
  return n;
}

static int yurt_socket_impl(int domain, int type, int protocol) {
  YURT_MARKER_CALL(socket);
  yurt_socket_entry *entry;

  if (domain != AF_INET || (type & SOCK_STREAM) != SOCK_STREAM) {
    errno = EAFNOSUPPORT;
    return -1;
  }
  (void)protocol;

  entry = yurt_socket_alloc();
  return entry ? entry->guest_fd : -1;
}

int socket(int domain, int type, int protocol) {
  return yurt_socket_impl(domain, type, protocol);
}

int __wrap_socket(int domain, int type, int protocol) {
  return yurt_socket_impl(domain, type, protocol);
}

static int yurt_connect_impl(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  YURT_MARKER_CALL(connect);
  yurt_socket_entry *entry = yurt_socket_find(sockfd);
  char host[256];
  char target[320];
  int n;
  int host_fd;

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

  n = yurt_socket_addr_string(host, (int)ntohs(in->sin_port), target, sizeof(target));
  if (n < 0) return -1;

  host_fd = yurt_host_socket_connect((int)(intptr_t)target, n, 0);
  if (host_fd < 0) {
    errno = ECONNREFUSED;
    return -1;
  }
  if (!entry) entry = yurt_socket_track_host_fd(sockfd);
  if (!entry) {
    yurt_host_socket_close(host_fd);
    return -1;
  }
  entry->host_fd = host_fd;
  if (entry->no_delay && yurt_host_socket_set_no_delay(host_fd, 1) < 0) {
    yurt_host_socket_close(host_fd);
    entry->host_fd = -1;
    errno = EIO;
    return -1;
  }
  strncpy(entry->peer_host, host, sizeof(entry->peer_host) - 1);
  entry->peer_host[sizeof(entry->peer_host) - 1] = '\0';
  entry->peer_port = (int)ntohs(in->sin_port);
  return 0;
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return yurt_connect_impl(sockfd, addr, addrlen);
}

int __wrap_connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return yurt_connect_impl(sockfd, addr, addrlen);
}

static int yurt_fill_sockaddr_from_host(
  struct sockaddr *addr,
  socklen_t *addrlen,
  const char *host,
  int port
) {
  struct sockaddr_in in;
  uint32_t synthetic;

  if (!addr || !addrlen || *addrlen < (socklen_t)sizeof(in)) {
    errno = EINVAL;
    return -1;
  }

  memset(&in, 0, sizeof(in));
  in.sin_family = AF_INET;
  in.sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, host, &in.sin_addr) != 1) {
    synthetic = yurt_netdb_addr_for_host(host);
    if (synthetic == 0) {
      errno = EINVAL;
      return -1;
    }
    in.sin_addr.s_addr = synthetic;
  }

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
  yurt_socket_entry *entry = yurt_socket_find(sockfd);
  unsigned char resp[YURT_SOCKET_RESP_CAP];
  char host[256];
  int port = 0;
  int n;

  (void)host_field;
  (void)port_field;
  if (strcmp(kind, "peer") == 0) {
    if (!entry || entry->peer_host[0] == '\0') {
      errno = ENOTCONN;
      return -1;
    }
    strncpy(host, entry->peer_host, sizeof(host) - 1);
    host[sizeof(host) - 1] = '\0';
    port = entry->peer_port;
  } else {
    n = yurt_host_socket_addr(
      yurt_socket_host_fd(sockfd),
      (int)(intptr_t)resp,
      (int)sizeof(resp)
    );
    if (n < 2) {
      errno = ENOTCONN;
      return -1;
    }
    port = (int)((uint16_t)resp[0] | ((uint16_t)resp[1] << 8));
    if ((size_t)(n - 2) >= sizeof(host)) {
      errno = EOVERFLOW;
      return -1;
    }
    memcpy(host, resp + 2, (size_t)(n - 2));
    host[n - 2] = '\0';
  }

  return yurt_fill_sockaddr_from_host(addr, addrlen, host, port);
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

int __wrap_getpeername(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
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

int __wrap_getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
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

static int yurt_bind_impl(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  YURT_MARKER_CALL(bind);
  yurt_socket_entry *entry = yurt_socket_find(sockfd);
  char host[INET_ADDRSTRLEN];
  int port;

  if (yurt_sockaddr_to_host_port(addr, addrlen, host, sizeof(host), &port) != 0) {
    return -1;
  }
  if (!entry) {
    errno = EBADF;
    return -1;
  }
  strncpy(entry->bound_host, host, sizeof(entry->bound_host) - 1);
  entry->bound_host[sizeof(entry->bound_host) - 1] = '\0';
  entry->bound_port = port;
  return 0;
}

int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return yurt_bind_impl(sockfd, addr, addrlen);
}

int __wrap_bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  return yurt_bind_impl(sockfd, addr, addrlen);
}

static int yurt_listen_impl(int sockfd, int backlog) {
  YURT_MARKER_CALL(listen);
  yurt_socket_entry *entry = yurt_socket_find(sockfd);
  char target[128];
  int n;
  int host_fd;

  if (!entry) {
    errno = EBADF;
    return -1;
  }
  n = yurt_socket_addr_string(
    entry->bound_host[0] ? entry->bound_host : "127.0.0.1",
    entry->bound_port,
    target,
    sizeof(target)
  );
  if (n < 0) return -1;
  host_fd = yurt_host_socket_listen(backlog, (int)(intptr_t)target, n);
  if (host_fd < 0) {
    errno = EOPNOTSUPP;
    return -1;
  }
  entry->host_fd = host_fd;
  return 0;
}

int listen(int sockfd, int backlog) {
  return yurt_listen_impl(sockfd, backlog);
}

int __wrap_listen(int sockfd, int backlog) {
  return yurt_listen_impl(sockfd, backlog);
}

static int yurt_accept_impl(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(accept);
  yurt_socket_entry *entry = yurt_socket_find(sockfd);
  yurt_socket_entry *accepted_entry;
  int accepted_fd = -1;

  if (!entry || entry->host_fd < 0) {
    errno = EBADF;
    return -1;
  }
  accepted_fd = yurt_host_socket_accept(entry->host_fd, 0);
  if (accepted_fd < 0) {
    errno = (accepted_fd == -EAGAIN || accepted_fd == -YURT_HOST_ERR_AGAIN)
      ? EAGAIN
      : EOPNOTSUPP;
    return -1;
  }
  accepted_entry = yurt_socket_track_host_fd(accepted_fd);
  if (!accepted_entry) {
    yurt_host_socket_close(accepted_fd);
    return -1;
  }
  strncpy(accepted_entry->peer_host, "127.0.0.1", sizeof(accepted_entry->peer_host) - 1);
  accepted_entry->peer_host[sizeof(accepted_entry->peer_host) - 1] = '\0';
  accepted_entry->peer_port = 49152;
  if (addr && addrlen && *addrlen >= sizeof(struct sockaddr_in)) {
    if (yurt_fill_sockaddr_from_host(
      addr,
      addrlen,
      accepted_entry->peer_host,
      accepted_entry->peer_port
    ) != 0) {
      return -1;
    }
  } else if (addrlen) {
    *addrlen = sizeof(struct sockaddr_in);
  }
  return accepted_entry->guest_fd;
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

  n = yurt_host_socket_send(
    yurt_socket_host_fd(sockfd),
    (int)(intptr_t)buf,
    (int)len,
    flags
  );
  if (n < 0) {
    errno = EIO;
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
  if ((yurt_socket_get_status_flags(sockfd) & O_NONBLOCK) != 0) {
    flags |= 0x04;
  }

  n = yurt_host_socket_recv(
    yurt_socket_host_fd(sockfd),
    (int)(intptr_t)buf,
    (int)len,
    flags
  );
  if (n < 0) {
    errno = (n == -EAGAIN || n == -YURT_HOST_ERR_AGAIN) ? EAGAIN : EIO;
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

static int yurt_setsockopt_impl(
  int sockfd,
  int level,
  int optname,
  const void *optval,
  socklen_t optlen
) {
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
    yurt_socket_entry *entry = yurt_socket_find(sockfd);
    int enabled = (*(const int *)optval) != 0;

    if (!entry) { errno = EBADF; return -1; }
    entry->no_delay = enabled;
    if (entry->host_fd >= 0 && yurt_host_socket_set_no_delay(entry->host_fd, enabled) < 0) {
      errno = EIO;
      return -1;
    }
    return 0;
  }

  errno = EOPNOTSUPP;
  return -1;
}

int setsockopt(int sockfd, int level, int optname, const void *optval, socklen_t optlen) {
  return yurt_setsockopt_impl(sockfd, level, optname, optval, optlen);
}

int __wrap_setsockopt(
  int sockfd,
  int level,
  int optname,
  const void *optval,
  socklen_t optlen
) {
  return yurt_setsockopt_impl(sockfd, level, optname, optval, optlen);
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
      yurt_socket_entry *entry = yurt_socket_find(sockfd);
      if (!entry) {
        errno = EBADF;
        return -1;
      }
      value = entry->no_delay;
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

static int yurt_shutdown_impl(int sockfd, int how) {
  YURT_MARKER_CALL(shutdown);

  (void)how;
  return yurt_socket_close_tracked(sockfd);
}

int shutdown(int sockfd, int how) {
  return yurt_shutdown_impl(sockfd, how);
}

int __wrap_shutdown(int sockfd, int how) {
  return yurt_shutdown_impl(sockfd, how);
}

int __wrap_close(int fd) {
  if (yurt_socket_is_tracked_fd(fd)) return yurt_socket_close_tracked(fd);
  return __real_close(fd);
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
