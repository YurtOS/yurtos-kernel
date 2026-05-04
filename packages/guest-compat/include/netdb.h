#ifndef YURT_COMPAT_NETDB_H
#define YURT_COMPAT_NETDB_H

/* wasi-libc has no <netdb.h>.  Yurt doesn't expose DNS to the
 * guest (sandbox networking goes through host_network_fetch, which
 * speaks HTTP/HTTPS, not DNS).  Declarations here; bodies live in
 * libyurt_guest_compat (yurt_netdb.c) and return "host not
 * found" cleanly so callers can degrade gracefully. */

#include <stddef.h>
#include <sys/socket.h>
#include <netinet/in.h>

struct hostent {
	char *h_name;
	char **h_aliases;
	int h_addrtype;
	int h_length;
	char **h_addr_list;
};

struct netent {
	char *n_name;
	char **n_aliases;
	int n_addrtype;
	uint32_t n_net;
};

struct servent {
	char *s_name;
	char **s_aliases;
	int s_port;
	char *s_proto;
};

struct addrinfo {
	int ai_flags;
	int ai_family;
	int ai_socktype;
	int ai_protocol;
	socklen_t ai_addrlen;
	struct sockaddr *ai_addr;
	char *ai_canonname;
	struct addrinfo *ai_next;
};

#ifndef AI_CANONNAME
#define AI_CANONNAME 0x0002
#endif

#ifndef AI_PASSIVE
#define AI_PASSIVE 0x0001
#endif

#ifndef AI_NUMERICHOST
#define AI_NUMERICHOST 0x0004
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

#ifndef NI_NUMERICSCOPE
#define NI_NUMERICSCOPE 0x0000
#endif

#ifndef NI_MAXHOST
#define NI_MAXHOST 1025
#endif

#ifndef NI_MAXSERV
#define NI_MAXSERV 32
#endif

#ifndef HOST_NOT_FOUND
#define HOST_NOT_FOUND 1
#endif

extern int h_errno;

struct hostent *gethostbyname(const char *name);
struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type);
struct netent *getnetbyname(const char *name);
struct netent *getnetbyaddr(uint32_t net, int type);
struct servent *getservbyname(const char *name, const char *proto);
struct servent *getservbyport(int port, const char *proto);
int getaddrinfo(const char *node, const char *service,
	const struct addrinfo *hints, struct addrinfo **res);
void freeaddrinfo(struct addrinfo *res);
const char *gai_strerror(int errcode);
int getnameinfo(const struct sockaddr *addr, socklen_t addrlen,
	char *host, socklen_t hostlen,
	char *serv, socklen_t servlen, int flags);
char *hstrerror(int err);

#endif
