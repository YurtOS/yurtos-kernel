/* sys/un.h — Unix-domain socket address for wasm32/wasi.
 * wasi-libc's WASI-mode __struct_sockaddr_un.h provides only sun_family;
 * override the whole header to give callers the full sun_path field. */

#ifndef YURT_COMPAT_SYS_UN_H
#define YURT_COMPAT_SYS_UN_H

#include <sys/types.h>

#ifndef __wasilibc___struct_sockaddr_un_h
#define __wasilibc___struct_sockaddr_un_h
#endif

typedef unsigned short sa_family_t;

struct sockaddr_un {
    sa_family_t sun_family;
    char        sun_path[108];
};

#if defined(_GNU_SOURCE) || defined(_BSD_SOURCE)
#include <string.h>
#define SUN_LEN(s) (2 + strlen((s)->sun_path))
#endif

#endif /* YURT_COMPAT_SYS_UN_H */
