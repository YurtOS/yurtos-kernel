/* sys/statfs.h — statfs shim for wasm32/wasi.
 * Maps struct statfs / statfs() / fstatfs() onto the POSIX statvfs API which
 * wasi-sdk provides.  Field names and positions are identical; this is safe
 * on wasm32 where both structs use the same ABI. */

#ifndef _SYS_STATFS_H
#define _SYS_STATFS_H

#include <sys/statvfs.h>

/* struct statfs is layout-compatible with struct statvfs on wasm32. */
#define statfs   statvfs
#define fstatfs  fstatvfs

/* BusyBox uses f_namelen instead of f_namemax in a few places. */
#define f_namelen f_namemax

#endif /* _SYS_STATFS_H */
