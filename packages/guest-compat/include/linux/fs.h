/* linux/fs.h — block device and filesystem ioctl constants for wasm32/wasi.
 * Provides common BLK/FI ioctl codes so util-linux applets compile;
 * actual block device operations are not supported in the WASI sandbox. */

#ifndef _LINUX_FS_H
#define _LINUX_FS_H

#include <stdint.h>
#include <sys/ioctl.h>
#include <linux/types.h>

/* Block device ioctls */
#define BLKROSET     _IO(0x12, 93)
#define BLKROGET     _IO(0x12, 94)
#define BLKRRPART    _IO(0x12, 95)
#define BLKGETSIZE   _IO(0x12, 96)
#define BLKFLSBUF    _IO(0x12, 97)
#define BLKRASET     _IO(0x12, 98)
#define BLKRAGET     _IO(0x12, 99)
#define BLKFRASET    _IO(0x12, 100)
#define BLKFRAGET    _IO(0x12, 101)
#define BLKSSZGET    _IO(0x12, 104)
#define BLKPBSZGET   _IO(0x12, 123)
#define BLKBSZGET    _IOR(0x12, 112, size_t)
#define BLKBSZSET    _IOW(0x12, 113, size_t)
#define BLKGETSIZE64 _IOR(0x12, 114, uint64_t)
#define BLKDISCARD   _IO(0x12, 119)
#define BLKIOMIN     _IO(0x12, 120)
#define BLKIOOPT     _IO(0x12, 121)
#define BLKALIGNOFF  _IO(0x12, 122)
#define BLKSECDISCARD _IO(0x12, 125)
#define BLKZEROOUT   _IO(0x12, 127)

/* Filesystem freeze/thaw */
#define FIFREEZE     _IOWR('X', 119, int)
#define FITHAW       _IOWR('X', 120, int)

/* Filesystem trim */
struct fstrim_range {
    uint64_t start;
    uint64_t len;
    uint64_t minlen;
};
#define FITRIM       _IOWR('X', 121, struct fstrim_range)

/* Mount flags (also in sys/mount.h) */
#ifndef MS_RDONLY
#define MS_RDONLY    1
#define MS_NOSUID    2
#define MS_NODEV     4
#define MS_NOEXEC    8
#define MS_SYNCHRONOUS 16
#define MS_REMOUNT   32
#define MS_MANDLOCK  64
#define MS_DIRSYNC   128
#define MS_NOATIME   1024
#define MS_NODIRATIME 2048
#define MS_BIND      4096
#define MS_MOVE      8192
#define MS_REC       16384
#define MS_SILENT    32768
#define MS_RELATIME  (1 << 21)
#define MS_STRICTATIME (1 << 24)
#define MS_LAZYTIME  (1 << 25)
#endif

#ifndef MNT_FORCE
#define MNT_FORCE    1
#define MNT_DETACH   2
#define MNT_EXPIRE   4
#define UMOUNT_NOFOLLOW 8
#endif

#endif /* _LINUX_FS_H */
