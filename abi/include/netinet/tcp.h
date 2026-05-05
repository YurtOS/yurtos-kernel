#ifndef YURT_COMPAT_NETINET_TCP_H
#define YURT_COMPAT_NETINET_TCP_H

#include_next <netinet/tcp.h>

#ifndef IPPROTO_TCP
#define IPPROTO_TCP 6
#endif

#undef TCP_NODELAY
#define TCP_NODELAY 1

#endif
