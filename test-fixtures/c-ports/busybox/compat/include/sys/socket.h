#ifndef YURT_BUSYBOX_COMPAT_SYS_SOCKET_H
#define YURT_BUSYBOX_COMPAT_SYS_SOCKET_H

/* Pull in the real wasi-sdk sys/socket.h. */
#include_next <sys/socket.h>

/* wasm32-wasip1 provides only a minimal socket API via __header_sys_socket.h.
 * The full BSD socket constants (SO_*, AF_*, PF_*) are in the
 * __wasilibc_unmodified_upstream guarded section and therefore absent for the
 * wasip1 target.  Declarations and implementations for the Yurt socket bridge
 * come from the ABI header/source pulled in above. */

#ifndef SO_DEBUG
/* Socket-level options */
#define SO_DEBUG        1
#define SO_REUSEADDR    2
#define SO_TYPE         3
#define SO_ERROR        4
#define SO_DONTROUTE    5
#define SO_BROADCAST    6
#define SO_SNDBUF       7
#define SO_RCVBUF       8
#define SO_KEEPALIVE    9
#define SO_OOBINLINE    10
#define SO_NO_CHECK     11
#define SO_PRIORITY     12
#define SO_LINGER       13
#define SO_BSDCOMPAT    14
#define SO_REUSEPORT    15
#define SO_PASSCRED     16
#define SO_PEERCRED     17
#define SO_RCVLOWAT     18
#define SO_SNDLOWAT     19
#define SO_RCVTIMEO_OLD 20
#define SO_SNDTIMEO_OLD 21
#endif /* SO_DEBUG */

/* Additional PF_/AF_ families not in __header_sys_socket.h */
#ifndef PF_LOCAL
#define PF_LOCAL        1
#define PF_UNIX         PF_LOCAL
#define PF_FILE         PF_LOCAL
#define PF_NETLINK      16
#define PF_ROUTE        PF_NETLINK
#define PF_PACKET       17
#define PF_MAX          46
#endif
#ifndef AF_UNIX
#define AF_UNIX         PF_UNIX
#define AF_LOCAL        PF_LOCAL
#define AF_NETLINK      PF_NETLINK
#define AF_PACKET       PF_PACKET
#define AF_MAX          PF_MAX
#endif

#endif /* YURT_BUSYBOX_COMPAT_SYS_SOCKET_H */
