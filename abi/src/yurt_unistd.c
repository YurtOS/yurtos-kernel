#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <errno.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

#include "yurt_abi.h"

YURT_DECLARE_MARKER(dup2);
YURT_DECLARE_MARKER(getgroups);
YURT_DECLARE_MARKER(gethostname);

YURT_DEFINE_MARKER(dup2, 0x64703200u)      /* "dp2\0" */
YURT_DEFINE_MARKER(getgroups, 0x67677270u) /* "ggrp" */
YURT_DEFINE_MARKER(gethostname, 0x67686e6du) /* "ghnm" */

extern int __real_close(int fd);

int __wrap_close(int fd) {
  return __real_close(fd);
}

int dup2(int oldfd, int newfd) {
  YURT_MARKER_CALL(dup2);

  if (oldfd < 0 || newfd < 0) {
    errno = EINVAL;
    return -1;
  }

  if (oldfd == newfd) {
    return newfd;
  }

  if (yurt_host_dup2(oldfd, newfd) != 0) {
    errno = EBADF;
    return -1;
  }

  return newfd;
}

int getgroups(int size, gid_t list[]) {
  YURT_MARKER_CALL(getgroups);

  if (size < 0) {
    errno = EINVAL;
    return -1;
  }
  /* Sandbox is single-user: report exactly the primary group (1000),
   * matching getegid() / `id` output.  POSIX: size==0 means "tell me
   * how many entries", so we return the count without writing list. */
  if (size == 0) {
    return 1;
  }
  if (list == NULL) {
    errno = EINVAL;
    return -1;
  }

  list[0] = (gid_t) 1000;
  return 1;
}

int gethostname(char *name, size_t len) {
  YURT_MARKER_CALL(gethostname);
  static const char hostname[] = "yurt";

  if (name == NULL) {
    errno = EFAULT;
    return -1;
  }
  if (len < sizeof(hostname)) {
    errno = ENAMETOOLONG;
    return -1;
  }

  memcpy(name, hostname, sizeof(hostname));
  return 0;
}

/* uname(2) — wasi-libc's default identifies the system as "wasi",
 * which leaks an implementation detail and breaks any tooling that
 * keys off the kernel name to gate behavior.  Override it so the
 * sandbox introduces itself consistently as `yurt`, regardless
 * of which guest binary (Rust, BusyBox, Python, …) makes the call.
 *
 * Field meanings (POSIX <sys/utsname.h>):
 *   sysname  : kernel / OS family name
 *   nodename : the host's network hostname (matches gethostname)
 *   release  : kernel release version
 *   version  : kernel build version
 *   machine  : hardware/ABI identifier — we're wasm32-wasip1, so
 *              "wasm32" is the honest answer.
 *
 * `--whole-archive` link precedence ensures this override beats
 * wasi-libc's stub. */
int uname(struct utsname *buf) {
    if (!buf) { errno = EFAULT; return -1; }
    memset(buf, 0, sizeof(*buf));
    /* sizeof handles utsname's per-field length cap (typically 65).
     * The release/version strings come from yurt_abi.h so a
     * version bump there flows through to `uname -a` automatically. */
    strncpy(buf->sysname,  "yurt",                sizeof(buf->sysname)  - 1);
    strncpy(buf->nodename, "yurt",                sizeof(buf->nodename) - 1);
    strncpy(buf->release,  YURT_VERSION_STR,      sizeof(buf->release)  - 1);
    strncpy(buf->version,  "yurt-" YURT_VERSION_STR " (WASI sandbox)",
                                                     sizeof(buf->version)  - 1);
    strncpy(buf->machine,  "wasm32",                 sizeof(buf->machine)  - 1);
    return 0;
}
