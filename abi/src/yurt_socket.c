#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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
#define YURT_SOCKET_OPT_TCP_NODELAY 1u
#define YURT_SOCKET_MAX_TRACKED 128
#define YURT_SOCKET_FIRST_GUEST_FD 10000
#define YURT_SOCKET_DIRECT_FLAGS_MAX 65536
#define YURT_SOCKET_ADDR_MAX 256

#define YURT_SOCKET_BACKEND_NONE 0
#define YURT_SOCKET_BACKEND_HOST 1
#define YURT_SOCKET_BACKEND_KERNEL 2
#define YURT_SOCKET_BACKEND_PENDING 3

#define YURT_HOST_ERR_NOT_FOUND -1
#define YURT_HOST_ERR_IO -3
#define YURT_HOST_ERR_AGAIN -11
#define YURT_HOST_ERR_INVALID -22
#define YURT_HOST_ERR_UNSUPPORTED -38

#define YURT_HOST_EPERM 1
#define YURT_HOST_EIO 5
#define YURT_HOST_EBADF 9
#define YURT_HOST_EACCES 13
#define YURT_HOST_EINVAL 22
#define YURT_HOST_EAGAIN 11
#define YURT_HOST_ECONNREFUSED 111
#define YURT_HOST_EOPNOTSUPP 95
#define YURT_HOST_EPROTOTYPE 91
#define YURT_HOST_EAFNOSUPPORT 97
#define YURT_HOST_EADDRINUSE 98

/* wasi-libc already ships strong definitions for some POSIX socket names.
 * yurt-cc/cargo-yurt pass --wrap for the duplicate-owned symbols we implement
 * here (`accept`, `send`, `recv`, `getsockopt`) so Rust and C guests both route
 * through libyurt without using yurt-specific symbol names. */

/* Forward declaration for SO_PEERCRED helper (Slice 6) */
static int yurt_getsockopt_peercred(int sockfd, void *optval, socklen_t *optlen);

typedef struct yurt_socket_entry {
  int guest_fd;
  int host_fd;
  int backend;
  int domain;
  int sock_type;
  int status_flags;
  int descriptor_flags;
  char addr[YURT_SOCKET_ADDR_MAX];
  int addr_len;
} yurt_socket_entry;

static yurt_socket_entry yurt_sockets[YURT_SOCKET_MAX_TRACKED];
static int yurt_next_guest_fd = YURT_SOCKET_FIRST_GUEST_FD;
static int yurt_socket_direct_status_flags[YURT_SOCKET_DIRECT_FLAGS_MAX];
static int yurt_socket_direct_descriptor_flags[YURT_SOCKET_DIRECT_FLAGS_MAX];
static int yurt_socket_direct_type[YURT_SOCKET_DIRECT_FLAGS_MAX];

static yurt_socket_entry *yurt_socket_find(int fd) {
  if (fd < YURT_SOCKET_FIRST_GUEST_FD) return NULL;
  for (size_t i = 0; i < YURT_SOCKET_MAX_TRACKED; i++) {
    if (yurt_sockets[i].guest_fd == fd) return &yurt_sockets[i];
  }
  return NULL;
}

static yurt_socket_entry *yurt_socket_alloc_at_least(int min_fd) {
  if (min_fd < YURT_SOCKET_FIRST_GUEST_FD) min_fd = YURT_SOCKET_FIRST_GUEST_FD;
  for (size_t i = 0; i < YURT_SOCKET_MAX_TRACKED; i++) {
    if (yurt_sockets[i].guest_fd == 0) {
      memset(&yurt_sockets[i], 0, sizeof(yurt_sockets[i]));
      if (yurt_next_guest_fd < min_fd) yurt_next_guest_fd = min_fd;
      yurt_sockets[i].guest_fd = yurt_next_guest_fd++;
      while (yurt_socket_find(yurt_sockets[i].guest_fd) != &yurt_sockets[i]) {
        yurt_sockets[i].guest_fd++;
        if (yurt_next_guest_fd <= yurt_sockets[i].guest_fd) {
          yurt_next_guest_fd = yurt_sockets[i].guest_fd + 1;
        }
      }
      return &yurt_sockets[i];
    }
  }
  errno = EMFILE;
  return NULL;
}

static yurt_socket_entry *yurt_socket_alloc_pending(int domain, int sock_type, int type) {
  yurt_socket_entry *entry = yurt_socket_alloc_at_least(YURT_SOCKET_FIRST_GUEST_FD);
  if (!entry) return NULL;
  entry->host_fd = -1;
  entry->backend = YURT_SOCKET_BACKEND_PENDING;
  entry->domain = domain;
  entry->sock_type = sock_type;
  entry->status_flags = ((type & SOCK_NONBLOCK) != 0) ? O_NONBLOCK : 0;
  entry->descriptor_flags = ((type & SOCK_CLOEXEC) != 0) ? FD_CLOEXEC : 0;
  return entry;
}

static int yurt_socket_host_fd(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  return entry ? entry->host_fd : fd;
}

static int yurt_socket_kernel_fd(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry && entry->backend == YURT_SOCKET_BACKEND_KERNEL) return entry->host_fd;
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    return fd;
  }
  return -1;
}

static int yurt_socket_is_host_fd(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  return entry && entry->backend == YURT_SOCKET_BACKEND_HOST;
}

static int yurt_socket_host_ref_count(int host_fd) {
  int count = 0;
  for (size_t i = 0; i < YURT_SOCKET_MAX_TRACKED; i++) {
    if (yurt_sockets[i].guest_fd != 0 && yurt_sockets[i].host_fd == host_fd) count++;
  }
  return count;
}

static int yurt_socket_type_for_fd(int fd) {
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    return yurt_socket_direct_type[fd];
  }
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry && entry->sock_type != 0) return entry->sock_type;
  return SOCK_STREAM;
}

int yurt_socket_dup_fd_min(int fd, int min_fd) {
  yurt_socket_entry *src = yurt_socket_find(fd);
  if (!src || min_fd < 0) {
    errno = EBADF;
    return -1;
  }

  yurt_socket_entry *dst = yurt_socket_alloc_at_least(min_fd);
  if (!dst) return -1;
  int guest_fd = dst->guest_fd;
  *dst = *src;
  dst->guest_fd = guest_fd;
  return dst->guest_fd;
}

int yurt_socket_dup_fd(int fd) {
  return yurt_socket_dup_fd_min(fd, 0);
}

int yurt_socket_get_status_flags(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) return entry->status_flags;
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    return yurt_socket_direct_status_flags[fd];
  }
  return 0;
}

int yurt_socket_set_status_flags(int fd, int flags) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) {
    entry->status_flags = flags;
    return 0;
  }
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    yurt_socket_direct_status_flags[fd] = flags;
    return 0;
  }
  errno = EBADF;
  return -1;
}

int yurt_socket_get_descriptor_flags(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) return entry->descriptor_flags;
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    return yurt_socket_direct_descriptor_flags[fd];
  }
  return 0;
}

int yurt_socket_set_descriptor_flags(int fd, int flags) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) {
    entry->descriptor_flags = flags & FD_CLOEXEC;
    return 0;
  }
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    yurt_socket_direct_descriptor_flags[fd] = flags & FD_CLOEXEC;
    return 0;
  }
  errno = EBADF;
  return -1;
}

static void yurt_socket_forget(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) memset(entry, 0, sizeof(*entry));
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX) {
    yurt_socket_direct_status_flags[fd] = 0;
    yurt_socket_direct_descriptor_flags[fd] = 0;
    yurt_socket_direct_type[fd] = 0;
  }
}

static void yurt_socket_apply_direct_type_flags(int fd, int type) {
  if (fd < 0 || fd >= YURT_SOCKET_DIRECT_FLAGS_MAX) return;
  yurt_socket_direct_status_flags[fd] = ((type & SOCK_NONBLOCK) != 0) ? O_NONBLOCK : 0;
  yurt_socket_direct_descriptor_flags[fd] = ((type & SOCK_CLOEXEC) != 0) ? FD_CLOEXEC : 0;
}

static void yurt_socket_entry_adopt_kernel_fd(yurt_socket_entry *entry, int kernel_fd) {
  entry->host_fd = kernel_fd;
  entry->backend = YURT_SOCKET_BACKEND_KERNEL;
}

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
    case YURT_HOST_EPROTOTYPE:
      return EPROTOTYPE;
    case YURT_HOST_EAFNOSUPPORT:
      return EAFNOSUPPORT;
    case YURT_HOST_EADDRINUSE:
      return EADDRINUSE;
    default:
      return fallback;
  }
}

static int yurt_unix_addr_bytes(
  const struct sockaddr_un *un,
  socklen_t addrlen,
  char *out,
  size_t out_cap
) {
  const char prefix[] = "unix:";
  size_t prefix_len = sizeof(prefix) - 1;
  size_t payload_len;

  if (!un || out_cap < prefix_len + 1) return -1;
  memcpy(out, prefix, prefix_len);
  if (un->sun_path[0] == '\0') {
    payload_len = (size_t)addrlen > offsetof(struct sockaddr_un, sun_path) + 1
      ? (size_t)addrlen - offsetof(struct sockaddr_un, sun_path) - 1
      : 0;
    if (prefix_len + 1 + payload_len > out_cap) return -1;
    out[prefix_len] = '\0';
    memcpy(out + prefix_len + 1, un->sun_path + 1, payload_len);
    return (int)(prefix_len + 1 + payload_len);
  }

  payload_len = strnlen(un->sun_path, sizeof(un->sun_path) - 1);
  if (payload_len == 0 || prefix_len + payload_len > out_cap) return -1;
  memcpy(out + prefix_len, un->sun_path, payload_len);
  return (int)(prefix_len + payload_len);
}

static void set_socket_errno_from_host(int err) {
  switch (err) {
    case YURT_HOST_ERR_NOT_FOUND:
      errno = EBADF;
      break;
    case YURT_HOST_ERR_AGAIN:
      errno = EAGAIN;
      break;
    case YURT_HOST_ERR_INVALID:
      errno = EINVAL;
      break;
    case YURT_HOST_ERR_UNSUPPORTED:
      errno = EOPNOTSUPP;
      break;
    case YURT_HOST_ERR_IO:
    default:
      errno = EIO;
      break;
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
    if (base_type == SOCK_DGRAM) {
      int fd = yurt_sys_socket_open(AF_UNIX, base_type, 0);
      if (fd < 0) {
        errno = yurt_errno_from_host(fd, EMFILE);
        return -1;
      }
      if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX) {
        yurt_socket_direct_type[fd] = SOCK_DGRAM;
        yurt_socket_apply_direct_type_flags(fd, type);
      }
      return fd;
    }
    yurt_socket_entry *entry = yurt_socket_alloc_pending(AF_UNIX, base_type, type);
    if (!entry) return -1;
    return entry->guest_fd;
  }
  if (domain != AF_INET || (type & SOCK_STREAM) != SOCK_STREAM) {
    errno = EAFNOSUPPORT;
    return -1;
  }

  (void)protocol;
  int base_type = type & ~SOCK_CLOEXEC & ~SOCK_NONBLOCK;
  yurt_socket_entry *entry = yurt_socket_alloc_pending(AF_INET, base_type, type);
  if (!entry) return -1;
  return entry->guest_fd;
}

int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  YURT_MARKER_CALL(connect);
  char host[256];
  int rc;
  yurt_socket_entry *entry = yurt_socket_find(sockfd);

  if (!addr || addrlen < 2) {
    errno = EINVAL;
    return -1;
  }
  if (!entry || entry->backend != YURT_SOCKET_BACKEND_PENDING) {
    errno = EISCONN;
    return -1;
  }

  if (addr->sa_family == AF_UNIX) {
    const struct sockaddr_un *un = (const struct sockaddr_un *)addr;
    char unix_addr[sizeof("unix:") + sizeof(un->sun_path)];
    int unix_addr_len = yurt_unix_addr_bytes(un, addrlen, unix_addr, sizeof(unix_addr));
    if (entry->domain != AF_UNIX || unix_addr_len < 0) {
      errno = EINVAL;
      return -1;
    }
    rc = yurt_sys_socket_connect(AF_UNIX, entry->sock_type, entry->status_flags,
      unix_addr, unix_addr_len);
    if (rc < 0) { errno = yurt_errno_from_host(rc, ECONNREFUSED); return -1; }
    yurt_socket_entry_adopt_kernel_fd(entry, rc);
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

  if (entry->domain != AF_INET) {
    errno = EAFNOSUPPORT;
    return -1;
  }
  int addr_len = snprintf(entry->addr, sizeof(entry->addr), "%s:%u",
    host, (unsigned)ntohs(in->sin_port));
  if (addr_len < 0 || addr_len >= (int)sizeof(entry->addr)) {
    errno = EOVERFLOW;
    return -1;
  }
  rc = yurt_sys_socket_connect(AF_INET, entry->sock_type, entry->status_flags,
    entry->addr, addr_len);
  if (rc < 0) { errno = yurt_errno_from_host(rc, ECONNREFUSED); return -1; }
  yurt_socket_entry_adopt_kernel_fd(entry, rc);
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

static int yurt_fill_sockaddr_from_text(
  struct sockaddr *addr,
  socklen_t *addrlen,
  const char *text,
  int text_len
) {
  char tmp[YURT_SOCKET_ADDR_MAX];
  char *colon;
  struct sockaddr_in in;
  if (text_len <= 0 || text_len >= (int)sizeof(tmp)) {
    errno = EINVAL;
    return -1;
  }
  memcpy(tmp, text, (size_t)text_len);
  tmp[text_len] = '\0';
  if (strncmp(tmp, "unix:", 5) == 0) {
    return yurt_fill_sockaddr_un(addr, addrlen, tmp + 5);
  }
  colon = strrchr(tmp, ':');
  if (!colon) {
    errno = EINVAL;
    return -1;
  }
  *colon = '\0';
  memset(&in, 0, sizeof(in));
  in.sin_family = AF_INET;
  in.sin_port = htons((uint16_t)strtoul(colon + 1, NULL, 10));
  if (inet_pton(AF_INET, tmp, &in.sin_addr) != 1) {
    errno = EINVAL;
    return -1;
  }
  if (!addr || !addrlen || *addrlen < (socklen_t)sizeof(in)) {
    errno = EINVAL;
    return -1;
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
  (void)host_field;
  (void)port_field;
  if (strcmp(kind, "peer") == 0) {
    errno = EOPNOTSUPP;
    return -1;
  }
  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd < 0) {
    errno = EBADF;
    return -1;
  }
  char text[YURT_SOCKET_ADDR_MAX];
  int n = yurt_sys_socket_addr(kernel_fd, text, (int)sizeof(text));
  if (n < 0) {
    errno = yurt_errno_from_host(n, ENOTCONN);
    return -1;
  }
  if (n == 0) {
    if (addrlen) *addrlen = 0;
    return 0;
  }
  return yurt_fill_sockaddr_from_text(addr, addrlen, text, n);
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
  yurt_socket_entry *entry = yurt_socket_find(sockfd);

  if (!addr || addrlen < 2) { errno = EINVAL; return -1; }

  if (addr->sa_family == AF_UNIX) {
    const struct sockaddr_un *un = (const struct sockaddr_un *)addr;
    char unix_addr[sizeof("unix:") + sizeof(un->sun_path)];
    int unix_addr_len = yurt_unix_addr_bytes(un, addrlen, unix_addr, sizeof(unix_addr));
    if (unix_addr_len < 0) {
      errno = EINVAL;
      return -1;
    }
    int kernel_fd = yurt_socket_kernel_fd(sockfd);
    if (kernel_fd >= 0) {
      rc = yurt_sys_socket_bind(kernel_fd, unix_addr, unix_addr_len);
      if (rc == 0) return 0;
      errno = yurt_errno_from_host(rc, EADDRINUSE);
      return -1;
    }
    if (!entry || entry->backend != YURT_SOCKET_BACKEND_PENDING ||
        entry->domain != AF_UNIX || unix_addr_len > YURT_SOCKET_ADDR_MAX) {
      errno = EBADF;
      return -1;
    }
    memcpy(entry->addr, unix_addr, (size_t)unix_addr_len);
    entry->addr_len = unix_addr_len;
    return 0;
  }

  if (!entry || entry->backend != YURT_SOCKET_BACKEND_PENDING || entry->domain != AF_INET) {
    errno = EBADF;
    return -1;
  }
  if (yurt_sockaddr_to_host_port(addr, addrlen, host, sizeof(host), &port) != 0) {
    return -1;
  }
  int bind_len = snprintf(entry->addr, sizeof(entry->addr), "%s:%u", host, (unsigned)port);
  if (bind_len < 0 || bind_len >= (int)sizeof(entry->addr)) {
    errno = EOVERFLOW;
    return -1;
  }
  entry->addr_len = bind_len;
  return 0;
}

int listen(int sockfd, int backlog) {
  YURT_MARKER_CALL(listen);
  yurt_socket_entry *entry = yurt_socket_find(sockfd);

  if (yurt_socket_type_for_fd(sockfd) == SOCK_DGRAM) { errno = EOPNOTSUPP; return -1; }
  if (!entry || entry->backend != YURT_SOCKET_BACKEND_PENDING) {
    errno = EINVAL;
    return -1;
  }
  if (entry->addr_len == 0) {
    if (entry->domain == AF_INET) {
      memcpy(entry->addr, "0.0.0.0:0", 9);
      entry->addr_len = 9;
    } else {
      errno = EINVAL;
      return -1;
    }
  }
  int rc = yurt_sys_socket_listen(backlog, entry->addr, entry->addr_len);
  if (rc < 0) {
    errno = yurt_errno_from_host(rc, EADDRINUSE);
    return -1;
  }
  yurt_socket_entry_adopt_kernel_fd(entry, rc);
  return 0;
}

static int yurt_accept_impl(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(accept);
  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd < 0) {
    errno = EBADF;
    return -1;
  }
  int accepted = yurt_sys_socket_accept(kernel_fd, yurt_socket_get_status_flags(sockfd));
  if (accepted < 0) {
    errno = yurt_errno_from_host(accepted, EAGAIN);
    return -1;
  }
  if (accepted >= 0 && accepted < YURT_SOCKET_DIRECT_FLAGS_MAX) {
    yurt_socket_direct_type[accepted] = SOCK_STREAM;
  }
  if (addrlen) *addrlen = 0;
  (void)addr;
  return accepted;
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return yurt_accept_impl(sockfd, addr, addrlen);
}

int __wrap_accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return yurt_accept_impl(sockfd, addr, addrlen);
}

static ssize_t yurt_send_impl(int sockfd, const void *buf, size_t len, int flags) {
  YURT_MARKER_CALL(send);
  int req_len;
  int n;

  if (len > INT_MAX) {
    errno = EOVERFLOW;
    return -1;
  }
  req_len = (int)len;
  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd >= 0) {
    n = yurt_sys_socket_send(kernel_fd, buf, req_len);
    if (n < 0) {
      errno = yurt_errno_from_host(n, EIO);
      return -1;
    }
    return (ssize_t)n;
  }
  if (!yurt_socket_is_host_fd(sockfd)) {
    errno = EBADF;
    return -1;
  }
  n = yurt_host_socket_send(yurt_socket_host_fd(sockfd), (int)(intptr_t)buf, req_len, flags);
  if (n < 0) {
    set_socket_errno_from_host(n);
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

  if (len > INT_MAX) {
    errno = EOVERFLOW;
    return -1;
  }

  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd >= 0) {
    int sys_flags = (flags == MSG_PEEK || flags == YURT_MSG_PEEK) ? MSG_PEEK : 0;
    n = yurt_sys_socket_recv(kernel_fd, buf, (int)len, sys_flags);
    if (n < 0) {
      errno = yurt_errno_from_host(n, EAGAIN);
      return -1;
    }
    return (ssize_t)n;
  }

  if (!yurt_socket_is_host_fd(sockfd)) {
    errno = EBADF;
    return -1;
  }
  if ((yurt_socket_get_status_flags(sockfd) & O_NONBLOCK) != 0) {
    flags |= 0x04;
  }
  n = yurt_host_socket_recv(yurt_socket_host_fd(sockfd), (int)(intptr_t)buf, (int)len, flags);
  if (n < 0) {
    set_socket_errno_from_host(n);
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
    /* AF_UNIX SOCK_DGRAM sendto: typed binary call */
    const struct sockaddr_un *un = (const struct sockaddr_un *)dest_addr;
    char unix_addr[sizeof("unix:") + sizeof(un->sun_path)];
    int unix_addr_len = yurt_unix_addr_bytes(un, addrlen, unix_addr, sizeof(unix_addr));
    int sent;
    if (unix_addr_len < 0) {
      errno = EINVAL;
      return -1;
    }
    int kernel_fd = yurt_socket_kernel_fd(sockfd);
    if (kernel_fd < 0) { errno = EBADF; return -1; }
    sent = yurt_sys_socket_sendto(kernel_fd, buf, (int)len, flags, unix_addr, unix_addr_len);
    if (sent < 0) { errno = yurt_errno_from_host(sent, ENOENT); return -1; }
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
  if (src_addr && addrlen) *addrlen = 0;
  (void)src_addr;
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
    if (yurt_socket_kernel_fd(sockfd) >= 0) return 0;
    if (!yurt_socket_is_host_fd(sockfd)) { errno = EBADF; return -1; }
    int enabled = (*(const int *)optval) != 0;
    int rc = yurt_host_socket_option(yurt_socket_host_fd(sockfd), YURT_SOCKET_OPT_TCP_NODELAY, 1, enabled);
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
      value = yurt_socket_type_for_fd(sockfd);
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
      if (yurt_socket_kernel_fd(sockfd) >= 0) {
        value = 0;
        break;
      }
      if (!yurt_socket_is_host_fd(sockfd)) { errno = EBADF; return -1; }
      int rc = yurt_host_socket_option(yurt_socket_host_fd(sockfd), YURT_SOCKET_OPT_TCP_NODELAY, 0, 0);
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
  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd >= 0) {
    int rc = yurt_sys_socket_close(kernel_fd);
    if (rc < 0) {
      errno = yurt_errno_from_host(rc, EIO);
      return -1;
    }
    yurt_socket_forget(sockfd);
    return 0;
  }
  if (!yurt_socket_is_host_fd(sockfd)) {
    errno = EBADF;
    return -1;
  }
  int host_fd = yurt_socket_host_fd(sockfd);
  int rc = yurt_host_socket_close(host_fd);
  if (rc < 0) {
    errno = yurt_errno_from_host(rc, EIO);
    return -1;
  }
  yurt_socket_forget(sockfd);
  return 0;
}

/* socketpair — backed by Rust-kernel AF_UNIX sockets.  Cleanup uses
 * yurt_socketpair_release() so every early-exit path frees any sockets already
 * allocated. */
static void yurt_socketpair_release(int fd) {
  if (fd < 0) return;
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
  if (yurt_sys_socketpair(AF_UNIX, base_type, 0, (int)(intptr_t)fds) < 0) {
    errno = ENOTSUP;
    return -1;
  }
  if (fds[0] < 0 || fds[1] < 0) { errno = ENOTSUP; return -1; }
  for (int i = 0; i < 2; i++) {
    if (fds[i] >= 0 && fds[i] < YURT_SOCKET_DIRECT_FLAGS_MAX) {
      yurt_socket_direct_type[fds[i]] = base_type;
    }
  }

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

  int rc;
  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd >= 0) {
    rc = yurt_sys_socket_sendmsg(kernel_fd, data, (int)total,
      fds_count > 0 ? fds_buf : NULL, fds_count);
  } else if (yurt_socket_is_host_fd(sockfd)) {
    rc = yurt_host_socket_sendmsg(sockfd,
      (int)(intptr_t)data, (int)total,
      fds_count > 0 ? (int)(intptr_t)fds_buf : 0, fds_count);
  } else {
    free(data);
    errno = EBADF;
    return -1;
  }
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
  int rc;
  int kernel_fd = yurt_socket_kernel_fd(sockfd);
  if (kernel_fd >= 0) {
    rc = yurt_sys_socket_recvmsg(kernel_fd, buf, (int)total_iov,
      max_fds > 0 ? recv_fds : NULL, max_fds, &n_fds);
  } else if (yurt_socket_is_host_fd(sockfd)) {
    rc = yurt_host_socket_recvmsg(sockfd,
      (int)(intptr_t)buf, (int)total_iov,
      max_fds > 0 ? (int)(intptr_t)recv_fds : 0, max_fds,
      (int)(intptr_t)&n_fds);
  } else {
    free(buf);
    errno = EBADF;
    return -1;
  }

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
  struct yurt_ucred {
    pid_t pid;
    uid_t uid;
    gid_t gid;
  } cred;
  int pid = 0, uid = 0, gid = 0;

  if (!optval || !optlen || *optlen < (socklen_t)sizeof(cred)) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_socket_kernel_fd(sockfd) >= 0) {
    pid = 1;
    uid = 1000;
    gid = 1000;
  } else if (yurt_socket_is_host_fd(sockfd) &&
      yurt_host_socket_peercred(sockfd, &pid, &uid, &gid) == 0) {
    /* host backend filled pid/uid/gid */
  } else {
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

extern int __real_close(int fd);

int yurt_socket_is_tracked_fd(int fd) {
  return yurt_socket_find(fd) != NULL ||
         (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX && yurt_socket_direct_type[fd] != 0);
}

int yurt_socket_is_guest_fd(int fd) {
  return yurt_socket_find(fd) != NULL;
}

int __wrap_socket(int domain, int type, int protocol)
  __attribute__((alias("socket")));
int __wrap_connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen)
  __attribute__((alias("connect")));
int __wrap_getpeername(int sockfd, struct sockaddr *addr, socklen_t *addrlen)
  __attribute__((alias("getpeername")));
int __wrap_getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen)
  __attribute__((alias("getsockname")));
int __wrap_bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen)
  __attribute__((alias("bind")));
int __wrap_listen(int sockfd, int backlog)
  __attribute__((alias("listen")));
int __wrap_setsockopt(
  int sockfd,
  int level,
  int optname,
  const void *optval,
  socklen_t optlen
) __attribute__((alias("setsockopt")));
int __wrap_shutdown(int sockfd, int how)
  __attribute__((alias("shutdown")));

int __wrap_close(int fd) {
  yurt_socket_entry *entry = yurt_socket_find(fd);
  if (entry) {
    if (entry->backend == YURT_SOCKET_BACKEND_PENDING) {
      yurt_socket_forget(fd);
      return 0;
    }
    if (entry->backend == YURT_SOCKET_BACKEND_KERNEL) {
      if (yurt_socket_host_ref_count(entry->host_fd) <= 1) {
        int rc = yurt_sys_socket_close(entry->host_fd);
        if (rc != 0) return __real_close(fd);
      }
      yurt_socket_forget(fd);
      return 0;
    }
    int host_fd = entry->host_fd;
    if (yurt_socket_host_ref_count(host_fd) <= 1) {
      int rc = yurt_host_socket_close(host_fd);
      if (rc != 0) return __real_close(fd);
      yurt_socket_forget(fd);
      return 0;
    }
    yurt_socket_forget(fd);
    return 0;
  }
  if (fd >= 0 && fd < YURT_SOCKET_DIRECT_FLAGS_MAX &&
      yurt_socket_direct_type[fd] != 0) {
    int rc = yurt_sys_socket_close(fd);
    if (rc == 0) {
      yurt_socket_forget(fd);
      return 0;
    }
  }
  int rc = __real_close(fd);
  if (rc == 0) yurt_socket_forget(fd);
  return rc;
}
