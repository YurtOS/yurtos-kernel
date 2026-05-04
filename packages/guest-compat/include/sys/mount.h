/* sys/mount.h — filesystem mount/umount stubs for wasm32/wasi.
 * Actual mount operations are not supported in the WASI sandbox. */

#ifndef YURT_COMPAT_SYS_MOUNT_H
#define YURT_COMPAT_SYS_MOUNT_H

#include <stdint.h>
#include <sys/ioctl.h>

/* Mount flags */
#ifndef MS_RDONLY
#define MS_RDONLY       1
#define MS_NOSUID       2
#define MS_NODEV        4
#define MS_NOEXEC       8
#define MS_SYNCHRONOUS  16
#define MS_REMOUNT      32
#define MS_MANDLOCK     64
#define MS_DIRSYNC      128
#define MS_NOATIME      1024
#define MS_NODIRATIME   2048
#define MS_BIND         4096
#define MS_MOVE         8192
#define MS_REC          16384
#define MS_SILENT       32768
#define MS_POSIXACL     (1 << 16)
#define MS_UNBINDABLE   (1 << 17)
#define MS_PRIVATE      (1 << 18)
#define MS_SLAVE        (1 << 19)
#define MS_SHARED       (1 << 20)
#define MS_RELATIME     (1 << 21)
#define MS_KERNMOUNT    (1 << 22)
#define MS_I_VERSION    (1 << 23)
#define MS_STRICTATIME  (1 << 24)
#define MS_LAZYTIME     (1 << 25)
#define MS_ACTIVE       (1 << 30)
#define MS_NOUSER       (1 << 31)
#endif

#ifndef MNT_FORCE
#define MNT_FORCE       1
#define MNT_DETACH      2
#define MNT_EXPIRE      4
#define UMOUNT_NOFOLLOW 8
#endif

/* Block device ioctls (also in linux/fs.h) */
#ifndef BLKGETSIZE64
#define BLKROSET     _IO(0x12, 93)
#define BLKROGET     _IO(0x12, 94)
#define BLKRRPART    _IO(0x12, 95)
#define BLKGETSIZE   _IO(0x12, 96)
#define BLKFLSBUF    _IO(0x12, 97)
#define BLKSSZGET    _IO(0x12, 104)
#define BLKPBSZGET   _IO(0x12, 123)
#define BLKBSZGET    _IOR(0x12, 112, size_t)
#define BLKGETSIZE64 _IOR(0x12, 114, uint64_t)
#endif

#include <errno.h>

static inline int mount(const char *source, const char *target,
                        const char *filesystemtype, unsigned long mountflags,
                        const void *data) {
    (void)source; (void)target; (void)filesystemtype;
    (void)mountflags; (void)data;
    errno = ENOSYS; return -1;
}

static inline int umount(const char *target) {
    (void)target; errno = ENOSYS; return -1;
}

static inline int umount2(const char *target, int flags) {
    (void)target; (void)flags; errno = ENOSYS; return -1;
}

#endif /* YURT_COMPAT_SYS_MOUNT_H */
