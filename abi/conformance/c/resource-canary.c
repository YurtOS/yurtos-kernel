/* resource-canary — exercises getrlimit / setrlimit. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

#ifndef RLIM_NLIMITS
#error "sys/resource.h must expose RLIM_NLIMITS for zsh/Linux compatibility"
#endif

#if RLIM_NLIMITS <= RLIMIT_RTPRIO
#error "RLIM_NLIMITS must be larger than the highest resource id"
#endif

static void emit(const char *case_name, int exit_code, unsigned long v) {
  printf("{\"case\":\"%s\",\"exit\":%d,\"v\":%lu}\n", case_name, exit_code, v);
}

static int case_nofile(void) {
  struct rlimit r;
  if (getrlimit(RLIMIT_NOFILE, &r) != 0) {
    emit("nofile_getrlimit_fail", 1, errno);
    return 1;
  }
  /* Yurt reports 1024 — matches Linux convention. */
  if (r.rlim_cur != 1024 || r.rlim_max != 1024) {
    emit("nofile_unexpected", 1, (unsigned long)r.rlim_cur);
    return 1;
  }
  emit("nofile", 0, (unsigned long)r.rlim_cur);
  return 0;
}

static int case_setrlimit_enforced(void) {
  struct rlimit r = { 5, 1024 };
  if (setrlimit(RLIMIT_NOFILE, &r) != 0) {
    emit("setrlimit_fail", 1, errno);
    return 1;
  }
  if (getrlimit(RLIMIT_NOFILE, &r) != 0) {
    emit("setrlimit_get_fail", 1, errno);
    return 1;
  }
  if (r.rlim_cur != 5 || r.rlim_max != 1024) {
    emit("setrlimit_unexpected", 1, (unsigned long)r.rlim_cur);
    return 1;
  }

  /* The runtime starts this canary with fds 0-3 occupied; with a soft
   * RLIMIT_NOFILE of 5, fd 4 is the only allocatable descriptor left. */
  errno = 0;
  int dup_fd = fcntl(STDOUT_FILENO, F_DUPFD, 4);
  if (dup_fd != 4) {
    if (dup_fd >= 0) close(dup_fd);
    emit("setrlimit_f_dupfd_boundary", 1, errno);
    return 1;
  }

  errno = 0;
  int exhausted_fd = fcntl(STDOUT_FILENO, F_DUPFD, 4);
  if (exhausted_fd >= 0 || errno != EMFILE) {
    if (exhausted_fd >= 0) close(exhausted_fd);
    emit("setrlimit_f_dupfd_not_emfile", 1, errno);
    return 1;
  }

  errno = 0;
  int out_of_range_fd = fcntl(STDOUT_FILENO, F_DUPFD, 5);
  if (out_of_range_fd >= 0 || errno != EINVAL) {
    if (out_of_range_fd >= 0) close(out_of_range_fd);
    emit("setrlimit_f_dupfd_not_einval", 1, errno);
    return 1;
  }

  errno = 0;
  int fd = open("/tmp/yurt-rlimit-open.txt", O_CREAT | O_RDWR | O_TRUNC, 0600);
  if (fd >= 0 || errno != EMFILE) {
    if (fd >= 0) close(fd);
    emit("setrlimit_open_not_emfile", 1, errno);
    return 1;
  }

  emit("setrlimit", 0, 5);
  return 0;
}

static int case_invalid(void) {
  struct rlimit r;
  errno = 0;
  if (getrlimit(99, &r) >= 0 || errno != EINVAL) {
    emit("invalid_should_einval", 1, errno);
    return 1;
  }
  emit("invalid_einval", 0, 0);
  return 0;
}

static int case_setrlimit_raise_hard_denied(void) {
  struct rlimit r = { 1024, 2048 };
  errno = 0;
  if (setrlimit(RLIMIT_NOFILE, &r) >= 0 || errno != EPERM) {
    emit("setrlimit_raise_hard_should_eperm", 1, errno);
    return 1;
  }
  emit("setrlimit_raise_hard_eperm", 0, 0);
  return 0;
}

static int case_posix_madvise(void) {
  char page[4096];
  if (posix_madvise(page, sizeof(page), POSIX_MADV_NORMAL) != 0) {
    emit("posix_madvise_normal_fail", 1, errno);
    return 1;
  }
  int rc = posix_madvise(page, sizeof(page), 999);
  if (rc != EINVAL) {
    emit("posix_madvise_invalid_should_einval", 1, (unsigned long)rc);
    return 1;
  }
  emit("posix_madvise", 0, 0);
  return 0;
}

int main(void) {
  int rc = 0;
  rc |= case_nofile();
  rc |= case_setrlimit_raise_hard_denied();
  rc |= case_setrlimit_enforced();
  rc |= case_invalid();
  rc |= case_posix_madvise();
  return rc;
}
