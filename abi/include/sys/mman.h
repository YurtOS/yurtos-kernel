#ifndef YURT_COMPAT_SYS_MMAN_H
#define YURT_COMPAT_SYS_MMAN_H

#include_next <sys/mman.h>

#include <stddef.h>
#include <sys/types.h>

#ifndef PROT_NONE
#define PROT_NONE 0x0
#endif
#ifndef PROT_READ
#define PROT_READ 0x1
#endif
#ifndef PROT_WRITE
#define PROT_WRITE 0x2
#endif
#ifndef PROT_EXEC
#define PROT_EXEC 0x4
#endif

#ifndef MAP_SHARED
#define MAP_SHARED 0x0001
#endif
#ifndef MAP_PRIVATE
#define MAP_PRIVATE 0x0002
#endif
#ifndef MAP_FIXED
#define MAP_FIXED 0x0010
#endif
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS 0x0020
#endif
#ifndef MAP_ANON
#define MAP_ANON MAP_ANONYMOUS
#endif
#ifndef MAP_FAILED
#define MAP_FAILED ((void *)-1)
#endif

#ifndef MS_ASYNC
#define MS_ASYNC 0x0001
#endif
#ifndef MS_SYNC
#define MS_SYNC 0x0002
#endif
#ifndef MS_INVALIDATE
#define MS_INVALIDATE 0x0004
#endif

#ifdef __cplusplus
extern "C" {
#endif

void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t offset);
int munmap(void *addr, size_t len);
int mprotect(void *addr, size_t len, int prot);
int msync(void *addr, size_t len, int flags);
int madvise(void *addr, size_t len, int advice);

#ifdef __cplusplus
}
#endif

#endif
