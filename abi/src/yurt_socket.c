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

/* Our sys/socket.h pins SOCK_DGRAM=2 and SOCK_STREAM=1 independent of WASI
 * values. The host_socket_socketpair wire protocol relies on these values.
 * Fire a compile error if the toolchain redefines them unexpectedly. */
_Static_assert(SOCK_DGRAM == 2,
  "SOCK_DGRAM != 2: update the socketpair wire protocol on both C and host sides");
_Static_assert(SOCK_STREAM == 1,
  "SOCK_STREAM != 1: update the socketpair wire protocol on both C and host sides");

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

#define YURT_SOCKET_RESP_CAP 4096
#define YURT_SOCKET_RECV_MAX_RAW 3000

/* wasi-libc already ships strong definitions for some POSIX socket names.
 * yurt-cc/cargo-yurt pass --wrap for the duplicate-owned symbols we implement
 * here (`accept`, `send`, `recv`, `getsockopt`) so Rust and C guests both route
 * through libyurt without using yurt-specific symbol names. */

/* Forward declaration for SO_PEERCRED helper (Slice 6) */
static int yurt_getsockopt_peercred(int sockfd, void *optval, socklen_t *optlen);

static const char *find_json_field(const char *json, size_t json_len, const char *field) {
  char needle[64];
  int written = snprintf(needle, sizeof(needle), "\"%s\":", field);
  size_t needle_len;

  if (written <= 0 || (size_t)written >= sizeof(needle)) {
    return NULL;
  }
  needle_len = (size_t)written;
  if (needle_len > json_len) {
    return NULL;
  }

  for (size_t offset = 0; offset + needle_len <= json_len; ++offset) {
    if (memcmp(json + offset, needle, needle_len) == 0) {
      return json + offset + needle_len;
    }
  }

  return NULL;
}

static int parse_json_int(const char *json, size_t json_len, const char *field_name, int *out) {
  const char *field = find_json_field(json, json_len, field_name);
  char *end = NULL;
  long value;

  if (!field) {
    errno = EIO;
    return -1;
  }
  value = strtol(field, &end, 10);
  if (end == field) {
    errno = EIO;
    return -1;
  }
  *out = (int)value;
  return 0;
}

static int parse_json_ok(const char *json, size_t json_len) {
  const char *field = find_json_field(json, json_len, "ok");
  if (!field) {
    return 0;
  }
  return field + 4 <= json + json_len && memcmp(field, "true", 4) == 0;
}

static int json_contains(const char *json, size_t json_len, const char *needle) {
  size_t needle_len = strlen(needle);
  if (needle_len == 0 || needle_len > json_len) {
    return 0;
  }
  for (size_t offset = 0; offset + needle_len <= json_len; ++offset) {
    if (memcmp(json + offset, needle, needle_len) == 0) {
      return 1;
    }
  }
  return 0;
}

static int parse_json_string_field(
  const char *json,
  size_t json_len,
  const char *field_name,
  char *dst,
  size_t cap
) {
  const char *field = find_json_field(json, json_len, field_name);
  const char *end = json + json_len;
  size_t used = 0;

  if (!field || cap == 0 || field >= end || *field != '"') {
    errno = EIO;
    return -1;
  }
  field += 1;

  while (field < end) {
    char ch = *field++;
    if (ch == '"') {
      dst[used] = '\0';
      return 0;
    }
    if (ch == '\\') {
      if (field >= end) {
        errno = EIO;
        return -1;
      }
      ch = *field++;
      switch (ch) {
        case '"':
        case '\\':
        case '/':
          break;
        case 'n':
          ch = '\n';
          break;
        case 'r':
          ch = '\r';
          break;
        case 't':
          ch = '\t';
          break;
        default:
          errno = EIO;
          return -1;
      }
    }
    if (used + 1 >= cap) {
      errno = EOVERFLOW;
      return -1;
    }
    dst[used++] = ch;
  }

  errno = EIO;
  return -1;
}

static int base64_encode(const unsigned char *src, size_t len, char *dst, size_t cap) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t out_len = ((len + 2) / 3) * 4;
  size_t out = 0;

  if (out_len + 1 > cap) {
    errno = EOVERFLOW;
    return -1;
  }

  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = (uint32_t)src[i] << 16;
    int have2 = i + 1 < len;
    int have3 = i + 2 < len;
    if (have2) v |= (uint32_t)src[i + 1] << 8;
    if (have3) v |= src[i + 2];

    dst[out++] = table[(v >> 18) & 0x3f];
    dst[out++] = table[(v >> 12) & 0x3f];
    dst[out++] = have2 ? table[(v >> 6) & 0x3f] : '=';
    dst[out++] = have3 ? table[v & 0x3f] : '=';
  }
  dst[out] = '\0';
  return (int)out;
}

static int base64_value(char ch) {
  if (ch >= 'A' && ch <= 'Z') return ch - 'A';
  if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
  if (ch >= '0' && ch <= '9') return ch - '0' + 52;
  if (ch == '+') return 62;
  if (ch == '/') return 63;
  return -1;
}

static ssize_t base64_decode(const char *src, unsigned char *dst, size_t cap) {
  size_t len = strlen(src);
  size_t out = 0;

  if (len % 4 != 0) {
    errno = EIO;
    return -1;
  }

  for (size_t i = 0; i < len; i += 4) {
    int a = base64_value(src[i]);
    int b = base64_value(src[i + 1]);
    int c = src[i + 2] == '=' ? -2 : base64_value(src[i + 2]);
    int d = src[i + 3] == '=' ? -2 : base64_value(src[i + 3]);
    uint32_t v;

    if (a < 0 || b < 0 || c == -1 || d == -1) {
      errno = EIO;
      return -1;
    }

    v = ((uint32_t)a << 18) | ((uint32_t)b << 12)
      | (uint32_t)(c < 0 ? 0 : c) << 6
      | (uint32_t)(d < 0 ? 0 : d);

    if (out >= cap) break;
    dst[out++] = (unsigned char)((v >> 16) & 0xff);
    if (c == -2) continue;
    if (out >= cap) break;
    dst[out++] = (unsigned char)((v >> 8) & 0xff);
    if (d == -2) continue;
    if (out >= cap) break;
    dst[out++] = (unsigned char)(v & 0xff);
  }

  return (ssize_t)out;
}

int socket(int domain, int type, int protocol) {
  YURT_MARKER_CALL(socket);

  if (domain == AF_UNIX) {
    /* AF_UNIX: allow SOCK_STREAM (1) and SOCK_DGRAM (2). */
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
  char req[256];
  char resp[YURT_SOCKET_RESP_CAP];
  int n;

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

  n = snprintf(
    req, sizeof(req),
    "{\"fd\":%d,\"host\":\"%s\",\"port\":%u,\"tls\":false}",
    sockfd,
    host,
    (unsigned)ntohs(in->sin_port)
  );
  if (n < 0 || (size_t)n >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }

  n = yurt_host_socket_connect(
    (int)(intptr_t)req,
    n,
    (int)(intptr_t)resp,
    (int)sizeof(resp)
  );
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = ECONNREFUSED;
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
    size_t namelen = strlen(path + 1);
    un.sun_path[0] = '\0';
    strncpy(un.sun_path + 1, path + 1, sizeof(un.sun_path) - 2);
    (void)namelen;
  } else {
    strncpy(un.sun_path, path, sizeof(un.sun_path) - 1);
  }
  size_t copy = (*addrlen < sizeof(un)) ? (size_t)*addrlen : sizeof(un);
  memcpy(addr, &un, copy);
  *addrlen = (socklen_t)sizeof(un);
  return 0;
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
  const char *host_field,
  const char *port_field
) {
  char req[64];
  char resp[YURT_SOCKET_RESP_CAP];
  char host[256];
  int port = 0;
  int req_len;
  int n;

  /* Pass "op":"local" for getsockname, "op":"peer" for getpeername so the
   * host can return ENOTCONN when the peer address is not available. */
  {
    const char *op = (host_field[0] == 'p') ? "peer" : "local";
    req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"op\":\"%s\"}", sockfd, op);
  }
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }

  n = yurt_host_socket_addr((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = ENOTCONN;
    return -1;
  }

  /* Check for AF_UNIX path fields (local_path / peer_path) or abstract fields
   * (local_abstract / peer_abstract). host_field for getsockname is "local_host"
   * → path field is "local_path", abstract field is "local_abstract";
   * for getpeername it is "peer_host" → "peer_path" / "peer_abstract". */
  {
    /* Derive the path field name: replace trailing "_host" with "_path". */
    char path_field[64];
    char abstract_field[64];
    size_t hf_len = strlen(host_field);
    /* host_field ends in "_host"; replace with "_path" and "_abstract". */
    if (hf_len > 5 && memcmp(host_field + hf_len - 5, "_host", 5) == 0) {
      snprintf(path_field, sizeof(path_field), "%.*s_path", (int)(hf_len - 5), host_field);
      snprintf(abstract_field, sizeof(abstract_field), "%.*s_abstract", (int)(hf_len - 5), host_field);
    } else {
      path_field[0] = '\0';
      abstract_field[0] = '\0';
    }
    if (abstract_field[0] != '\0') {
      char abstract_name[107]; /* 108 - 1 for NUL prefix */
      if (parse_json_string_field(resp, (size_t)n, abstract_field, abstract_name, sizeof(abstract_name)) == 0) {
        /* Reconstruct path with leading NUL: "\0name" */
        char unix_path[109];
        unix_path[0] = '\0';
        strncpy(unix_path + 1, abstract_name, sizeof(unix_path) - 2);
        unix_path[sizeof(unix_path) - 1] = '\0';
        return yurt_fill_sockaddr_un(addr, addrlen, unix_path);
      }
    }
    if (path_field[0] != '\0') {
      char unix_path[108];
      if (parse_json_string_field(resp, (size_t)n, path_field, unix_path, sizeof(unix_path)) == 0) {
        return yurt_fill_sockaddr_un(addr, addrlen, unix_path);
      }
    }
  }

  if (parse_json_string_field(resp, (size_t)n, host_field, host, sizeof(host)) != 0 ||
      parse_json_int(resp, (size_t)n, port_field, &port) != 0) {
    return -1;
  }

  return yurt_fill_sockaddr_from_host(addr, addrlen, host, port);
}

int getpeername(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(getpeername);
  return yurt_sockname_impl(sockfd, addr, addrlen, "peer_host", "peer_port");
}

int getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(getsockname);
  return yurt_sockname_impl(sockfd, addr, addrlen, "local_host", "local_port");
}

int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen) {
  YURT_MARKER_CALL(bind);
  char host[INET_ADDRSTRLEN];
  int port;
  char req[256];
  char resp[YURT_SOCKET_RESP_CAP];
  int req_len;
  int n;

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
  req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"host\":\"%s\",\"port\":%d}", sockfd, host, port);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  n = yurt_host_socket_bind((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = EOPNOTSUPP;
    return -1;
  }
  return 0;
}

int listen(int sockfd, int backlog) {
  YURT_MARKER_CALL(listen);
  char req[128];
  char resp[YURT_SOCKET_RESP_CAP];
  int req_len;
  int n;

  req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"backlog\":%d}", sockfd, backlog);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  n = yurt_host_socket_listen((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = EOPNOTSUPP;
    return -1;
  }
  return 0;
}

static int yurt_accept_impl(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  YURT_MARKER_CALL(accept);
  char req[128];
  char resp[YURT_SOCKET_RESP_CAP];
  char peer_host[64];
  int peer_port = 0;
  int accepted_fd = -1;
  int req_len;
  int n;
  int attempts = 0;

  req_len = snprintf(req, sizeof(req), "{\"fd\":%d}", sockfd);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  for (;;) {
    n = yurt_host_socket_accept((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
    if (n <= 0) {
      errno = EOPNOTSUPP;
      return -1;
    }
    if (parse_json_ok(resp, (size_t)n)) break;
    if (json_contains(resp, (size_t)n, "\"wouldBlock\":true") ||
        json_contains(resp, (size_t)n, "\"would_block\":true")) {
      if (++attempts > 100000) {
        errno = EAGAIN;
        return -1;
      }
      yurt_host_yield();
      continue;
    }
    errno = EOPNOTSUPP;
    return -1;
  }
  if (parse_json_int(resp, (size_t)n, "fd", &accepted_fd) != 0) {
    return -1;
  }
  if (addr && addrlen) {
    char peer_path[108];
    char peer_abstract[107];
    /* AF_UNIX accept: response carries peer_path or peer_abstract instead
     * of peer_host/peer_port. Check for the path fields first. */
    if (parse_json_string_field(resp, (size_t)n, "peer_abstract", peer_abstract, sizeof(peer_abstract)) == 0) {
      char unix_path[109];
      unix_path[0] = '\0';
      strncpy(unix_path + 1, peer_abstract, sizeof(unix_path) - 2);
      unix_path[sizeof(unix_path) - 1] = '\0';
      if (yurt_fill_sockaddr_un(addr, addrlen, unix_path) != 0) return -1;
    } else if (parse_json_string_field(resp, (size_t)n, "peer_path", peer_path, sizeof(peer_path)) == 0) {
      if (yurt_fill_sockaddr_un(addr, addrlen, peer_path) != 0) return -1;
    } else if (*addrlen >= (socklen_t)sizeof(struct sockaddr_in)) {
      /* AF_INET accept */
      if (parse_json_string_field(resp, (size_t)n, "peer_host", peer_host, sizeof(peer_host)) != 0 ||
          parse_json_int(resp, (size_t)n, "peer_port", &peer_port) != 0 ||
          yurt_fill_sockaddr_from_host(addr, addrlen, peer_host, peer_port) != 0) {
        return -1;
      }
    } else {
      *addrlen = sizeof(struct sockaddr_in);
    }
  }
  return accepted_fd;
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return yurt_accept_impl(sockfd, addr, addrlen);
}

int __wrap_accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
  return yurt_accept_impl(sockfd, addr, addrlen);
}

static ssize_t yurt_send_impl(int sockfd, const void *buf, size_t len, int flags) {
  YURT_MARKER_CALL(send);
  char *encoded;
  char *req;
  char resp[YURT_SOCKET_RESP_CAP];
  int req_len;
  int n;
  int bytes_sent = 0;

  (void)flags;
  encoded = malloc(((len + 2) / 3) * 4 + 1);
  req = malloc(((len + 2) / 3) * 4 + 128);
  if (!encoded || !req) {
    free(encoded);
    free(req);
    errno = ENOMEM;
    return -1;
  }
  if (base64_encode((const unsigned char *)buf, len, encoded, ((len + 2) / 3) * 4 + 1) < 0) {
    free(encoded);
    free(req);
    return -1;
  }
  req_len = sprintf(req, "{\"fd\":%d,\"data_b64\":\"%s\"}", sockfd, encoded);

  n = yurt_host_socket_send((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  free(encoded);
  free(req);
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = EIO;
    return -1;
  }
  if (parse_json_int(resp, (size_t)n, "bytes_sent", &bytes_sent) != 0) {
    return -1;
  }
  return (ssize_t)bytes_sent;
}

ssize_t send(int sockfd, const void *buf, size_t len, int flags) {
  return yurt_send_impl(sockfd, buf, len, flags);
}

ssize_t __wrap_send(int sockfd, const void *buf, size_t len, int flags) {
  return yurt_send_impl(sockfd, buf, len, flags);
}

static ssize_t yurt_recv_impl(int sockfd, void *buf, size_t len, int flags) {
  YURT_MARKER_CALL(recv);
  char req[128];
  char resp[YURT_SOCKET_RESP_CAP];
  char data_b64[YURT_SOCKET_RESP_CAP];
  int req_len;
  int n;

  if (flags != 0 && flags != MSG_PEEK && flags != YURT_MSG_PEEK) {
    errno = EOPNOTSUPP;
    return -1;
  }

  if (len > YURT_SOCKET_RECV_MAX_RAW) {
    len = YURT_SOCKET_RECV_MAX_RAW;
  }

  req_len = snprintf(
    req,
    sizeof(req),
    "{\"fd\":%d,\"max_bytes\":%zu%s}",
    sockfd,
    len,
    (flags == MSG_PEEK || flags == YURT_MSG_PEEK) ? ",\"peek\":true" : ""
  );
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }

  n = yurt_host_socket_recv((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    if (n > 0 && json_contains(resp, (size_t)n, "\"error\":\"EAGAIN\"")) {
      errno = EAGAIN;
      return -1;
    }
    errno = EIO;
    return -1;
  }
  if (parse_json_string_field(resp, (size_t)n, "data_b64", data_b64, sizeof(data_b64)) != 0) {
    return -1;
  }

  return base64_decode(data_b64, (unsigned char *)buf, len);
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
    /* AF_UNIX SOCK_DGRAM sendto: encode path and data in JSON */
    const struct sockaddr_un *un = (const struct sockaddr_un *)dest_addr;
    char *encoded;
    char *req;
    char resp[YURT_SOCKET_RESP_CAP];
    int req_len;
    int n;
    int bytes_sent = 0;
    size_t pathlen;

    (void)flags;
    encoded = malloc(((len + 2) / 3) * 4 + 1);
    req = malloc(((len + 2) / 3) * 4 + 256);
    if (!encoded || !req) {
      free(encoded);
      free(req);
      errno = ENOMEM;
      return -1;
    }
    if (base64_encode((const unsigned char *)buf, len, encoded, ((len + 2) / 3) * 4 + 1) < 0) {
      free(encoded);
      free(req);
      return -1;
    }
    pathlen = strnlen(un->sun_path, sizeof(un->sun_path) - 1);
    req_len = sprintf(req, "{\"fd\":%d,\"data_b64\":\"%s\",\"to\":\"%.*s\"}",
                      sockfd, encoded, (int)pathlen, un->sun_path);
    n = yurt_host_socket_send((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
    free(encoded);
    free(req);
    if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
      errno = EIO;
      return -1;
    }
    if (parse_json_int(resp, (size_t)n, "bytesSent", &bytes_sent) != 0) {
      bytes_sent = (int)len; /* assume all sent on success */
    }
    return (ssize_t)bytes_sent;
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
  /* For AF_UNIX SOCK_DGRAM with src_addr, request from_addr info */
  if (src_addr && addrlen) {
    char req[128];
    char resp[YURT_SOCKET_RESP_CAP];
    char data_b64[YURT_SOCKET_RESP_CAP];
    int req_len;
    int n;
    ssize_t nbytes;

    if (len > YURT_SOCKET_RECV_MAX_RAW) len = YURT_SOCKET_RECV_MAX_RAW;

    req_len = snprintf(req, sizeof(req),
      "{\"fd\":%d,\"max_bytes\":%zu,\"from_addr\":true}",
      sockfd, len);
    if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
      errno = EOVERFLOW;
      return -1;
    }
    n = yurt_host_socket_recv((int)(intptr_t)req, req_len,
                               (int)(intptr_t)resp, (int)sizeof(resp));
    if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
      if (n > 0 && json_contains(resp, (size_t)n, "\"error\":\"EAGAIN\"")) {
        errno = EAGAIN;
        return -1;
      }
      errno = EIO;
      return -1;
    }
    if (parse_json_string_field(resp, (size_t)n, "data_b64", data_b64, sizeof(data_b64)) != 0) {
      return -1;
    }
    nbytes = base64_decode(data_b64, (unsigned char *)buf, len);
    /* Try to fill src_addr if from_path is present */
    {
      char from_path[108];
      if (parse_json_string_field(resp, (size_t)n, "from_path", from_path, sizeof(from_path)) == 0
          && from_path[0] != '\0') {
        yurt_fill_sockaddr_un(src_addr, addrlen, from_path);
      } else {
        *addrlen = 0;
      }
    }
    return nbytes;
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
    char req[160];
    char resp[YURT_SOCKET_RESP_CAP];
    int enabled = (*(const int *)optval) != 0;
    int req_len = snprintf(
      req,
      sizeof(req),
      "{\"fd\":%d,\"option\":\"no_delay\",\"value\":%s}",
      sockfd,
      enabled ? "true" : "false"
    );
    int n;

    if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
      errno = EOVERFLOW;
      return -1;
    }
    n = yurt_host_socket_option((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
    if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
      errno = EOPNOTSUPP;
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
      char req[128];
      char resp[YURT_SOCKET_RESP_CAP];
      int req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"option\":\"no_delay\"}", sockfd);
      int n;

      if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
        errno = EOVERFLOW;
        return -1;
      }
      n = yurt_host_socket_option((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
      if (n <= 0 || !parse_json_ok(resp, (size_t)n) || parse_json_int(resp, (size_t)n, "value", &value) != 0) {
        errno = EOPNOTSUPP;
        return -1;
      }
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
  char req[64];
  int req_len;

  (void)how;
  req_len = snprintf(req, sizeof(req), "{\"fd\":%d}", sockfd);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }
  if (yurt_host_socket_close((int)(intptr_t)req, req_len) != 0) {
    errno = EIO;
    return -1;
  }
  return 0;
}

/* socketpair — backed by the in-kernel UnixSocketRegistry via
 * host_socket_socketpair.  Returns a connected AF_UNIX SOCK_STREAM
 * pair.  Cleanup uses yurt_socketpair_release() so every early-exit
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
  if (yurt_host_socket_socketpair(1 /* AF_UNIX */, base_type,
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
  if (msg->msg_control && orig_controllen > 0) {
    max_fds = (int)((orig_controllen - CMSG_LEN(0)) / sizeof(int));
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
      int fit = (int)((orig_controllen - CMSG_LEN(0)) / sizeof(int));
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

/* ── SO_PEERCRED getsockopt (Slice 6) ─────────────────────────────────── */
static int yurt_getsockopt_peercred(int sockfd, void *optval, socklen_t *optlen) {
  char req[64];
  char resp[YURT_SOCKET_RESP_CAP];
  struct ucred cred;
  int pid = 0, uid = 0, gid = 0;
  int req_len, n;

  if (!optval || !optlen || *optlen < (socklen_t)sizeof(struct ucred)) {
    errno = EINVAL;
    return -1;
  }
  req_len = snprintf(req, sizeof(req), "{\"fd\":%d,\"option\":\"peercred\"}", sockfd);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) { errno = EOVERFLOW; return -1; }
  n = yurt_host_socket_option((int)(intptr_t)req, req_len,
                               (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) { errno = EOPNOTSUPP; return -1; }
  parse_json_int(resp, (size_t)n, "pid", &pid);
  parse_json_int(resp, (size_t)n, "uid", &uid);
  parse_json_int(resp, (size_t)n, "gid", &gid);
  cred.pid = (pid_t)pid;
  cred.uid = (uid_t)uid;
  cred.gid = (gid_t)gid;
  memcpy(optval, &cred, sizeof(cred));
  *optlen = (socklen_t)sizeof(cred);
  return 0;
}
