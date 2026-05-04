/* Filesystem-ownership and process-priority shims that wasi-libc
 * doesn't ship.  These are real symbols (not static inline) so
 * gnulib's REPLACE_* probes detect them at link time and skip
 * compiling its own replacement copies — which would otherwise
 * collide with our compat headers' inline versions.
 *
 * Sandbox semantics: file ownership mutators route through the
 * host/kernel authorization boundary; process priorities still
 * accept-and-no-op because yurt does not schedule by priority.
 */

#include "yurt_markers.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <unistd.h>

YURT_DECLARE_MARKER(chown);
YURT_DECLARE_MARKER(lchown);
YURT_DECLARE_MARKER(fchown);
YURT_DECLARE_MARKER(fchdir);
YURT_DECLARE_MARKER(chroot);
YURT_DECLARE_MARKER(chmod);
YURT_DECLARE_MARKER(getpriority);
YURT_DECLARE_MARKER(setpriority);

YURT_DEFINE_MARKER(chown,       0x63686f77u) /* "chow" */
YURT_DEFINE_MARKER(lchown,      0x6c63686fu) /* "lcho" */
YURT_DEFINE_MARKER(fchown,      0x6663686fu) /* "fcho" */
YURT_DEFINE_MARKER(fchdir,      0x66636864u) /* "fchd" */
YURT_DEFINE_MARKER(chroot,      0x6368726fu) /* "chro" */
YURT_DEFINE_MARKER(chmod,       0x63686d6fu) /* "chmo" */
YURT_DEFINE_MARKER(getpriority, 0x67707269u) /* "gpri" */
YURT_DEFINE_MARKER(setpriority, 0x73707269u) /* "spri" */
/* getrusage is provided by libwasi-emulated-process-clocks; we used
 * to define it here too but that produces a duplicate-symbol link
 * error.  The wasi-emulated impl zero-fills the rusage struct,
 * which is what we want anyway. */

int chown(const char *path, uid_t owner, gid_t group) {
  YURT_MARKER_CALL(chown);
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  int rc = yurt_host_chown((int)(intptr_t)path, (int)strlen(path), (int)owner, (int)group, 1);
  if (rc == 0) return 0;
  errno = (rc == -1) ? ENOENT : (rc == -2) ? EPERM : EIO;
  return -1;
}

int lchown(const char *path, uid_t owner, gid_t group) {
  YURT_MARKER_CALL(lchown);
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  int rc = yurt_host_chown((int)(intptr_t)path, (int)strlen(path), (int)owner, (int)group, 0);
  if (rc == 0) return 0;
  errno = (rc == -1) ? ENOENT : (rc == -2) ? EPERM : EIO;
  return -1;
}

int fchown(int fd, uid_t owner, gid_t group) {
  YURT_MARKER_CALL(fchown);
  int rc = yurt_host_fchown(fd, (int)owner, (int)group);
  if (rc == 0) return 0;
  errno = (rc == -1) ? EBADF : (rc == -2) ? EPERM : EIO;
  return -1;
}

int fchdir(int fd) {
  YURT_MARKER_CALL(fchdir);
  int rc = yurt_host_fchdir(fd);
  if (rc == 0) return 0;
  errno = (rc == -1) ? EBADF : (rc == -2) ? EACCES : (rc == -4) ? ENOTDIR : EIO;
  return -1;
}

int chroot(const char *path) {
  YURT_MARKER_CALL(chroot);
  (void)path;
  errno = ENOSYS;
  return -1;
}

int chmod(const char *path, mode_t mode) {
  YURT_MARKER_CALL(chmod);
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  int rc = yurt_host_chmod((int)(intptr_t)path, (int)strlen(path), (int)mode);
  if (rc == 0) return 0;
  errno = (rc == -1) ? ENOENT : (rc == -2) ? EPERM : EIO;
  return -1;
}

int chdir(const char *path) {
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  int rc = yurt_host_chdir((int)(intptr_t)path, (int)strlen(path));
  if (rc == 0) return 0;
  errno = (rc == -1) ? ENOENT : (rc == -2) ? EACCES : (rc == -4) ? ENOTDIR : EIO;
  return -1;
}

char *getcwd(char *buf, size_t size) {
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

int getpriority(int which, id_t who) {
  YURT_MARKER_CALL(getpriority);
  (void)which; (void)who;
  return 0;
}

int setpriority(int which, id_t who, int prio) {
  YURT_MARKER_CALL(setpriority);
  (void)which; (void)who; (void)prio;
  return 0;
}

int nice(int inc) {
  errno = 0;
  int cur = getpriority(PRIO_PROCESS, 0);
  if (errno != 0) return -1;
  if (setpriority(PRIO_PROCESS, 0, cur + inc) != 0) return -1;
  return getpriority(PRIO_PROCESS, 0);
}

/* getrusage: see comment above — libwasi-emulated-process-clocks
 * supplies it; defining ours would duplicate the symbol. */

/* ── Single-thread stdio locking ──
 * flockfile/funlockfile/ftrylockfile are POSIX file-locking
 * primitives for thread-safe stdio.  Yurt is single-threaded,
 * so they're no-ops.  wasi-libc doesn't ship them; gnulib will
 * compile its own getopt.c with `flockfile(stderr)` calls if it
 * doesn't see these symbols at link time.  Provide them as real
 * symbols so gnulib accepts the libc as already-locked. */
YURT_DECLARE_MARKER(flockfile);
YURT_DECLARE_MARKER(funlockfile);
YURT_DECLARE_MARKER(ftrylockfile);
YURT_DEFINE_MARKER(flockfile,    0x666c6f63u) /* "floc" */
YURT_DEFINE_MARKER(funlockfile,  0x66756e6cu) /* "funl" */
YURT_DEFINE_MARKER(ftrylockfile, 0x66747279u) /* "ftry" */

void flockfile(FILE *f)    { YURT_MARKER_CALL(flockfile);    (void)f; }
void funlockfile(FILE *f)  { YURT_MARKER_CALL(funlockfile);  (void)f; }
int  ftrylockfile(FILE *f) { YURT_MARKER_CALL(ftrylockfile); (void)f; return 0; }

/* ── File advisory locks ── */
YURT_DECLARE_MARKER(flock);
YURT_DEFINE_MARKER(flock, 0x666c636bu) /* "flck" */

int flock(int fd, int operation) {
  YURT_MARKER_CALL(flock);
  int rc = yurt_host_file_lock(fd, operation);
  if (rc < 0) {
    errno = -rc;
    return -1;
  }
  return 0;
}

/* ── qsort_r — GNU-flavor (4-arg with arg-after-comparator) ──
 * wasi-libc has qsort but not qsort_r.  gnulib's lib/savedir.c uses
 * the GNU signature: qsort_r(base, nmemb, size, compar, arg).
 * Implement on top of qsort by stashing the user arg in a TLS-ish
 * static — fine here because yurt is single-threaded. */
YURT_DECLARE_MARKER(qsort_r);
YURT_DEFINE_MARKER(qsort_r, 0x71735f72u) /* "qs_r" */

static int (*qsort_r_compar)(const void *, const void *, void *) = NULL;
static void *qsort_r_arg = NULL;

static int qsort_r_thunk(const void *a, const void *b) {
  return qsort_r_compar(a, b, qsort_r_arg);
}

void qsort_r(void *base, size_t nmemb, size_t size,
             int (*compar)(const void *, const void *, void *),
             void *arg) {
  YURT_MARKER_CALL(qsort_r);
  qsort_r_compar = compar;
  qsort_r_arg = arg;
  qsort(base, nmemb, size, qsort_r_thunk);
  qsort_r_compar = NULL;
  qsort_r_arg = NULL;
}

/* ── uid/gid accessors and mutators ──
 * Credentials live in the yurt process kernel.  Userland can request
 * transitions, but the host import enforces POSIX-style authorization
 * against the caller's effective uid/gid. */
YURT_DECLARE_MARKER(setresuid);
YURT_DECLARE_MARKER(setresgid);
YURT_DEFINE_MARKER(setresuid, 0x73727569u) /* "srui" */
YURT_DEFINE_MARKER(setresgid, 0x73726769u) /* "srgi" */

uid_t getuid(void) {
  return (uid_t)yurt_host_getuid();
}

uid_t geteuid(void) {
  return (uid_t)yurt_host_geteuid();
}

gid_t getgid(void) {
  return (gid_t)yurt_host_getgid();
}

gid_t getegid(void) {
  return (gid_t)yurt_host_getegid();
}

int setresuid(uid_t r, uid_t e, uid_t s) {
  YURT_MARKER_CALL(setresuid);
  int rc = yurt_host_setresuid((int)r, (int)e, (int)s);
  if (rc == 0) return 0;
  errno = EPERM;
  return -1;
}

int setresgid(gid_t r, gid_t e, gid_t s) {
  YURT_MARKER_CALL(setresgid);
  int rc = yurt_host_setresgid((int)r, (int)e, (int)s);
  if (rc == 0) return 0;
  errno = EPERM;
  return -1;
}

int setuid(uid_t uid) {
  return setresuid(uid, uid, uid);
}

int seteuid(uid_t uid) {
  return setresuid((uid_t)-1, uid, (uid_t)-1);
}

int setgid(gid_t gid) {
  return setresgid(gid, gid, gid);
}

int setegid(gid_t gid) {
  return setresgid((gid_t)-1, gid, (gid_t)-1);
}
