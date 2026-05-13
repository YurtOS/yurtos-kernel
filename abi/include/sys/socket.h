#ifndef YURT_COMPAT_SYS_SOCKET_H
#define YURT_COMPAT_SYS_SOCKET_H

#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <sys/socket.h>
#pragma pop_macro("__wasi__")

#include <stddef.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* SO_* constants that wasi-sdk defines in upstream mode but may not expose
 * via the WASI-mode path. */
#ifndef SO_BROADCAST
#define SO_BROADCAST 6
#endif
#ifndef SO_SNDBUF
#define SO_SNDBUF    7
#endif
#ifndef SO_RCVBUF
#define SO_RCVBUF    8
#endif
#ifndef SO_LINGER
#define SO_LINGER    13
#endif
#ifndef SO_RCVTIMEO
#define SO_RCVTIMEO  20
#endif
#ifndef SO_SNDTIMEO
#define SO_SNDTIMEO  21
#endif
#ifndef SO_BINDTODEVICE
#define SO_BINDTODEVICE 25
#endif

/* MSG_* flags — some may be missing from the WASI-mode socket path. */
#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0x40
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0x4000
#endif
#ifndef MSG_MORE
#define MSG_MORE     0x8000
#endif
#ifndef MSG_CMSG_CLOEXEC
#define MSG_CMSG_CLOEXEC 0x40000000
#endif

#undef SOL_SOCKET
#define SOL_SOCKET 0

#undef SO_REUSEADDR
#define SO_REUSEADDR 0x0004

#undef SO_KEEPALIVE
#define SO_KEEPALIVE 9

#undef SO_ERROR
#define SO_ERROR 0x1007

/* Socket types and address families — defined by wasi-sdk's
 * __header_sys_socket.h (pulled in via #include_next above).
 * WASI values differ from Linux; do NOT add #ifndef fallbacks here:
 *
 *   WASI  SOCK_STREAM = 6   AF_UNIX = 3
 *   WASI  SOCK_DGRAM  = 5   AF_INET = 1
 *   Linux SOCK_STREAM = 1   AF_UNIX = 1
 *   Linux SOCK_DGRAM  = 2   AF_INET = 2
 *
 * Adding #ifndef guards with the Linux values would silently break
 * if the include_next chain ever changed, producing guest↔kernel
 * constant mismatches that are very hard to debug. */

#ifndef SOCK_RAW
#define SOCK_RAW       3
#endif
#ifndef SOCK_RDM
#define SOCK_RDM       4
#endif
#ifndef SOCK_SEQPACKET
#define SOCK_SEQPACKET 5
#endif

/* PF_UNIX — alias for AF_UNIX; wasi-sdk may not expose it. */
#ifndef PF_UNIX
#define PF_UNIX AF_UNIX
#endif

#ifndef MSG_PEEK
#define MSG_PEEK 0x02
#endif

#ifndef SOMAXCONN
#define SOMAXCONN 128
#endif

/* SCM_RIGHTS — ancillary message type for fd passing. */
#ifndef SCM_RIGHTS
#define SCM_RIGHTS 1
#endif

/* MSG_CTRUNC — control data was truncated. */
#ifndef MSG_CTRUNC
#define MSG_CTRUNC 0x08
#endif

/* MSG_TRUNC — data was truncated. */
#ifndef MSG_TRUNC
#define MSG_TRUNC 0x20
#endif

/* SO_PEERCRED — get peer credentials. */
#ifndef SO_PEERCRED
#define SO_PEERCRED 17
#endif

/* SO_TYPE — get socket type. */
#ifndef SO_TYPE
#define SO_TYPE 3
#endif

/* struct ucred — peer credentials returned by SO_PEERCRED.
 * With -D__linux__ (e.g. BusyBox), the WASI sysroot exposes a full struct
 * ucred via #include_next above; without it the sysroot gives only a forward
 * declaration, so we complete the type here. */
#ifndef __linux__
#ifndef _HAVE_STRUCT_UCRED
#define _HAVE_STRUCT_UCRED
struct ucred {
    pid_t pid;
    uid_t uid;
    gid_t gid;
};
#endif
#endif

/* struct cmsghdr and CMSG_* macros — wasi-libc's __struct_msghdr.h only
 * defines struct msghdr, not struct cmsghdr.  Provide them unconditionally
 * so libbb/udp_io.c and similar files compile. */
#ifndef _HAVE_STRUCT_CMSGHDR
#define _HAVE_STRUCT_CMSGHDR
struct cmsghdr {
    socklen_t cmsg_len;
    int       cmsg_level;
    int       cmsg_type;
};

#define CMSG_ALIGN(len) (((len) + sizeof(size_t) - 1) & ~(sizeof(size_t) - 1))
#define CMSG_SPACE(len) (CMSG_ALIGN(sizeof(struct cmsghdr)) + CMSG_ALIGN(len))
#define CMSG_LEN(len)   (CMSG_ALIGN(sizeof(struct cmsghdr)) + (len))
#define CMSG_DATA(cmsg) ((unsigned char *)((struct cmsghdr *)(cmsg) + 1))
#define CMSG_FIRSTHDR(mhdr) \
    ((size_t)(mhdr)->msg_controllen >= sizeof(struct cmsghdr) \
     ? (struct cmsghdr *)(mhdr)->msg_control : (struct cmsghdr *)0)
#define CMSG_NXTHDR(mhdr, cmsg) \
    (((unsigned char *)(cmsg) + CMSG_ALIGN((cmsg)->cmsg_len) + sizeof(struct cmsghdr) \
      > (unsigned char *)(mhdr)->msg_control + (mhdr)->msg_controllen) \
     ? (struct cmsghdr *)0 \
     : (struct cmsghdr *)((unsigned char *)(cmsg) + CMSG_ALIGN((cmsg)->cmsg_len)))
#endif /* _HAVE_STRUCT_CMSGHDR */

/* sendmsg/recvmsg — gated behind __wasilibc_unmodified_upstream in wasi-sdk;
 * expose them unconditionally so BusyBox compiles. */
ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags);
ssize_t recvmsg(int sockfd, struct msghdr *msg, int flags);

int socket(int domain, int type, int protocol);
/* socketpair: AF_UNIX domain socket pair. Backed by the in-kernel
 * UnixSocketRegistry; supports SOCK_STREAM. */
int socketpair(int domain, int type, int protocol, int sv[2]);
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

#ifdef __cplusplus
}
#endif

#endif
