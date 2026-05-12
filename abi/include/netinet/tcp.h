#ifndef YURT_COMPAT_NETINET_TCP_H
#define YURT_COMPAT_NETINET_TCP_H

#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <netinet/tcp.h>
#pragma pop_macro("__wasi__")

#ifndef IPPROTO_TCP
#define IPPROTO_TCP 6
#endif

#undef TCP_NODELAY
#define TCP_NODELAY 1

#endif
