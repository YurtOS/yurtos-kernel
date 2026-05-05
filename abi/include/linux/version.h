/* linux/version.h — kernel version stub for wasm32/wasi.
 * Reports as a recent 6.x kernel so version-checking code takes
 * modern code paths. */

#ifndef _LINUX_VERSION_H
#define _LINUX_VERSION_H

#define LINUX_VERSION_CODE 394240  /* 6.4.0 */
#define KERNEL_VERSION(a,b,c) (((a) << 16) + ((b) << 8) + (c))

#endif /* _LINUX_VERSION_H */
