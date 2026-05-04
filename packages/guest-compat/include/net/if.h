/* net/if.h — minimal network interface definitions for wasm32/wasi.
 * Provides struct ifreq, IFNAMSIZ, and the IF_* constants so libbb/
 * xconnect.c and similar files compile; actual interface operations
 * are not supported in the WASI sandbox. */

#ifndef _NET_IF_H
#define _NET_IF_H

#include <stdint.h>
#include <sys/socket.h>
#include <sys/types.h>

#define IFNAMSIZ  16
#define IF_NAMESIZE 16

struct if_nameindex {
    unsigned int if_index;
    char *if_name;
};

/* Minimal ifreq — only the fields BusyBox's xconnect.c actually uses. */
struct ifreq {
    union {
        char ifrn_name[IFNAMSIZ];
    } ifr_ifrn;
    union {
        struct sockaddr ifru_addr;
        struct sockaddr ifru_dstaddr;
        struct sockaddr ifru_broadaddr;
        struct sockaddr ifru_netmask;
        struct sockaddr ifru_hwaddr;
        short           ifru_flags;
        int             ifru_ifindex;
        int             ifru_metric;
        int             ifru_mtu;
        int             ifru_bandwidth;
        int             ifru_media;
        int             ifru_vnetid;
        uint64_t        ifru_oflags;
        int             ifru_data;
    } ifr_ifru;
};
#define ifr_name     ifr_ifrn.ifrn_name
#define ifr_addr     ifr_ifru.ifru_addr
#define ifr_hwaddr   ifr_ifru.ifru_hwaddr
#define ifr_flags    ifr_ifru.ifru_flags
#define ifr_ifindex  ifr_ifru.ifru_ifindex
#define ifr_mtu      ifr_ifru.ifru_mtu
#define ifr_metric   ifr_ifru.ifru_metric
#define ifr_netmask  ifr_ifru.ifru_netmask
#define ifr_broadaddr ifr_ifru.ifru_broadaddr
#define ifr_dstaddr  ifr_ifru.ifru_dstaddr

/* Commonly used ioctl request codes */
#define SIOCGIFINDEX  0x8933
#define SIOCGIFNAME   0x8910
#define SIOCGIFFLAGS  0x8913
#define SIOCSIFFLAGS  0x8914
#define SIOCGIFADDR   0x8915
#define SIOCSIFADDR   0x8916
#define SIOCGIFMTU    0x8921
#define SIOCSIFMTU    0x8922
#define SIOCGIFHWADDR 0x8927
#define SIOCSIFHWADDR 0x8924

/* Interface flags */
#define IFF_UP        0x1
#define IFF_BROADCAST 0x2
#define IFF_DEBUG     0x4
#define IFF_LOOPBACK  0x8
#define IFF_POINTOPOINT 0x10
#define IFF_RUNNING   0x40
#define IFF_NOARP     0x80
#define IFF_PROMISC   0x100
#define IFF_MULTICAST 0x1000

/* The sandbox exposes one deterministic loopback interface for lookup
 * compatibility. Real symbols live in libyurt_guest_compat.a so link probes
 * and yurt-check can verify precedence. */
unsigned int if_nametoindex(const char *ifname);
char *if_indextoname(unsigned int ifindex, char *ifname);

#endif /* _NET_IF_H */
