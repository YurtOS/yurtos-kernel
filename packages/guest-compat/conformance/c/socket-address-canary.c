#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int check_addr(
  const char *name,
  const struct sockaddr_in *addr,
  const char *expected_host,
  unsigned min_port
) {
  char host[INET_ADDRSTRLEN];
  if (addr->sin_family != AF_INET) {
    printf("%s_family=%d\n", name, addr->sin_family);
    return 1;
  }
  if (!inet_ntop(AF_INET, &addr->sin_addr, host, sizeof(host))) {
    printf("%s_ntop=failed\n", name);
    return 1;
  }
  if (strcmp(host, expected_host) != 0) {
    printf("%s_host=%s\n", name, host);
    return 1;
  }
  if ((unsigned)ntohs(addr->sin_port) < min_port) {
    printf("%s_port=%u\n", name, (unsigned)ntohs(addr->sin_port));
    return 1;
  }
  return 0;
}

int main(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    puts("socket=failed");
    return 1;
  }

  struct sockaddr_in target;
  memset(&target, 0, sizeof(target));
  target.sin_family = AF_INET;
  target.sin_port = htons(443);
  if (inet_pton(AF_INET, "127.0.0.1", &target.sin_addr) != 1) {
    puts("pton=failed");
    return 1;
  }

  if (connect(fd, (const struct sockaddr *)&target, sizeof(target)) != 0) {
    puts("connect=failed");
    return 1;
  }

  struct sockaddr_in peer;
  socklen_t peer_len = sizeof(peer);
  memset(&peer, 0, sizeof(peer));
  if (getpeername(fd, (struct sockaddr *)&peer, &peer_len) != 0 ||
      peer_len != sizeof(peer) ||
      check_addr("peer", &peer, "127.0.0.1", 443) != 0) {
    return 1;
  }

  struct sockaddr_in local;
  socklen_t local_len = sizeof(local);
  memset(&local, 0, sizeof(local));
  if (getsockname(fd, (struct sockaddr *)&local, &local_len) != 0 ||
      local_len != sizeof(local) ||
      check_addr("local", &local, "10.0.2.15", 49152) != 0) {
    return 1;
  }

  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
    puts("fcntl=failed");
    return 1;
  }
  char byte = 0;
  errno = 0;
  if (recv(fd, &byte, 1, 0) != -1 || errno != EAGAIN) {
    printf("nonblock_recv=%d\n", errno);
    return 1;
  }

  close(fd);
  puts("socket-address=ok");
  return 0;
}
