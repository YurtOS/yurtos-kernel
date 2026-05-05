#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <arpa/inet.h>
#include <errno.h>
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
YURT_DECLARE_MARKER(connect);
YURT_DECLARE_MARKER(getpeername);
YURT_DECLARE_MARKER(getsockname);
YURT_DECLARE_MARKER(bind);
YURT_DECLARE_MARKER(listen);
YURT_DECLARE_MARKER(accept);
YURT_DECLARE_MARKER(send);
YURT_DECLARE_MARKER(recv);
YURT_DECLARE_MARKER(shutdown);

YURT_DEFINE_MARKER(socket,   0x736f636bu) /* "sock" */
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

/* wasi-libc already ships strong definitions for some POSIX socket names.
 * yurt-cc/cargo-yurt pass --wrap for the duplicate-owned symbols we implement
 * here (`accept`, `send`, `recv`, `getsockopt`) so Rust and C guests both route
 * through libyurt without using yurt-specific symbol names. */

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

  req_len = snprintf(req, sizeof(req), "{\"fd\":%d}", sockfd);
  if (req_len < 0 || (size_t)req_len >= sizeof(req)) {
    errno = EOVERFLOW;
    return -1;
  }

  n = yurt_host_socket_addr((int)(intptr_t)req, req_len, (int)(intptr_t)resp, (int)sizeof(resp));
  if (n <= 0 || !parse_json_ok(resp, (size_t)n)) {
    errno = ENOTCONN;
    return -1;
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
  if (addr && addrlen && *addrlen >= sizeof(struct sockaddr_in)) {
    if (parse_json_string_field(resp, (size_t)n, "peer_host", peer_host, sizeof(peer_host)) != 0 ||
        parse_json_int(resp, (size_t)n, "peer_port", &peer_port) != 0 ||
        yurt_fill_sockaddr_from_host(addr, addrlen, peer_host, peer_port) != 0) {
      return -1;
    }
  } else if (addrlen) {
    *addrlen = sizeof(struct sockaddr_in);
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
