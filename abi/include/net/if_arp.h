/* net/if_arp.h — minimal ARP definitions for wasm32/wasi. */

#ifndef _NET_IF_ARP_H
#define _NET_IF_ARP_H

#include <stdint.h>
#include <sys/socket.h>
#include <net/if.h>

/* ARP protocol HARDWARE identifiers */
#define ARPHRD_NETROM   0
#define ARPHRD_ETHER    1
#define ARPHRD_EETHER   2
#define ARPHRD_AX25     3
#define ARPHRD_PRONET   4
#define ARPHRD_CHAOS    5
#define ARPHRD_IEEE802  6
#define ARPHRD_ARCNET   7
#define ARPHRD_APPLETLK 8
#define ARPHRD_DLCI     15
#define ARPHRD_ATM      19
#define ARPHRD_VOID     0xFFFF

/* ARP protocol opcodes */
#define ARPOP_REQUEST   1
#define ARPOP_REPLY     2
#define ARPOP_RREQUEST  3
#define ARPOP_RREPLY    4
#define ARPOP_InREQUEST 8
#define ARPOP_InREPLY   9
#define ARPOP_NAK       10

struct arpreq {
    struct sockaddr arp_pa;
    struct sockaddr arp_ha;
    int             arp_flags;
    struct sockaddr arp_netmask;
    char            arp_dev[IFNAMSIZ];
};

#define ATF_COM    0x02
#define ATF_PERM   0x04
#define ATF_PUBL   0x08
#define ATF_USETRAILERS 0x10
#define ATF_NETMASK 0x20
#define ATF_DONTPUB 0x40

#define SIOCGARP  0x8954
#define SIOCSARP  0x8955
#define SIOCDARP  0x8956

#endif /* _NET_IF_ARP_H */
