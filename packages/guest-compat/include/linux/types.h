/* linux/types.h — kernel type aliases for wasm32/wasi.
 * Re-exports asm/types.h and adds the un-underscored aliases that some
 * BusyBox source files expect. */

#ifndef _LINUX_TYPES_H
#define _LINUX_TYPES_H

#include <asm/types.h>

/* Non-underscore aliases used by some headers. */
typedef __u8  u8;
typedef __u16 u16;
typedef __u32 u32;
typedef __u64 u64;
typedef __s8  s8;
typedef __s16 s16;
typedef __s32 s32;
typedef __s64 s64;

#endif /* _LINUX_TYPES_H */
