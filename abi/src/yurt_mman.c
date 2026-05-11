#include <errno.h>
#include <stddef.h>
#include <sys/mman.h>

#include "yurt_markers.h"

YURT_DECLARE_MARKER(posix_madvise);

YURT_DEFINE_MARKER(posix_madvise, 0x706d6164u) /* "pmad" */

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
