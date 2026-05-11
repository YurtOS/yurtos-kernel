/* mktemp / mkstemp / mkostemp / mkdtemp / tmpfile — real symbols.
 *
 * wasi-libc has these gated behind __wasilibc_unmodified_upstream
 * (i.e. absent from wasm32-wasip1).  Previously we provided header-
 * inline implementations, but gnulib in the GNU coreutils tree
 * builds its own lib/mkstemp.c / lib/mkostemp.c replacements and
 * the inline copy collided with them at compile time.  Real symbols
 * here mean gnulib's autoconf detects them at link probe time and
 * skips compiling its own — eliminating the redefinition.
 *
 * Implementation: replace the trailing XXXXXX of the template with
 * crypto-quality random alphanumerics (via getentropy → WASI
 * random_get → host crypto.getRandomValues), then attempt to
 * create the file/directory via O_CREAT|O_EXCL or mkdir.  Retry
 * up to 64 times on EEXIST.
 */

#include "yurt_markers.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

YURT_DECLARE_MARKER(mktemp);
YURT_DECLARE_MARKER(mkstemp);
YURT_DECLARE_MARKER(mkostemp);
YURT_DECLARE_MARKER(mkdtemp);
YURT_DECLARE_MARKER(tmpfile);
YURT_DEFINE_MARKER(mktemp,   0x6d6b7470u) /* "mktp" */
YURT_DEFINE_MARKER(mkstemp,  0x6d6b7374u) /* "mkst" */
YURT_DEFINE_MARKER(mkostemp, 0x6d6b6f73u) /* "mkos" */
YURT_DEFINE_MARKER(mkdtemp,  0x6d6b6474u) /* "mkdt" */
YURT_DEFINE_MARKER(tmpfile,  0x746d7066u) /* "tmpf" */

extern int getentropy(void *buffer, size_t length);

static char *mktemp_internal(char *tmpl) {
  static const char chars[] =
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789";
  if (!tmpl) { errno = EINVAL; return NULL; }
  size_t n = strlen(tmpl);
  if (n < 6 || strcmp(tmpl + n - 6, "XXXXXX") != 0) {
    errno = EINVAL;
    if (n) tmpl[0] = '\0';
    return tmpl;
  }
  unsigned char raw[6];
  if (getentropy(raw, sizeof raw) != 0) {
    if (n) tmpl[0] = '\0';
    return tmpl;
  }
  for (int i = 0; i < 6; i++) {
    tmpl[n - 6 + i] = chars[raw[i] % 62];
  }
  return tmpl;
}

char *mktemp(char *tmpl) {
  YURT_MARKER_CALL(mktemp);
  return mktemp_internal(tmpl);
}

int mkstemp(char *tmpl) {
  YURT_MARKER_CALL(mkstemp);
  for (int attempt = 0; attempt < 64; attempt++) {
    size_t n = strlen(tmpl);
    if (n < 6) { errno = EINVAL; return -1; }
    char saved[7];
    memcpy(saved, tmpl + n - 6, 7);
    if (mktemp_internal(tmpl) == NULL || tmpl[0] == '\0') return -1;
    int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) return fd;
    if (errno != EEXIST) return -1;
    memcpy(tmpl + n - 6, saved, 7);
  }
  errno = EEXIST;
  return -1;
}

int mkostemp(char *tmpl, int flags) {
  YURT_MARKER_CALL(mkostemp);
  for (int attempt = 0; attempt < 64; attempt++) {
    size_t n = strlen(tmpl);
    if (n < 6) { errno = EINVAL; return -1; }
    char saved[7];
    memcpy(saved, tmpl + n - 6, 7);
    if (mktemp_internal(tmpl) == NULL || tmpl[0] == '\0') return -1;
    int fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL | flags, 0600);
    if (fd >= 0) return fd;
    if (errno != EEXIST) return -1;
    memcpy(tmpl + n - 6, saved, 7);
  }
  errno = EEXIST;
  return -1;
}

char *mkdtemp(char *tmpl) {
  YURT_MARKER_CALL(mkdtemp);
  for (int attempt = 0; attempt < 64; attempt++) {
    size_t n = strlen(tmpl);
    if (n < 6) { errno = EINVAL; return NULL; }
    char saved[7];
    memcpy(saved, tmpl + n - 6, 7);
    if (mktemp_internal(tmpl) == NULL || tmpl[0] == '\0') return NULL;
    if (mkdir(tmpl, 0700) == 0) return tmpl;
    if (errno != EEXIST) return NULL;
    memcpy(tmpl + n - 6, saved, 7);
  }
  errno = EEXIST;
  return NULL;
}

FILE *tmpfile(void) {
  YURT_MARKER_CALL(tmpfile);
  /* Yurt's guest ramfs provides /tmp. If that changes, this should follow
   * P_tmpdir or TMPDIR before falling back to the POSIX default. */
  char tmpl[] = "/tmp/yurt-tmpfile-XXXXXX";
  int fd = mkstemp(tmpl);
  if (fd < 0) {
    return NULL;
  }
  if (unlink(tmpl) != 0) {
    int saved_errno = errno;
    close(fd);
    errno = saved_errno;
    return NULL;
  }
  FILE *f = fdopen(fd, "w+b");
  if (!f) {
    int saved_errno = errno;
    close(fd);
    errno = saved_errno;
    return NULL;
  }
  return f;
}
