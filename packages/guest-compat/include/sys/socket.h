#ifndef YURT_COMPAT_SYS_SOCKET_H
#define YURT_COMPAT_SYS_SOCKET_H

#include_next <sys/socket.h>

#include <stddef.h>
#include <sys/types.h>

#undef SOL_SOCKET
#define SOL_SOCKET 0

#undef SO_REUSEADDR
#define SO_REUSEADDR 0x0004

#undef SO_KEEPALIVE
#define SO_KEEPALIVE 9

#undef SO_ERROR
#define SO_ERROR 0x1007

#ifndef MSG_PEEK
#define MSG_PEEK 0x02
#endif

#ifndef SOMAXCONN
#define SOMAXCONN 128
#endif

int socket(int domain, int type, int protocol);
int connect(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
int getpeername(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
int getsockname(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
int bind(int sockfd, const struct sockaddr *addr, socklen_t addrlen);
int listen(int sockfd, int backlog);
int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen);
ssize_t send(int sockfd, const void *buf, size_t len, int flags);
ssize_t recv(int sockfd, void *buf, size_t len, int flags);
ssize_t sendto(int sockfd, const void *buf, size_t len, int flags,
               const struct sockaddr *dest_addr, socklen_t addrlen);
ssize_t recvfrom(int sockfd, void *buf, size_t len, int flags,
                 struct sockaddr *src_addr, socklen_t *addrlen);
int setsockopt(int sockfd, int level, int optname, const void *optval, socklen_t optlen);
int getsockopt(int sockfd, int level, int optname, void *optval, socklen_t *optlen);
int shutdown(int sockfd, int how);

#endif
