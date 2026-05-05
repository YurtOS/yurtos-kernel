#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    perror("socket");
    return 1;
  }

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(8080);
  addr.sin_addr.s_addr = htonl(INADDR_ANY);

  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    perror("bind");
    close(fd);
    return 1;
  }

  if (listen(fd, 1) == 0) {
    fprintf(stderr, "listen unexpectedly allowed\n");
    close(fd);
    return 1;
  }

  if (errno != EOPNOTSUPP && errno != EACCES && errno != EPERM) {
    fprintf(stderr, "unexpected errno: %d\n", errno);
    close(fd);
    return 1;
  }

  close(fd);
  puts("listen-denied=ok");
  return 0;
}
