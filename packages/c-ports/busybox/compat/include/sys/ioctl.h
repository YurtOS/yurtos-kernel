#ifndef YURT_BUSYBOX_COMPAT_SYS_IOCTL_H
#define YURT_BUSYBOX_COMPAT_SYS_IOCTL_H

/* Pull in the real wasi-sdk sys/ioctl.h. Without __wasilibc_unmodified_upstream,
 * it resolves to __header_sys_ioctl.h which provides the minimal ioctl wrapper. */
#include_next <sys/ioctl.h>

/* WASI's sys/ioctl.h (unmodified-upstream path) provides struct winsize and
 * TIOCGWINSZ, but only when __wasilibc_unmodified_upstream is defined.
 * For wasm32-wasip1 the minimal ioctl.h doesn't include them.
 * Define the minimum BusyBox needs (xfuncs.c queries the terminal size). */

#ifndef __DEFINED_struct_winsize
struct winsize {
    unsigned short ws_row;
    unsigned short ws_col;
    unsigned short ws_xpixel;
    unsigned short ws_ypixel;
};
#define __DEFINED_struct_winsize
#endif

#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
#endif

#endif /* YURT_BUSYBOX_COMPAT_SYS_IOCTL_H */
