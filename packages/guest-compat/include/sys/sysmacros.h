/* sys/sysmacros.h — major/minor device number macros for wasm32/wasi. */

#ifndef _SYS_SYSMACROS_H
#define _SYS_SYSMACROS_H

#include <stdint.h>

#ifndef major
# define major(dev) ((unsigned int)(((dev) >> 8) & 0xfff))
#endif
#ifndef minor
# define minor(dev) ((unsigned int)(((dev) & 0xff) | (((dev) >> 12) & 0xfff00)))
#endif
#ifndef makedev
# define makedev(ma, mi) \
    ((((uint64_t)(ma) & 0xfff) << 8) | ((mi) & 0xff) | (((uint64_t)(mi) & 0xfff00) << 12))
#endif

#endif /* _SYS_SYSMACROS_H */
