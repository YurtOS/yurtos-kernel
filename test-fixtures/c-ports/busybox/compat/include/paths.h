#ifndef YURT_BUSYBOX_COMPAT_PATHS_H
#define YURT_BUSYBOX_COMPAT_PATHS_H

#if defined(__has_include_next)
#if __has_include_next(<paths.h>)
#include_next <paths.h>
#endif
#endif

#ifndef _PATH_DEV
#define _PATH_DEV "/dev/"
#endif

#ifndef _PATH_BSHELL
#define _PATH_BSHELL "/bin/sh"
#endif

#endif
