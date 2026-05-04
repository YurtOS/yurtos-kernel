/* socket-canary — verifies the POSIX socket surface compiles and links
 * through libyurt. Runtime network behavior depends on the sandbox's
 * network policy, so this canary only exercises local API shape.
 */
#include <errno.h>
#include <fcntl.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void emit(const char *case_name, int exit_code) {
  printf("{\"case\":\"%s\",\"exit\":%d}\n", case_name, exit_code);
}

int main(void) {
  struct addrinfo hints;
  struct addrinfo *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;

  if (getaddrinfo("127.0.0.1", "9", &hints, &res) != 0 || !res) {
    emit("getaddrinfo", 1);
    return 1;
  }
  freeaddrinfo(res);
  res = NULL;

  if (getaddrinfo("example.com", "80", &hints, &res) != 0 || !res) {
    emit("getaddrinfo_hostname", 1);
    return 1;
  }

  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    freeaddrinfo(res);
    emit("socket", 1);
    return 1;
  }

  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || (flags & O_NONBLOCK) != 0) {
    emit("fcntl_getfl", 1);
    freeaddrinfo(res);
    return 1;
  }
  if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
    emit("fcntl_setfl_nonblock", 1);
    freeaddrinfo(res);
    return 1;
  }
  flags = fcntl(fd, F_GETFL);
  if (flags < 0 || (flags & O_NONBLOCK) == 0) {
    emit("fcntl_getfl_nonblock", 1);
    freeaddrinfo(res);
    return 1;
  }

  int yes = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)) != 0) {
    emit("setsockopt", 1);
    freeaddrinfo(res);
    return 1;
  }
  if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &yes, sizeof(yes)) != 0) {
    emit("setsockopt_keepalive", 1);
    freeaddrinfo(res);
    return 1;
  }
#ifdef IP_BIND_ADDRESS_NO_PORT
  if (setsockopt(fd, SOL_IP, IP_BIND_ADDRESS_NO_PORT, &yes, sizeof(yes)) != 0) {
    emit("setsockopt_ip_bind_address_no_port", 1);
    freeaddrinfo(res);
    return 1;
  }
#endif
#ifndef POLLPRI
#error "POLLPRI must be available for curl-compatible poll headers"
#endif
#ifndef AI_PASSIVE
#error "AI_PASSIVE must be available for CPython-compatible socket headers"
#endif
#ifndef SOMAXCONN
#error "SOMAXCONN must be available for CPython-compatible socket headers"
#endif
  int socket_type = 0;
  socklen_t socket_type_len = sizeof(socket_type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &socket_type, &socket_type_len) != 0 ||
      socket_type != SOCK_STREAM) {
    emit("getsockopt", 1);
    freeaddrinfo(res);
    return 1;
  }
  yes = 1;
  if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes)) != 0) {
    emit("setsockopt_tcp_nodelay", 1);
    freeaddrinfo(res);
    return 1;
  }
  yes = 0;
  socket_type_len = sizeof(yes);
  if (getsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &yes, &socket_type_len) != 0 ||
      yes != 1) {
    emit("getsockopt_tcp_nodelay", 1);
    freeaddrinfo(res);
    return 1;
  }
  errno = 0;
  if (setsockopt(fd, SOL_SOCKET, 0x7fffffff, &yes, sizeof(yes)) != -1 ||
      errno != EOPNOTSUPP) {
    emit("setsockopt_unsupported", 1);
    freeaddrinfo(res);
    return 1;
  }
  errno = 0;
  socket_type_len = sizeof(socket_type);
  if (getsockopt(fd, SOL_SOCKET, 0x7fffffff, &socket_type, &socket_type_len) != -1 ||
      errno != EOPNOTSUPP) {
    emit("getsockopt_unsupported", 1);
    freeaddrinfo(res);
    return 1;
  }

  {
    struct sockaddr_in unsupported;
    memset(&unsupported, 0, sizeof(unsupported));
    unsupported.sin_family = AF_INET;
    unsupported.sin_port = htons(6553);
    inet_pton(AF_INET, "0.0.0.0", &unsupported.sin_addr);
    errno = 0;
    if (bind(fd, (struct sockaddr *)&unsupported, sizeof(unsupported)) != 0) {
      emit("bind_intent", 1);
      freeaddrinfo(res);
      return 1;
    }
    errno = 0;
    if (listen(fd, 1) != -1 || errno != EOPNOTSUPP) {
      emit("listen_policy", 1);
      freeaddrinfo(res);
      return 1;
    }
  }

  if (connect(fd, res->ai_addr, res->ai_addrlen) == 0) {
    char byte = 0;
    (void)send(fd, &byte, 1, 0);
    (void)recv(fd, &byte, 1, 0);
    (void)sendto(fd, &byte, 1, 0, NULL, 0);
    (void)recvfrom(fd, &byte, 1, 0, NULL, NULL);
  } else if (errno == EAFNOSUPPORT || errno == EBADF) {
    emit("connect_unexpected_errno", 1);
    freeaddrinfo(res);
    return 1;
  }

  if (close(fd) != 0) {
    emit("close", 1);
    freeaddrinfo(res);
    return 1;
  }
  {
    char byte = 0;
    if (send(fd, &byte, 1, 0) != -1) {
      emit("send_after_close", 1);
      freeaddrinfo(res);
      return 1;
    }
  }

  freeaddrinfo(res);
  emit("socket_surface", 0);
  return 0;
}
