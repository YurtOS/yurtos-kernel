#ifndef YURT_COMPAT_NETINET_IN_H
#define YURT_COMPAT_NETINET_IN_H

#include_next <netinet/in.h>

#ifndef SOL_IP
#define SOL_IP 0
#endif

#ifndef IP_BIND_ADDRESS_NO_PORT
#define IP_BIND_ADDRESS_NO_PORT 24
#endif

#endif
