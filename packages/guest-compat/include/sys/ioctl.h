/* sys/ioctl.h — ioctl request-code macros and common TIOC constants
 * for wasm32/wasi.  Yurt routes ioctl through the host; actual ioctl
 * behaviour is implemented per-request in kernel-imports.ts. */

#ifndef _SYS_IOCTL_H
#define _SYS_IOCTL_H

#include <stdint.h>

/* Linux ioctl encoding (arm/x86 direction-size-type-nr layout). */
#define _IOC_NRBITS   8
#define _IOC_TYPEBITS 8
#define _IOC_SIZEBITS 14
#define _IOC_DIRBITS  2

#define _IOC_NRMASK   ((1u << _IOC_NRBITS)  - 1u)
#define _IOC_TYPEMASK ((1u << _IOC_TYPEBITS) - 1u)
#define _IOC_SIZEMASK ((1u << _IOC_SIZEBITS) - 1u)
#define _IOC_DIRMASK  ((1u << _IOC_DIRBITS)  - 1u)

#define _IOC_NRSHIFT   0
#define _IOC_TYPESHIFT (_IOC_NRSHIFT   + _IOC_NRBITS)
#define _IOC_SIZESHIFT (_IOC_TYPESHIFT + _IOC_TYPEBITS)
#define _IOC_DIRSHIFT  (_IOC_SIZESHIFT + _IOC_SIZEBITS)

#define _IOC_NONE  0u
#define _IOC_WRITE 1u
#define _IOC_READ  2u

#define _IOC(dir, type, nr, size) \
    (((unsigned)(dir)  << _IOC_DIRSHIFT)  | \
     ((unsigned)(type) << _IOC_TYPESHIFT) | \
     ((unsigned)(nr)   << _IOC_NRSHIFT)   | \
     ((unsigned)(size) << _IOC_SIZESHIFT))

#define _IO(type, nr)         _IOC(_IOC_NONE,  (type), (nr), 0)
#define _IOR(type, nr, size)  _IOC(_IOC_READ,  (type), (nr), sizeof(size))
#define _IOW(type, nr, size)  _IOC(_IOC_WRITE, (type), (nr), sizeof(size))
#define _IOWR(type, nr, size) _IOC(_IOC_READ|_IOC_WRITE, (type), (nr), sizeof(size))

/* ioctl() itself — Yurt implements this as a host import in yurt_fs.c. */
int ioctl(int fd, unsigned long request, ...);

#endif /* _SYS_IOCTL_H */
