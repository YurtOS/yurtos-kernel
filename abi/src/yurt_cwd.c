/* Process current-working-directory support.
 *
 * Keep these symbols in their own archive member. Autoconf probes often link
 * exactly one missing POSIX symbol from libyurt_abi.a; if getcwd/chdir live
 * beside broad filesystem overrides such as stat/chmod, those probes can
 * accidentally pull duplicate wasi-libc symbols into unrelated checks.
 */

#include "yurt_markers.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

YURT_DECLARE_MARKER(fchdir);
YURT_DECLARE_MARKER(chdir);
YURT_DECLARE_MARKER(getcwd);
YURT_DECLARE_MARKER(realpath);

YURT_DEFINE_MARKER(fchdir, 0x66636864u) /* "fchd" */
YURT_DEFINE_MARKER(chdir,  0x63686472u) /* "chdr" */
YURT_DEFINE_MARKER(getcwd, 0x67637764u) /* "gcwd" */
YURT_DEFINE_MARKER(realpath, 0x72706174u) /* "rpat" */

extern char *__wasilibc_cwd;

static char *yurt_cached_wasilibc_cwd;

/* The yurt kernel owns cwd. wasi-libc also keeps a private cwd pointer that
 * its path-resolution helpers consult before issuing WASI calls. Keep that
 * pointer as a best-effort cache of the kernel value; never use it as the
 * authoritative cwd and never let cache refresh define chdir/getcwd success. */
static void yurt_refresh_wasilibc_cwd_cache(void) {
  char cwd_buf[4096];
  int cwd_rc = yurt_host_getcwd((int)(intptr_t)cwd_buf, (int)sizeof(cwd_buf));
  if (cwd_rc <= 0 || (size_t)cwd_rc > sizeof(cwd_buf)) return;
  char *copy = strdup(cwd_buf);
  if (!copy) return;
  free(yurt_cached_wasilibc_cwd);
  yurt_cached_wasilibc_cwd = copy;
  __wasilibc_cwd = copy;
}

__attribute__((constructor))
static void yurt_sync_initial_cwd(void) {
  yurt_refresh_wasilibc_cwd_cache();
}

static int yurt_fchdir_impl(int fd) {
  YURT_MARKER_CALL(fchdir);
  int rc = yurt_host_fchdir(fd);
  if (rc == 0) {
    yurt_refresh_wasilibc_cwd_cache();
    return 0;
  }
  errno = (rc == -1) ? EBADF : (rc == -2) ? EACCES : (rc == -4) ? ENOTDIR : EIO;
  return -1;
}

int fchdir(int fd) {
  return yurt_fchdir_impl(fd);
}

int __wrap_fchdir(int fd) {
  return yurt_fchdir_impl(fd);
}

static int yurt_chdir_impl(const char *path) {
  YURT_MARKER_CALL(chdir);
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  int rc = yurt_host_chdir((int)(intptr_t)path, (int)strlen(path));
  if (rc == 0) {
    yurt_refresh_wasilibc_cwd_cache();
    return 0;
  }
  errno = (rc == -1) ? ENOENT : (rc == -2) ? EACCES : (rc == -4) ? ENOTDIR : EIO;
  return -1;
}

int chdir(const char *path) {
  return yurt_chdir_impl(path);
}

int __wrap_chdir(const char *path) {
  return yurt_chdir_impl(path);
}

static char *yurt_getcwd_impl(char *buf, size_t size) {
  YURT_MARKER_CALL(getcwd);
  if (buf && size == 0) {
    errno = EINVAL;
    return NULL;
  }
  if (!buf) {
    int required = yurt_host_getcwd(0, 0);
    if (required <= 0) {
      errno = EIO;
      return NULL;
    }
    size_t alloc_size = size == 0 ? (size_t)required : size;
    buf = (char *)malloc(alloc_size);
    if (!buf) {
      errno = ENOMEM;
      return NULL;
    }
    int rc = yurt_host_getcwd((int)(intptr_t)buf, (int)alloc_size);
    if (rc > 0 && (size_t)rc <= alloc_size) return buf;
    free(buf);
    errno = ERANGE;
    return NULL;
  }
  int rc = yurt_host_getcwd((int)(intptr_t)buf, (int)size);
  if (rc > 0 && (size_t)rc <= size) return buf;
  errno = ERANGE;
  return NULL;
}

char *getcwd(char *buf, size_t size) {
  return yurt_getcwd_impl(buf, size);
}

char *__wrap_getcwd(char *buf, size_t size) {
  return yurt_getcwd_impl(buf, size);
}

static char *yurt_realpath_impl(const char *restrict path, char *restrict resolved_path) {
  YURT_MARKER_CALL(realpath);
  if (!path) {
    errno = EINVAL;
    return NULL;
  }

  char stack_buf[PATH_MAX + 1];
  char *out = resolved_path ? resolved_path : stack_buf;
  size_t out_cap = resolved_path ? (PATH_MAX + 1) : sizeof(stack_buf);
  int rc = yurt_host_realpath((int)(intptr_t)path, (int)strlen(path),
                              (int)(intptr_t)out, (int)out_cap);
  if (rc <= 0) {
    errno = (rc == -1) ? ENOENT : (rc == -2) ? EACCES :
            (rc == -4) ? ENOTDIR : EIO;
    return NULL;
  }

  if ((size_t)rc > out_cap) {
    if (resolved_path) {
      errno = ENAMETOOLONG;
      return NULL;
    }
    out = (char *)malloc((size_t)rc);
    if (!out) {
      errno = ENOMEM;
      return NULL;
    }
    int retry = yurt_host_realpath((int)(intptr_t)path, (int)strlen(path),
                                   (int)(intptr_t)out, rc);
    if (retry <= 0 || retry > rc) {
      free(out);
      errno = (retry == -1) ? ENOENT : (retry == -2) ? EACCES :
              (retry == -4) ? ENOTDIR : EIO;
      return NULL;
    }
    return out;
  }

  if (resolved_path) return resolved_path;
  char *copy = strdup(out);
  if (!copy) {
    errno = ENOMEM;
    return NULL;
  }
  return copy;
}

char *realpath(const char *restrict path, char *restrict resolved_path) {
  return yurt_realpath_impl(path, resolved_path);
}

char *__wrap_realpath(const char *restrict path, char *restrict resolved_path) {
  return yurt_realpath_impl(path, resolved_path);
}
