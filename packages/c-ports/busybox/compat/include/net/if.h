#ifndef YURT_BUSYBOX_COMPAT_NET_IF_H
#define YURT_BUSYBOX_COMPAT_NET_IF_H

/* WASI / wasi-sdk has no net/if.h. Provide the minimal subset that
 * BusyBox's libbb/xconnect.c needs: IFNAMSIZ and struct ifreq. */

#include <sys/socket.h>

#define IFNAMSIZ 16

struct ifreq {
    char ifr_name[IFNAMSIZ];
    /* Other fields omitted; BusyBox only uses ifr_name on WASI builds. */
    union {
        struct sockaddr ifr_addr;
        int             ifr_ifindex;
        unsigned int    ifr_flags;
        int             ifr_metric;
        int             ifr_mtu;
    };
};

#endif /* YURT_BUSYBOX_COMPAT_NET_IF_H */
