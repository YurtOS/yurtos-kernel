#ifndef YURT_COMPAT_POLL_H
#define YURT_COMPAT_POLL_H

#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <poll.h>
#pragma pop_macro("__wasi__")

/*
 * yurt owns the POSIX poll ABI across the guest/host boundary. Use the Linux
 * visible constants rather than wasi-libc's internal event bit values.
 */
#undef POLLERR
#undef POLLHUP
#undef POLLNVAL
#define POLLERR 0x0008
#define POLLHUP 0x0010
#define POLLNVAL 0x0020

#ifndef POLLPRI
#define POLLPRI 0x0002
#endif

#endif
