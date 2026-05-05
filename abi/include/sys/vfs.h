/* sys/vfs.h — Linux statfs/fstatfs for wasm32/wasi.
 * Wraps wasi-sdk's statvfs to provide the Linux struct statfs interface. */

#ifndef YURT_COMPAT_SYS_VFS_H
#define YURT_COMPAT_SYS_VFS_H

#include <stdint.h>
#include <sys/types.h>
#include <sys/statvfs.h>
#include <string.h>
#include <errno.h>

typedef struct { int __val[2]; } __fsid_t;

struct statfs {
    long          f_type;
    long          f_bsize;
    uint64_t      f_blocks;
    uint64_t      f_bfree;
    uint64_t      f_bavail;
    uint64_t      f_files;
    uint64_t      f_ffree;
    __fsid_t      f_fsid;
    long          f_namelen;
    long          f_frsize;
    long          f_flags;
    long          f_spare[4];
};

/* statfs64 is an alias on 64-bit targets */
#define statfs64 statfs
#define fstatfs64 fstatfs

static inline int statfs(const char *path, struct statfs *buf) {
    struct statvfs sv;
    if (statvfs(path, &sv) != 0) return -1;
    memset(buf, 0, sizeof(*buf));
    buf->f_type    = 0x65735546; /* FUSE_SUPER_MAGIC — generic "virtual fs" */
    buf->f_bsize   = (long)sv.f_bsize;
    buf->f_blocks  = sv.f_blocks;
    buf->f_bfree   = sv.f_bfree;
    buf->f_bavail  = sv.f_bavail;
    buf->f_files   = sv.f_files;
    buf->f_ffree   = sv.f_ffree;
    buf->f_namelen = (long)sv.f_namemax;
    buf->f_frsize  = (long)sv.f_frsize;
    buf->f_flags   = (long)sv.f_flag;
    return 0;
}

static inline int fstatfs(int fd, struct statfs *buf) {
    struct statvfs sv;
    if (fstatvfs(fd, &sv) != 0) return -1;
    memset(buf, 0, sizeof(*buf));
    buf->f_type    = 0x65735546;
    buf->f_bsize   = (long)sv.f_bsize;
    buf->f_blocks  = sv.f_blocks;
    buf->f_bfree   = sv.f_bfree;
    buf->f_bavail  = sv.f_bavail;
    buf->f_files   = sv.f_files;
    buf->f_ffree   = sv.f_ffree;
    buf->f_namelen = (long)sv.f_namemax;
    buf->f_frsize  = (long)sv.f_frsize;
    buf->f_flags   = (long)sv.f_flag;
    return 0;
}

#endif /* YURT_COMPAT_SYS_VFS_H */
