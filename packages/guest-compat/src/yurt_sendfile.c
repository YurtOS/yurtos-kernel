#include "yurt_markers.h"

#include <errno.h>
#include <stddef.h>
#include <sys/sendfile.h>
#include <unistd.h>

YURT_DECLARE_MARKER(sendfile);
YURT_DEFINE_MARKER(sendfile, 0x73656e64u) /* "send" */

ssize_t sendfile(int out_fd, int in_fd, off_t *offset, size_t count) {
  YURT_MARKER_CALL(sendfile);

  if (count == 0) {
    return 0;
  }

  off_t original = 0;
  if (offset != NULL) {
    original = lseek(in_fd, 0, SEEK_CUR);
    if (original == (off_t)-1) {
      return -1;
    }
    if (lseek(in_fd, *offset, SEEK_SET) == (off_t)-1) {
      return -1;
    }
  }

  char buf[16384];
  size_t total = 0;
  while (total < count) {
    size_t want = count - total;
    if (want > sizeof(buf)) {
      want = sizeof(buf);
    }

    ssize_t nr = read(in_fd, buf, want);
    if (nr < 0) {
      if (total != 0) break;
      return -1;
    }
    if (nr == 0) {
      break;
    }

    ssize_t written_for_read = 0;
    while (written_for_read < nr) {
      ssize_t nw = write(out_fd, buf + written_for_read, (size_t)(nr - written_for_read));
      if (nw < 0) {
        if (total != 0 || written_for_read != 0) {
          total += (size_t)written_for_read;
          goto done;
        }
        return -1;
      }
      if (nw == 0) {
        errno = EIO;
        if (total != 0 || written_for_read != 0) {
          total += (size_t)written_for_read;
          goto done;
        }
        return -1;
      }
      written_for_read += nw;
    }
    total += (size_t)nr;
  }

done:
  if (offset != NULL) {
    off_t end = lseek(in_fd, 0, SEEK_CUR);
    if (end == (off_t)-1) {
      if (total == 0) return -1;
      *offset += (off_t)total;
    } else {
      *offset = end;
    }
    if (lseek(in_fd, original, SEEK_SET) == (off_t)-1 && total == 0) {
      return -1;
    }
  }

  return (ssize_t)total;
}
