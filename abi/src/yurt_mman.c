#include <errno.h>
#include <stddef.h>
#include <sys/mman.h>

#include "yurt_markers.h"

YURT_DECLARE_MARKER(posix_madvise);
YURT_DECLARE_MARKER(mmap);
YURT_DECLARE_MARKER(munmap);
YURT_DECLARE_MARKER(mprotect);
YURT_DECLARE_MARKER(msync);
YURT_DECLARE_MARKER(madvise);

YURT_DEFINE_MARKER(posix_madvise, 0x706d6164u) /* "pmad" */
YURT_DEFINE_MARKER(mmap, 0x6d6d6170u)          /* "mmap" */
YURT_DEFINE_MARKER(munmap, 0x6d756e6du)        /* "munm" */
YURT_DEFINE_MARKER(mprotect, 0x6d70726fu)      /* "mpro" */
YURT_DEFINE_MARKER(msync, 0x6d73796eu)         /* "msyn" */
YURT_DEFINE_MARKER(madvise, 0x6d616476u)       /* "madv" */

__attribute__((visibility("default")))
void *mmap(void *addr, size_t len, int prot, int flags, int fd, off_t offset) {
  YURT_MARKER_CALL(mmap);
  (void)addr;
  (void)len;
  (void)prot;
  (void)flags;
  (void)fd;
  (void)offset;
  errno = ENOSYS;
  return MAP_FAILED;
}

__attribute__((visibility("default")))
int munmap(void *addr, size_t len) {
  YURT_MARKER_CALL(munmap);
  (void)addr;
  (void)len;
  errno = EINVAL;
  return -1;
}

__attribute__((visibility("default")))
int mprotect(void *addr, size_t len, int prot) {
  YURT_MARKER_CALL(mprotect);
  (void)addr;
  (void)len;
  (void)prot;
  errno = ENOSYS;
  return -1;
}

__attribute__((visibility("default")))
int msync(void *addr, size_t len, int flags) {
  YURT_MARKER_CALL(msync);
  (void)addr;
  (void)len;
  (void)flags;
  errno = ENOSYS;
  return -1;
}

__attribute__((visibility("default")))
int madvise(void *addr, size_t len, int advice) {
  YURT_MARKER_CALL(madvise);
  int rc = posix_madvise(addr, len, advice);
  if (rc != 0) {
    errno = rc;
    return -1;
  }
  return 0;
}

__attribute__((visibility("default")))
int posix_madvise(void *addr, size_t len, int advice) {
  YURT_MARKER_CALL(posix_madvise);
  (void)addr;
  (void)len;

  switch (advice) {
  case POSIX_MADV_NORMAL:
  case POSIX_MADV_RANDOM:
  case POSIX_MADV_SEQUENTIAL:
  case POSIX_MADV_WILLNEED:
  case POSIX_MADV_DONTNEED:
    return 0;
  default:
    return EINVAL;
  }
}
