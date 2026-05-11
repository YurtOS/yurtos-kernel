#ifndef YURT_COMPAT_NETINET_IN_H
#define YURT_COMPAT_NETINET_IN_H

#include <stdint.h>

/* wasi-sdk's struct in6_addr is a flat array with no union, so s6_addr32
 * is unavailable.  Override the definition with a union that matches what
 * BSD/Linux code expects.  Block the wasi-sdk __struct_in6_addr.h stub. */
#ifndef __wasilibc___struct_in6_addr_h
#define __wasilibc___struct_in6_addr_h
struct in6_addr {
    _Alignas(int32_t) union {
        uint8_t  __u6_addr8[16];
        uint16_t __u6_addr16[8];
        uint32_t __u6_addr32[4];
    } __u6_addr;
};
#define s6_addr   __u6_addr.__u6_addr8
#define s6_addr32 __u6_addr.__u6_addr32
#endif

#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <netinet/in.h>
#pragma pop_macro("__wasi__")

#ifndef SOL_IP
#define SOL_IP 0
#endif

#ifndef IP_BIND_ADDRESS_NO_PORT
#define IP_BIND_ADDRESS_NO_PORT 24
#endif

#endif
