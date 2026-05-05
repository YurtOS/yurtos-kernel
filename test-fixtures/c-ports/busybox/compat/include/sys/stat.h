#ifndef YURT_BUSYBOX_COMPAT_SYS_STAT_H
#define YURT_BUSYBOX_COMPAT_SYS_STAT_H

/* Pull in Yurt's ABI sys/stat.h shim. It owns the POSIX
 * compatibility declarations/stubs for this surface. */
#include_next <sys/stat.h>

#endif /* YURT_BUSYBOX_COMPAT_SYS_STAT_H */
