/* Networking name-resolution stubs.
 *
 * wasi-libc has no <netdb.h>: gethostbyname/getaddrinfo all expect a
 * resolver, and yurt doesn't expose one to the guest (sandbox
 * networking goes through host_network_fetch, which speaks HTTP/HTTPS,
 * not DNS).
 *
 * The bodies below are the honest answer: every lookup fails with
 * HOST_NOT_FOUND.  Programs that gate behavior on this (BusyBox's
 * herror_msg, ping/wget/etc.) compile and link, and at runtime they
 * see "no DNS" and fall back / report the error cleanly. */

#include <netdb.h>
#include <stddef.h>
#include <string.h>

int h_errno = 1;  /* HOST_NOT_FOUND */

char *hstrerror(int err) {
    /* Returned strings are static literals; the non-const return type
     * matches glibc's historical signature (POSIX is stricter, but
     * BusyBox and friends compile against the glibc one). */
    switch (err) {
        case 1: return (char *)"Host not found";
        case 2: return (char *)"Try again";
        case 3: return (char *)"Non-recoverable error";
        case 4: return (char *)"No address";
        default: return (char *)"Unknown host error";
    }
}

struct hostent *gethostbyname(const char *name) {
    (void)name;
    h_errno = 1;  /* HOST_NOT_FOUND */
    return NULL;
}

struct netent *getnetbyname(const char *name) {
    (void)name;
    return NULL;
}

struct netent *getnetbyaddr(uint32_t net, int type) {
    (void)net; (void)type;
    return NULL;
}

struct servent *getservbyname(const char *name, const char *proto) {
    (void)name; (void)proto;
    return NULL;
}

struct servent *getservbyport(int port, const char *proto) {
    (void)port; (void)proto;
    return NULL;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    (void)node; (void)service; (void)hints;
    if (res) *res = NULL;
    return -2;  /* EAI_NONAME — node or service not known */
}

void freeaddrinfo(struct addrinfo *res) {
    (void)res;
}

const char *gai_strerror(int errcode) {
    switch (errcode) {
        case 0: return "Success";
        case -2: return "Name or service not known";
        default: return "Unknown getaddrinfo error";
    }
}

int getnameinfo(const struct sockaddr *addr, socklen_t addrlen,
                char *host, socklen_t hostlen,
                char *serv, socklen_t servlen, int flags) {
    (void)addr; (void)addrlen; (void)flags;
    /* Best-effort: write empty strings; the caller can detect "no name"
     * either by the empty result or by checking the return value. */
    if (host && hostlen > 0) host[0] = '\0';
    if (serv && servlen > 0) serv[0] = '\0';
    return -2;  /* EAI_NONAME */
}

/* yurt_netdb_host_for_addr — reverse lookup.
 * Returns NULL; the socket layer falls back to inet_ntop() for the raw IP. */
#include <stdint.h>
const char *yurt_netdb_host_for_addr(uint32_t addr_be) {
    (void)addr_be;
    return NULL;
}

/* yurt_netdb_addr_for_host — forward lookup via host_dns_resolve (JSPI async).
 * Returns the IPv4 address in network byte order, or 0 on failure. */
#include <arpa/inet.h>
#include "yurt_runtime.h"
uint32_t yurt_netdb_addr_for_host(const char *host) {
    if (!host || !*host) return 0;
    char buf[16]; /* "255.255.255.255\0" */
    int rc = yurt_host_dns_resolve(
        (int)(intptr_t)host, (int)__builtin_strlen(host),
        (int)(intptr_t)buf, (int)(sizeof(buf) - 1)
    );
    if (rc <= 0 || rc >= (int)sizeof(buf)) return 0;
    buf[rc] = '\0';
    struct in_addr a;
    if (inet_pton(AF_INET, buf, &a) != 1) return 0;
    return a.s_addr;
}

/* getlogin_r — POSIX: copy the login name into buf.  We don't track
 * a real login session; report the canonical sandbox identity ("user",
 * matching getuid()==1000 and /etc/passwd entry).  Returns 0 on
 * success, ERANGE when buf is too small. */
#include <errno.h>
int getlogin_r(char *buf, size_t bufsize) {
    static const char name[] = "user";
    if (!buf) return EINVAL;
    if (bufsize < sizeof(name)) return ERANGE;
    memcpy(buf, name, sizeof(name));
    return 0;
}
