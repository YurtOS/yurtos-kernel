#ifndef YURT_BUSYBOX_COMPAT_SYS_UN_H
#define YURT_BUSYBOX_COMPAT_SYS_UN_H

/* Provide struct sockaddr_un with sun_path for BusyBox.
 *
 * wasi-sdk's __struct_sockaddr_un.h defines a minimal sockaddr_un without
 * sun_path (WASI has no UNIX-domain sockets). We intercept sys/un.h here
 * and provide the standard struct so that BusyBox's xconnect.c compiles.
 * We do NOT chain to the real sys/un.h to avoid struct redefinition errors.
 *
 * At runtime: any AF_UNIX socket operations return ENOSYS. */

#include <bits/alltypes.h>  /* sa_family_t */

/* Prevent the minimal WASI struct from being defined later */
#define __wasilibc___struct_sockaddr_un_h
#define __DEFINED_struct_sockaddr_un

struct sockaddr_un {
    sa_family_t sun_family;
    char sun_path[108];
};

#ifndef SUN_LEN
#include <string.h>
#define SUN_LEN(s) (sizeof(*(s)) - sizeof((s)->sun_path) + strlen((s)->sun_path))
#endif

#ifdef __cplusplus
extern "C" {
#endif
#ifdef __cplusplus
}
#endif

#endif /* YURT_BUSYBOX_COMPAT_SYS_UN_H */
