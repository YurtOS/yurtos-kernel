/* IPv4 netdb compatibility.
 *
 * wasi-libc has no <netdb.h>. Yurt's socket backend already exposes a
 * host_dns_resolve import for hostname connects, so getaddrinfo() and
 * gethostbyname() can share that real backend for AF_INET lookups while
 * staying explicit about unsupported families and reverse DNS.
 */

#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

int h_errno = 1;  /* HOST_NOT_FOUND */

YURT_DECLARE_MARKER(getaddrinfo);
YURT_DECLARE_MARKER(freeaddrinfo);
YURT_DECLARE_MARKER(getnameinfo);
YURT_DECLARE_MARKER(gethostbyname);
YURT_DECLARE_MARKER(gethostbyaddr);

YURT_DEFINE_MARKER(getaddrinfo,   0x6761696eu) /* "gain" */
YURT_DEFINE_MARKER(freeaddrinfo,  0x66726169u) /* "frai" */
YURT_DEFINE_MARKER(getnameinfo,   0x676e616du) /* "gnam" */
YURT_DEFINE_MARKER(gethostbyname, 0x6768626eu) /* "ghbn" */
YURT_DEFINE_MARKER(gethostbyaddr, 0x67686261u) /* "ghba" */

#ifndef EAI_BADFLAGS
#define EAI_BADFLAGS -1
#endif
#ifndef EAI_NONAME
#define EAI_NONAME -2
#endif
#ifndef EAI_FAMILY
#define EAI_FAMILY -6
#endif
#ifndef EAI_SERVICE
#define EAI_SERVICE -8
#endif
#ifndef EAI_MEMORY
#define EAI_MEMORY -10
#endif
#ifndef EAI_SYSTEM
#define EAI_SYSTEM -11
#endif
#ifndef EAI_OVERFLOW
#define EAI_OVERFLOW -12
#endif

#ifndef NI_NUMERICHOST
#define NI_NUMERICHOST 0x0001
#endif
#ifndef NI_NUMERICSERV
#define NI_NUMERICSERV 0x0002
#endif
#ifndef NI_NAMEREQD
#define NI_NAMEREQD 0x0004
#endif

static int yurt_parse_service(const char *service, int socktype, int flags, uint16_t *port_out) {
    if (!service || !*service) {
        *port_out = 0;
        return 0;
    }

    char *end = NULL;
    unsigned long n = strtoul(service, &end, 10);
    if (end && *end == '\0') {
        if (n > 65535) return EAI_SERVICE;
        *port_out = (uint16_t)n;
        return 0;
    }

    if (flags & AI_NUMERICSERV) return EAI_SERVICE;
    if (socktype != 0 && socktype != SOCK_STREAM) return EAI_SERVICE;
    if (strcmp(service, "http") == 0) {
        *port_out = 80;
        return 0;
    }
    if (strcmp(service, "https") == 0) {
        *port_out = 443;
        return 0;
    }
    return EAI_SERVICE;
}

#define YURT_ADDRMAP_SIZE 32

static struct {
    uint32_t addr_be;
    char host[256];
} yurt_addrmap[YURT_ADDRMAP_SIZE];
static int yurt_addrmap_count = 0;
static int yurt_addrmap_cursor = 0;

static void yurt_addrmap_store(const char *host, uint32_t addr_be) {
    if (!host || !*host || addr_be == 0) return;
    struct in_addr numeric;
    if (inet_pton(AF_INET, host, &numeric) == 1) return;
    for (int i = 0; i < yurt_addrmap_count; i++) {
        if (yurt_addrmap[i].addr_be == addr_be &&
            strcmp(yurt_addrmap[i].host, host) == 0) {
            return;
        }
    }
    int slot;
    if (yurt_addrmap_count < YURT_ADDRMAP_SIZE) {
        slot = yurt_addrmap_count++;
    } else {
        slot = yurt_addrmap_cursor;
        yurt_addrmap_cursor = (yurt_addrmap_cursor + 1) % YURT_ADDRMAP_SIZE;
    }
    snprintf(yurt_addrmap[slot].host, sizeof(yurt_addrmap[slot].host), "%s", host);
    yurt_addrmap[slot].addr_be = addr_be;
}

static uint32_t yurt_addrmap_lookup_host(const char *host) {
    if (!host || !*host) return 0;
    for (int i = 0; i < yurt_addrmap_count; i++) {
        if (strcmp(yurt_addrmap[i].host, host) == 0) {
            return yurt_addrmap[i].addr_be;
        }
    }
    return 0;
}

static const char *yurt_addrmap_lookup_addr(uint32_t addr_be) {
    for (int i = 0; i < yurt_addrmap_count; i++) {
        if (yurt_addrmap[i].addr_be == addr_be) {
            return yurt_addrmap[i].host;
        }
    }
    return NULL;
}

static int yurt_resolve_ipv4(const char *node, int flags, uint32_t *addr_out) {
    if (!node || !*node) {
        *addr_out = htonl((flags & AI_PASSIVE) ? INADDR_ANY : INADDR_LOOPBACK);
        return 0;
    }

    struct in_addr parsed;
    if (inet_pton(AF_INET, node, &parsed) == 1) {
        *addr_out = parsed.s_addr;
        return 0;
    }
    if (strcmp(node, "localhost") == 0) {
        *addr_out = htonl(INADDR_LOOPBACK);
        return 0;
    }
    if (flags & AI_NUMERICHOST) {
        return EAI_NONAME;
    }

    uint32_t resolved = yurt_netdb_addr_for_host(node);
    if (resolved == 0) {
        return EAI_NONAME;
    }
    *addr_out = resolved;
    return 0;
}

static char *yurt_strdup(const char *s) {
    size_t n = strlen(s) + 1;
    char *out = malloc(n);
    if (out) memcpy(out, s, n);
    return out;
}

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
    YURT_MARKER_CALL(gethostbyname);
    static struct hostent ent;
    static char *aliases[] = { NULL };
    static char *addr_list[] = { NULL, NULL };
    static uint32_t addr;
    static char canon[256];

    uint32_t resolved = 0;
    int rc = yurt_resolve_ipv4(name, 0, &resolved);
    if (rc != 0) {
        h_errno = 1;  /* HOST_NOT_FOUND */
        return NULL;
    }

    addr = resolved;
    yurt_addrmap_store(name, addr);
    if (name && *name) {
        size_t n = strlen(name);
        if (n >= sizeof(canon)) n = sizeof(canon) - 1;
        memcpy(canon, name, n);
        canon[n] = '\0';
    } else {
        memcpy(canon, "localhost", sizeof("localhost"));
    }

    addr_list[0] = (char *)&addr;
    ent.h_name = canon;
    ent.h_aliases = aliases;
    ent.h_addrtype = AF_INET;
    ent.h_length = 4;
    ent.h_addr_list = addr_list;
    h_errno = 0;
    return &ent;
}

struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type) {
    YURT_MARKER_CALL(gethostbyaddr);
    static struct hostent ent;
    static char *aliases[] = { NULL };
    static char *addr_list[] = { NULL, NULL };
    static uint32_t stored_addr;
    static char name[INET_ADDRSTRLEN];

    if (!addr || len != 4 || type != AF_INET) {
        h_errno = 1;
        return NULL;
    }
    memcpy(&stored_addr, addr, sizeof(stored_addr));
    if (!inet_ntop(AF_INET, &stored_addr, name, sizeof(name))) {
        h_errno = 1;
        return NULL;
    }
    addr_list[0] = (char *)&stored_addr;
    ent.h_name = name;
    ent.h_aliases = aliases;
    ent.h_addrtype = AF_INET;
    ent.h_length = 4;
    ent.h_addr_list = addr_list;
    h_errno = 0;
    return &ent;
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
    YURT_MARKER_CALL(getaddrinfo);
    if (res) *res = NULL;
    if (!res) return EAI_SYSTEM;

    int family = hints ? hints->ai_family : AF_UNSPEC;
    int socktype = hints ? hints->ai_socktype : 0;
    int protocol = hints ? hints->ai_protocol : 0;
    int flags = hints ? hints->ai_flags : 0;

    if (flags & ~(AI_PASSIVE | AI_CANONNAME | AI_NUMERICHOST | AI_NUMERICSERV)) {
        return EAI_BADFLAGS;
    }
    if (family != AF_UNSPEC && family != AF_INET) {
        return EAI_FAMILY;
    }
    if (socktype != 0 && socktype != SOCK_STREAM && socktype != SOCK_DGRAM) {
        return EAI_SERVICE;
    }
    if (protocol != 0 && protocol != IPPROTO_TCP && protocol != IPPROTO_UDP) {
        return EAI_SERVICE;
    }
    if (socktype == SOCK_DGRAM && protocol == IPPROTO_TCP) return EAI_SERVICE;
    if (socktype == SOCK_STREAM && protocol == IPPROTO_UDP) return EAI_SERVICE;

    uint16_t port = 0;
    int rc = yurt_parse_service(service, socktype, flags, &port);
    if (rc != 0) return rc;

    uint32_t addr = 0;
    rc = yurt_resolve_ipv4(node, flags, &addr);
    if (rc != 0) return rc;
    if (node && *node) yurt_addrmap_store(node, addr);

    struct addrinfo *ai = calloc(1, sizeof(*ai));
    struct sockaddr_in *sa = calloc(1, sizeof(*sa));
    if (!ai || !sa) {
        free(ai);
        free(sa);
        return EAI_MEMORY;
    }

    sa->sin_family = AF_INET;
    sa->sin_port = htons(port);
    sa->sin_addr.s_addr = addr;

    ai->ai_family = AF_INET;
    ai->ai_socktype = socktype ? socktype : SOCK_STREAM;
    ai->ai_protocol = protocol ? protocol : (ai->ai_socktype == SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP);
    ai->ai_addrlen = sizeof(*sa);
    ai->ai_addr = (struct sockaddr *)sa;
    if ((flags & AI_CANONNAME) && node && *node) {
        ai->ai_canonname = yurt_strdup(node);
        if (!ai->ai_canonname) {
            freeaddrinfo(ai);
            return EAI_MEMORY;
        }
    }

    *res = ai;
    return 0;
}

void freeaddrinfo(struct addrinfo *res) {
    YURT_MARKER_CALL(freeaddrinfo);
    while (res) {
        struct addrinfo *next = res->ai_next;
        free(res->ai_addr);
        free(res->ai_canonname);
        free(res);
        res = next;
    }
}

const char *gai_strerror(int errcode) {
    switch (errcode) {
        case 0: return "Success";
        case EAI_BADFLAGS: return "Bad flags";
        case EAI_NONAME: return "Name or service not known";
        case EAI_FAMILY: return "Address family not supported";
        case EAI_SERVICE: return "Service not supported";
        case EAI_MEMORY: return "Memory allocation failure";
        case EAI_OVERFLOW: return "Result too large";
        default: return "Unknown getaddrinfo error";
    }
}

int getnameinfo(const struct sockaddr *addr, socklen_t addrlen,
                char *host, socklen_t hostlen,
                char *serv, socklen_t servlen, int flags) {
    YURT_MARKER_CALL(getnameinfo);
    if (!addr || addrlen < sizeof(struct sockaddr_in) || addr->sa_family != AF_INET) {
        return EAI_FAMILY;
    }

    const struct sockaddr_in *sa = (const struct sockaddr_in *)addr;
    if (host && hostlen > 0) {
        char tmp[INET_ADDRSTRLEN];
        const char *name = NULL;
        if (!(flags & NI_NUMERICHOST)) {
            name = yurt_addrmap_lookup_addr(sa->sin_addr.s_addr);
        }
        if (!name) {
            if (flags & NI_NAMEREQD) return EAI_NONAME;
            if (!inet_ntop(AF_INET, &sa->sin_addr, tmp, sizeof(tmp))) return EAI_SYSTEM;
            name = tmp;
        }
        size_t n = strlen(name) + 1;
        if (n > hostlen) return EAI_OVERFLOW;
        memcpy(host, name, n);
    }
    if (serv && servlen > 0) {
        char tmp[16];
        int n = snprintf(tmp, sizeof(tmp), "%u", (unsigned)ntohs(sa->sin_port));
        if (n < 0) return EAI_SYSTEM;
        if ((size_t)n + 1 > servlen) return EAI_OVERFLOW;
        memcpy(serv, tmp, (size_t)n + 1);
    }
    return 0;
}

/* yurt_netdb_host_for_addr — reverse lookup.
 * Returns a prior hostname when getaddrinfo/gethostbyname resolved this
 * address; the socket layer falls back to inet_ntop() for unmapped raw IPs. */
#include <stdint.h>
const char *yurt_netdb_host_for_addr(uint32_t addr_be) {
    return yurt_addrmap_lookup_addr(addr_be);
}

/* yurt_netdb_addr_for_host — forward lookup via host_dns_resolve (JSPI async).
 * Returns the IPv4 address in network byte order, or 0 on failure. */
uint32_t yurt_netdb_addr_for_host(const char *host) {
    if (!host || !*host) return 0;
    if (strcmp(host, "localhost") == 0) {
        uint32_t loopback = htonl(INADDR_LOOPBACK);
        yurt_addrmap_store(host, loopback);
        return loopback;
    }
    uint32_t cached = yurt_addrmap_lookup_host(host);
    if (cached != 0) return cached;
    char buf[16]; /* "255.255.255.255\0" */
    int rc = yurt_host_dns_resolve(
        (int)(intptr_t)host, (int)__builtin_strlen(host),
        (int)(intptr_t)buf, (int)(sizeof(buf) - 1)
    );
    if (rc <= 0 || rc >= (int)sizeof(buf)) return 0;
    buf[rc] = '\0';
    struct in_addr a;
    if (inet_pton(AF_INET, buf, &a) != 1) return 0;
    yurt_addrmap_store(host, a.s_addr);
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
