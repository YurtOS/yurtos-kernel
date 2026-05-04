#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
  const int port = 18081;
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  int client = -1;
  int accepted = -1;
  struct sockaddr_in addr;
  struct sockaddr_in peer;
  socklen_t peer_len = sizeof(peer);
  char buf[8] = {0};

  if (listener < 0) { puts("listener-socket=failed"); return 1; }
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (bind(listener, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    printf("bind=%d\n", errno);
    return 1;
  }
  if (listen(listener, 8) != 0) {
    printf("listen=%d\n", errno);
    return 1;
  }

  client = socket(AF_INET, SOCK_STREAM, 0);
  if (client < 0) { puts("client-socket=failed"); return 1; }
  if (connect(client, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    printf("connect=%d\n", errno);
    return 1;
  }
  if (send(client, "ping", 4, 0) != 4) {
    puts("client-send=failed");
    return 1;
  }

  accepted = accept(listener, (struct sockaddr *)&peer, &peer_len);
  if (accepted < 0) {
    printf("accept=%d\n", errno);
    return 1;
  }
  if (peer.sin_family != AF_INET || ntohs(peer.sin_port) == 0) {
    puts("peer=failed");
    return 1;
  }
  if (recv(accepted, buf, 4, 0) != 4 || memcmp(buf, "ping", 4) != 0) {
    puts("server-recv=failed");
    return 1;
  }
  if (send(accepted, "pong", 4, 0) != 4) {
    puts("server-send=failed");
    return 1;
  }
  memset(buf, 0, sizeof(buf));
  if (recv(client, buf, 4, 0) != 4 || memcmp(buf, "pong", 4) != 0) {
    puts("client-recv=failed");
    return 1;
  }

  close(accepted);
  close(client);
  close(listener);
  puts("socket-listen=ok");
  return 0;
}
