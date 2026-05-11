#ifndef YURT_COMPAT_POLL_H
#define YURT_COMPAT_POLL_H

#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <poll.h>
#pragma pop_macro("__wasi__")

#ifndef POLLPRI
#define POLLPRI 0x0002
#endif

#endif
