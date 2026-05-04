/* dup(2) and dup3(2) — the yurt kernel manages every fd that
 * crosses a process boundary, so dup'ing them needs to go through
 * the host.  wasi-libc has neither (the WASI core spec doesn't have
 * dup; only `fd_renumber`, which is dup2's semantics).
 *
 * dup3 is a Linux extension that bundles dup2 with an O_CLOEXEC
 * flag.  Since yurt has no exec(), CLOEXEC is implicit and the
 * flag bit is harmless to ignore — we forward to dup2 unconditionally.
 */

#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

YURT_DECLARE_MARKER(dup);
YURT_DECLARE_MARKER(dup3);

YURT_DEFINE_MARKER(dup,  0x64757020u) /* "dup " */
YURT_DEFINE_MARKER(dup3, 0x64757033u) /* "dup3" */

int dup(int oldfd) {
  YURT_MARKER_CALL(dup);

  if (oldfd < 0) {
    errno = EBADF;
    return -1;
  }

  /* host_dup writes `{"fd":<n>}` JSON to our buffer; pull the int
   * out by hand to keep this hot path malloc-free. */
  char buf[32];
  int n = yurt_host_dup(oldfd, (int)(intptr_t)buf, (int)sizeof(buf));
  if (n <= 0 || (size_t)n > sizeof(buf)) {
    errno = EBADF;
    return -1;
  }

  /* Find `"fd":` followed by a non-negative integer. */
  static const char needle[] = "\"fd\":";
  size_t needle_len = sizeof(needle) - 1;
  for (size_t i = 0; i + needle_len <= (size_t)n; ++i) {
    if (memcmp(buf + i, needle, needle_len) != 0) continue;
    const char *p = buf + i + needle_len;
    const char *end = buf + n;
    int val = 0;
    int saw = 0;
    while (p < end && *p >= '0' && *p <= '9') {
      val = val * 10 + (*p - '0');
      saw = 1;
      ++p;
    }
    if (saw) return val;
    break;
  }
  errno = EBADF;
  return -1;
}

int dup3(int oldfd, int newfd, int flags) {
  YURT_MARKER_CALL(dup3);

  /* Linux dup3 differs from dup2 in two ways:
   *   1. It always closes newfd if it differs (dup2 already does this).
   *   2. It rejects the no-op case `oldfd == newfd` with EINVAL.
   *   3. It accepts an O_CLOEXEC bit; any other bit is EINVAL.
   * We honor (2) and (3); (1) is implicit in our dup2. */
  if (oldfd == newfd) {
    errno = EINVAL;
    return -1;
  }
  if ((flags & ~O_CLOEXEC) != 0) {
    errno = EINVAL;
    return -1;
  }
  /* O_CLOEXEC is a no-op in yurt (no exec()), so we drop the flag
   * and forward to dup2 — same renumber semantics. */
  return dup2(oldfd, newfd);
}
