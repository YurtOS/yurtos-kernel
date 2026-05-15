/* Filesystem-ownership and process-priority shims that wasi-libc
 * doesn't ship.  These are real symbols (not static inline) so
 * gnulib's REPLACE_* probes detect them at link time and skip
 * compiling its own replacement copies — which would otherwise
 * collide with our compat headers' inline versions.
 *
 * Sandbox semantics: file ownership and process priority mutators route
 * through the host/kernel authorization boundary. Priority changes only
 * succeed when the selected engine backend can apply them.
 */

#include "yurt_markers.h"
#include "yurt_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <wasi/libc.h>
#include <wasi/libc-nocwd.h>
#include <wasi/wasip1.h>

#ifndef AT_EACCESS
#define AT_EACCESS 0x200
#endif

YURT_DECLARE_MARKER(chown);
YURT_DECLARE_MARKER(lchown);
YURT_DECLARE_MARKER(fchown);
YURT_DECLARE_MARKER(chroot);
YURT_DECLARE_MARKER(chmod);
YURT_DECLARE_MARKER(getpriority);
YURT_DECLARE_MARKER(setpriority);

YURT_DEFINE_MARKER(chown,       0x63686f77u) /* "chow" */
YURT_DEFINE_MARKER(lchown,      0x6c63686fu) /* "lcho" */
YURT_DEFINE_MARKER(fchown,      0x6663686fu) /* "fcho" */
YURT_DEFINE_MARKER(chroot,      0x6368726fu) /* "chro" */
YURT_DEFINE_MARKER(chmod,       0x63686d6fu) /* "chmo" */
YURT_DEFINE_MARKER(getpriority, 0x67707269u) /* "gpri" */
YURT_DEFINE_MARKER(setpriority, 0x73707269u) /* "spri" */
/* getrusage is provided by libwasi-emulated-process-clocks; we used
 * to define it here too but that produces a duplicate-symbol link
 * error.  The wasi-emulated impl zero-fills the rusage struct,
 * which is what we want anyway. */

static int yurt_apply_stat_permissions(int rc, struct stat *buf) {
  if (rc != 0 || !buf) return rc;

  /* WASI Preview 1 filestat has file type/size/times but no POSIX
   * permission or owner fields.  The Yurt host writes the VFS mode,
   * uid, and gid into filestat.dev; translate that side channel back
   * into struct stat while preserving the file type.
   */
  uint64_t meta = (uint64_t)buf->st_dev;
  buf->st_mode = (buf->st_mode & S_IFMT) | ((mode_t)meta & 07777);
  buf->st_uid = (uid_t)((meta >> 16) & 0xffffffu);
  buf->st_gid = (gid_t)((meta >> 40) & 0xffffffu);
  return rc;
}

static void yurt_fix_root_stat_inode(const char *path, struct stat *buf) {
  if (!path || !buf || strcmp(path, "/") != 0) return;
  buf->st_ino = (ino_t)12638123428881205758ull;
}

static mode_t yurt_wasi_filetype_mode(__wasi_filetype_t filetype) {
  switch (filetype) {
    case __WASI_FILETYPE_DIRECTORY:
      return S_IFDIR;
    case __WASI_FILETYPE_REGULAR_FILE:
      return S_IFREG;
    case __WASI_FILETYPE_SYMBOLIC_LINK:
      return S_IFLNK;
    case __WASI_FILETYPE_CHARACTER_DEVICE:
      return S_IFCHR;
    case __WASI_FILETYPE_BLOCK_DEVICE:
      return S_IFBLK;
    case __WASI_FILETYPE_SOCKET_DGRAM:
    case __WASI_FILETYPE_SOCKET_STREAM:
      return S_IFSOCK;
    default:
      return 0;
  }
}

static void yurt_timespec_from_wasi(struct timespec *out, __wasi_timestamp_t ns) {
  out->tv_sec = (time_t)(ns / 1000000000ull);
  out->tv_nsec = (long)(ns % 1000000000ull);
}

static int yurt_stat_from_wasi_filestat(const __wasi_filestat_t *wst, struct stat *buf) {
  if (!wst || !buf) {
    errno = EFAULT;
    return -1;
  }
  memset(buf, 0, sizeof(*buf));
  uint64_t meta = (uint64_t)wst->dev;
  buf->st_dev = (dev_t)wst->dev;
  buf->st_ino = (ino_t)wst->ino;
  buf->st_nlink = (nlink_t)wst->nlink;
  buf->st_mode = yurt_wasi_filetype_mode(wst->filetype) | ((mode_t)meta & 07777);
  buf->st_uid = (uid_t)((meta >> 16) & 0xffffffu);
  buf->st_gid = (gid_t)((meta >> 40) & 0xffffffu);
  buf->st_size = (off_t)wst->size;
  buf->st_blksize = 4096;
  buf->st_blocks = (blkcnt_t)((wst->size + 511) / 512);
  yurt_timespec_from_wasi(&buf->st_atim, wst->atim);
  yurt_timespec_from_wasi(&buf->st_mtim, wst->mtim);
  yurt_timespec_from_wasi(&buf->st_ctim, wst->ctim);
  return 0;
}

static int yurt_stat_impl(const char *restrict path, struct stat *restrict buf) {
  int rc = yurt_apply_stat_permissions(__wasilibc_stat(path, buf, 0), buf);
  if (rc == 0) yurt_fix_root_stat_inode(path, buf);
  return rc;
}

int stat(const char *restrict path, struct stat *restrict buf) {
  return yurt_stat_impl(path, buf);
}

int __wrap_stat(const char *restrict path, struct stat *restrict buf) {
  return yurt_stat_impl(path, buf);
}

static int yurt_lstat_impl(const char *restrict path, struct stat *restrict buf) {
  int rc = yurt_apply_stat_permissions(
    __wasilibc_stat(path, buf, AT_SYMLINK_NOFOLLOW),
    buf
  );
  if (rc == 0) yurt_fix_root_stat_inode(path, buf);
  return rc;
}

int lstat(const char *restrict path, struct stat *restrict buf) {
  return yurt_lstat_impl(path, buf);
}

int __wrap_lstat(const char *restrict path, struct stat *restrict buf) {
  return yurt_lstat_impl(path, buf);
}

static int yurt_fstatat_impl(int fd, const char *restrict path, struct stat *restrict buf, int flags) {
  int rc = fd == AT_FDCWD
    ? __wasilibc_stat(path, buf, flags)
    : __wasilibc_nocwd_fstatat(fd, path, buf, flags);
  rc = yurt_apply_stat_permissions(rc, buf);
  if (rc == 0 && fd == AT_FDCWD) yurt_fix_root_stat_inode(path, buf);
  return rc;
}

int fstatat(int fd, const char *restrict path, struct stat *restrict buf, int flags) {
  return yurt_fstatat_impl(fd, path, buf, flags);
}

int __wrap_fstatat(int fd, const char *restrict path, struct stat *restrict buf, int flags) {
  return yurt_fstatat_impl(fd, path, buf, flags);
}

static int yurt_fstat_impl(int fd, struct stat *buf) {
  __wasi_filestat_t wst;
  __wasi_errno_t err = __wasi_fd_filestat_get((__wasi_fd_t)fd, &wst);
  if (err != 0) {
    errno = EBADF;
    return -1;
  }
  return yurt_stat_from_wasi_filestat(&wst, buf);
}

int fstat(int fd, struct stat *buf) {
  return yurt_fstat_impl(fd, buf);
}

int __wrap_fstat(int fd, struct stat *buf) {
  return yurt_fstat_impl(fd, buf);
}

static int yurt_stat_allows(const struct stat *st, int mode, uid_t uid, gid_t gid) {
  if ((mode & F_OK) == 0 && mode == F_OK) return 1;
  if ((mode & ~(R_OK | W_OK | X_OK)) != 0) {
    errno = EINVAL;
    return 0;
  }

  mode_t bits = st->st_mode;
  if (uid == 0) {
    if ((mode & X_OK) && !S_ISDIR(bits) && (bits & 0111) == 0) return 0;
    return 1;
  }

  mode_t granted;
  if (st->st_uid == uid) {
    granted = (bits >> 6) & 07;
  } else if (st->st_gid == gid) {
    granted = (bits >> 3) & 07;
  } else {
    granted = bits & 07;
  }

  if ((mode & R_OK) && !(granted & 04)) return 0;
  if ((mode & W_OK) && !(granted & 02)) return 0;
  if ((mode & X_OK) && !(granted & 01)) return 0;
  return 1;
}

static uid_t yurt_getuid_impl(void);
static uid_t yurt_geteuid_impl(void);
static gid_t yurt_getgid_impl(void);
static gid_t yurt_getegid_impl(void);

static int yurt_faccessat_impl(int fd, const char *path, int mode, int flags) {
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  struct stat st;
  int stat_flags = (flags & AT_SYMLINK_NOFOLLOW) ? AT_SYMLINK_NOFOLLOW : 0;
  if (yurt_fstatat_impl(fd, path, &st, stat_flags) != 0) return -1;

  uid_t uid = (flags & AT_EACCESS) ? yurt_geteuid_impl() : yurt_getuid_impl();
  gid_t gid = (flags & AT_EACCESS) ? yurt_getegid_impl() : yurt_getgid_impl();
  if (yurt_stat_allows(&st, mode, uid, gid)) return 0;
  errno = EACCES;
  return -1;
}

int faccessat(int fd, const char *path, int mode, int flags) {
  return yurt_faccessat_impl(fd, path, mode, flags);
}

int __wrap_faccessat(int fd, const char *path, int mode, int flags) {
  return yurt_faccessat_impl(fd, path, mode, flags);
}

static int yurt_access_impl(const char *path, int mode) {
  return yurt_faccessat_impl(AT_FDCWD, path, mode, 0);
}

int access(const char *path, int mode) {
  return yurt_access_impl(path, mode);
}

int __wrap_access(const char *path, int mode) {
  return yurt_access_impl(path, mode);
}

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

int fchownat(int fd, const char *path, uid_t owner, gid_t group, int flags) {
  if (!path) {
    errno = EFAULT;
    return -1;
  }
  if (fd != AT_FDCWD && path[0] != '/') {
    errno = ENOSYS;
    return -1;
  }
  int follow = (flags & AT_SYMLINK_NOFOLLOW) ? 0 : 1;
  int rc = yurt_host_chown((int)(intptr_t)path, (int)strlen(path), (int)owner, (int)group, follow);
  if (rc == 0) return 0;
  errno = (rc == -1) ? ENOENT : (rc == -2) ? EPERM : EIO;
  return -1;
}

int __wrap_fchownat(int fd, const char *path, uid_t owner, gid_t group, int flags) {
  return fchownat(fd, path, owner, group, flags);
}

int chroot(const char *path) {
  YURT_MARKER_CALL(chroot);
  (void)path;
  errno = ENOSYS;
  return -1;
}

static int yurt_chmod_impl(const char *path, mode_t mode) {
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

int chmod(const char *path, mode_t mode) {
  return yurt_chmod_impl(path, mode);
}

int __wrap_chmod(const char *path, mode_t mode) {
  return yurt_chmod_impl(path, mode);
}

int getpriority(int which, id_t who) {
  YURT_MARKER_CALL(getpriority);
  int rc = yurt_host_getpriority(which, (int)who);
  if (rc >= -20 && rc <= 19) return rc;
  errno = (rc == -22) ? EINVAL : (rc == -1001) ? ESRCH : EIO;
  return -1;
}

int setpriority(int which, id_t who, int prio) {
  YURT_MARKER_CALL(setpriority);
  int rc = yurt_host_setpriority(which, (int)who, prio);
  if (rc == 0) return 0;
  errno = (rc == -38) ? ENOSYS
    : (rc == -22) ? EINVAL
    : (rc == -1) ? ESRCH
    : (rc == -2) ? EPERM
    : EIO;
  return -1;
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
 * The implementation lives in Rust so the comparator arg is call-local
 * instead of process-global state. */
YURT_DECLARE_MARKER(qsort_r);
YURT_DEFINE_MARKER(qsort_r, 0x71735f72u) /* "qs_r" */

extern void yurt_rs_qsort_r(void *base, size_t nmemb, size_t size,
                            int (*compar)(const void *, const void *, void *),
                            void *arg);

void qsort_r(void *base, size_t nmemb, size_t size,
             int (*compar)(const void *, const void *, void *),
             void *arg) {
  YURT_MARKER_CALL(qsort_r);
  yurt_rs_qsort_r(base, nmemb, size, compar, arg);
}

/* ── uid/gid accessors and mutators ──
 * Credentials live in the yurt process kernel.  Userland can request
 * transitions, but the host import enforces POSIX-style authorization
 * against the caller's effective uid/gid. */
YURT_DECLARE_MARKER(setresuid);
YURT_DECLARE_MARKER(setresgid);
YURT_DEFINE_MARKER(setresuid, 0x73727569u) /* "srui" */
YURT_DEFINE_MARKER(setresgid, 0x73726769u) /* "srgi" */

static uid_t yurt_getuid_impl(void) {
  return (uid_t)yurt_host_getuid();
}

uid_t getuid(void) {
  return yurt_getuid_impl();
}

uid_t __wrap_getuid(void) {
  return yurt_getuid_impl();
}

static uid_t yurt_geteuid_impl(void) {
  return (uid_t)yurt_host_geteuid();
}

uid_t geteuid(void) {
  return yurt_geteuid_impl();
}

uid_t __wrap_geteuid(void) {
  return yurt_geteuid_impl();
}

static gid_t yurt_getgid_impl(void) {
  return (gid_t)yurt_host_getgid();
}

gid_t getgid(void) {
  return yurt_getgid_impl();
}

gid_t __wrap_getgid(void) {
  return yurt_getgid_impl();
}

static gid_t yurt_getegid_impl(void) {
  return (gid_t)yurt_host_getegid();
}

gid_t getegid(void) {
  return yurt_getegid_impl();
}

gid_t __wrap_getegid(void) {
  return yurt_getegid_impl();
}

static int yurt_setresuid_impl(uid_t r, uid_t e, uid_t s) {
  YURT_MARKER_CALL(setresuid);
  int rc = yurt_host_setresuid((int)r, (int)e, (int)s);
  if (rc == 0) return 0;
  errno = EPERM;
  return -1;
}

int setresuid(uid_t r, uid_t e, uid_t s) {
  return yurt_setresuid_impl(r, e, s);
}

static int yurt_setresgid_impl(gid_t r, gid_t e, gid_t s) {
  YURT_MARKER_CALL(setresgid);
  int rc = yurt_host_setresgid((int)r, (int)e, (int)s);
  if (rc == 0) return 0;
  errno = EPERM;
  return -1;
}

int setresgid(gid_t r, gid_t e, gid_t s) {
  return yurt_setresgid_impl(r, e, s);
}

static int yurt_setuid_impl(uid_t uid) {
  return yurt_setresuid_impl(uid, uid, uid);
}

int setuid(uid_t uid) {
  return yurt_setuid_impl(uid);
}

int __wrap_setuid(uid_t uid) {
  return yurt_setuid_impl(uid);
}

static int yurt_seteuid_impl(uid_t uid) {
  return yurt_setresuid_impl((uid_t)-1, uid, (uid_t)-1);
}

int seteuid(uid_t uid) {
  return yurt_seteuid_impl(uid);
}

int __wrap_seteuid(uid_t uid) {
  return yurt_seteuid_impl(uid);
}

static int yurt_setgid_impl(gid_t gid) {
  return yurt_setresgid_impl(gid, gid, gid);
}

int setgid(gid_t gid) {
  return yurt_setgid_impl(gid);
}

int __wrap_setgid(gid_t gid) {
  return yurt_setgid_impl(gid);
}

static int yurt_setegid_impl(gid_t gid) {
  return yurt_setresgid_impl((gid_t)-1, gid, (gid_t)-1);
}

int setegid(gid_t gid) {
  return yurt_setegid_impl(gid);
}

int __wrap_setegid(gid_t gid) {
  return yurt_setegid_impl(gid);
}

char *cuserid(char *s) {
  static char user[L_cuserid];
  char *out = s ? s : user;
  const char *name = (geteuid() == 0) ? "root" : "user";
  size_t n = strlen(name) + 1;
  if (n > L_cuserid) {
    errno = ERANGE;
    return NULL;
  }
  memcpy(out, name, n);
  return out;
}
