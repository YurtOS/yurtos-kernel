/* asm/types.h — kernel integer types for wasm32/wasi.
 * Provides the __uN / __sN typedefs that linux kernel headers and BusyBox's
 * fix_u32.h expect.  The actual definitions in fix_u32.h will #undef and
 * re-typedef these after including us, which is fine. */

#ifndef _ASM_TYPES_H
#define _ASM_TYPES_H

#include <stdint.h>

typedef uint8_t  __u8;
typedef uint16_t __u16;
typedef uint32_t __u32;
typedef uint64_t __u64;
typedef int8_t   __s8;
typedef int16_t  __s16;
typedef int32_t  __s32;
typedef int64_t  __s64;

typedef uint16_t __le16;
typedef uint32_t __le32;
typedef uint64_t __le64;
typedef uint16_t __be16;
typedef uint32_t __be32;
typedef uint64_t __be64;

#endif /* _ASM_TYPES_H */
