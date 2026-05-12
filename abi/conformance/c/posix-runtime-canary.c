#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/sendfile.h>
#include <sys/time.h>
#include <unistd.h>

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_hostname(void) {
  char buf[64];
  errno = 0;
  int rc = gethostname(buf, sizeof(buf));
  if (rc != 0) {
    emit("hostname", 1, NULL, 1, errno);
    return 1;
  }
  char out[96];
  snprintf(out, sizeof(out), "hostname:%s", buf);
  emit("hostname", strcmp(buf, "yurt") == 0 ? 0 : 1, out, 0, 0);
  return strcmp(buf, "yurt") == 0 ? 0 : 1;
}

static int case_hostname_too_small(void) {
  char buf[4] = {0};
  errno = 0;
  int rc = gethostname(buf, sizeof(buf));
  if (rc != -1) {
    emit("hostname_too_small", 1, "hostname_too_small:not_failed", 0, 0);
    return 1;
  }
  emit("hostname_too_small", 0, "hostname_too_small:-1", 1, errno);
  return 0;
}

static int case_loopback_name_to_index(void) {
  errno = 0;
  unsigned int idx = if_nametoindex("lo");
  char out[64];
  snprintf(out, sizeof(out), "if_nametoindex:%u", idx);
  emit("loopback_name_to_index", idx == 1 ? 0 : 1, out, 0, 0);
  return idx == 1 ? 0 : 1;
}

static int case_missing_name(void) {
  errno = 0;
  unsigned int idx = if_nametoindex("eth0");
  char out[64];
  snprintf(out, sizeof(out), "if_nametoindex_missing:%u", idx);
  emit("missing_name", idx == 0 ? 0 : 1, out, 1, errno);
  return idx == 0 ? 0 : 1;
}

static int case_loopback_index_to_name(void) {
  char buf[IF_NAMESIZE];
  errno = 0;
  char *got = if_indextoname(1, buf);
  char out[64];
  snprintf(out, sizeof(out), "if_indextoname:%s", got ? got : "null");
  emit("loopback_index_to_name", got && strcmp(got, "lo") == 0 ? 0 : 1, out, 0, 0);
  return got && strcmp(got, "lo") == 0 ? 0 : 1;
}

static int case_missing_index(void) {
  char buf[IF_NAMESIZE];
  errno = 0;
  char *got = if_indextoname(2, buf);
  emit("missing_index", got == NULL ? 0 : 1, "if_indextoname_missing:null", 1, errno);
  return got == NULL ? 0 : 1;
}

static int case_sendfile_zero_count(void) {
  errno = 0;
  ssize_t n = sendfile(1, 0, NULL, 0);
  emit("sendfile_zero_count", n == 0 ? 0 : 1, "sendfile_zero:0", 0, 0);
  return n == 0 ? 0 : 1;
}

static int case_sendfile_bad_fd(void) {
  errno = 0;
  ssize_t n = sendfile(1, -1, NULL, 1);
  emit("sendfile_bad_fd", n == -1 ? 0 : 1, "sendfile_bad_fd:-1", 1, errno);
  return n == -1 ? 0 : 1;
}

static int case_chmod_readonly(void) {
  const char *path = "/tmp/yurt-chmod-canary.txt";
  unlink(path);

  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
  if (fd < 0) {
    emit("chmod_readonly", 1, "chmod_readonly:create_failed", 1, errno);
    return 1;
  }
  if (write(fd, "x", 1) != 1) {
    int e = errno;
    close(fd);
    emit("chmod_readonly", 1, "chmod_readonly:write_failed", 1, e);
    return 1;
  }
  close(fd);

  errno = 0;
  if (chmod(path, 0444) != 0) {
    emit("chmod_readonly", 1, "chmod_readonly:chmod_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (chmod("/tmp/yurt-chmod-missing.txt", 0644) != -1 || errno != ENOENT) {
    emit("chmod_readonly", 1, "chmod_readonly:missing_not_enoent", 1, errno);
    return 1;
  }
  emit("chmod_readonly", 0, "chmod_readonly:ok", 0, 0);
  return 0;
}

static int case_chown_denied(void) {
  const char *path = "/tmp/yurt-chown-canary.txt";
  unlink(path);

  int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
  if (fd < 0) {
    emit("chown_denied", 1, "chown_denied:create_failed", 1, errno);
    return 1;
  }
  if (write(fd, "x", 1) != 1) {
    int e = errno;
    close(fd);
    emit("chown_denied", 1, "chown_denied:write_failed", 1, e);
    return 1;
  }

  errno = 0;
  if (chown(path, 1000, 1000) != -1 || errno != EPERM) {
    int e = errno;
    close(fd);
    emit("chown_denied", 1, "chown_denied:chown_not_eperm", 1, e);
    return 1;
  }

  errno = 0;
  if (lchown(path, 1000, 1000) != -1 || errno != EPERM) {
    int e = errno;
    close(fd);
    emit("chown_denied", 1, "chown_denied:lchown_not_eperm", 1, e);
    return 1;
  }

  errno = 0;
  if (fchown(fd, 1000, 1000) != -1 || errno != EPERM) {
    int e = errno;
    close(fd);
    emit("chown_denied", 1, "chown_denied:fchown_not_eperm", 1, e);
    return 1;
  }
  close(fd);

  errno = 0;
  if (chown("/tmp/yurt-chown-missing.txt", 1000, 1000) != -1 || errno != ENOENT) {
    emit("chown_denied", 1, "chown_denied:missing_not_enoent", 1, errno);
    return 1;
  }

  emit("chown_denied", 0, "chown_denied:ok", 0, 0);
  return 0;
}

static int case_identity_kernel(void) {
  if (getuid() != 1000 || geteuid() != 1000 || getgid() != 1000 || getegid() != 1000) {
    emit("identity_kernel", 1, "identity_kernel:unexpected_ids", 0, 0);
    return 1;
  }

  errno = 0;
  if (setresuid(1000, 1000, 1000) != 0) {
    emit("identity_kernel", 1, "identity_kernel:setresuid_noop_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (setresuid((uid_t)-1, (uid_t)-1, (uid_t)-1) != 0) {
    emit("identity_kernel", 1, "identity_kernel:setresuid_keep_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (setresuid(0, 0, 0) != -1 || errno != EPERM) {
    emit("identity_kernel", 1, "identity_kernel:setresuid_root_not_eperm", 1, errno);
    return 1;
  }

  errno = 0;
  if (seteuid(0) != -1 || errno != EPERM) {
    emit("identity_kernel", 1, "identity_kernel:seteuid_root_not_eperm", 1, errno);
    return 1;
  }

  errno = 0;
  if (setresgid(1000, 1000, 1000) != 0) {
    emit("identity_kernel", 1, "identity_kernel:setresgid_noop_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (setresgid(0, 0, 0) != -1 || errno != EPERM) {
    emit("identity_kernel", 1, "identity_kernel:setresgid_root_not_eperm", 1, errno);
    return 1;
  }

  errno = 0;
  if (setegid(0) != -1 || errno != EPERM) {
    emit("identity_kernel", 1, "identity_kernel:setegid_root_not_eperm", 1, errno);
    return 1;
  }

  char name[L_cuserid] = {0};
  if (!cuserid(name) || strcmp(name, "user") != 0) {
    emit("identity_kernel", 1, name[0] ? name : "identity_kernel:cuserid_failed", 1, errno);
    return 1;
  }

  emit("identity_kernel", 0, "identity_kernel:ok", 0, 0);
  return 0;
}

static int case_cwd_backend(void) {
  const char *base = "/tmp/yurt-cwd-canary";
  const char *sub = "/tmp/yurt-cwd-canary/sub";
  mkdir(base, 0755);
  mkdir(sub, 0755);

  char cwd[128];
  errno = 0;
  if (chdir(base) != 0) {
    emit("cwd_backend", 1, "cwd_backend:chdir_base_failed", 1, errno);
    return 1;
  }
  if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, base) != 0) {
    emit("cwd_backend", 1, "cwd_backend:getcwd_base_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (chdir("sub") != 0) {
    emit("cwd_backend", 1, "cwd_backend:relative_chdir_failed", 1, errno);
    return 1;
  }
  if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, sub) != 0) {
    emit("cwd_backend", 1, "cwd_backend:getcwd_sub_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (getcwd(cwd, 4) != NULL || errno != ERANGE) {
    emit("cwd_backend", 1, "cwd_backend:getcwd_small_not_erange", 1, errno);
    return 1;
  }

  int fd = open(base, O_RDONLY | O_DIRECTORY);
  if (fd < 0) {
    emit("cwd_backend", 1, "cwd_backend:open_dir_failed", 1, errno);
    return 1;
  }
  errno = 0;
  if (fchdir(fd) != 0) {
    int e = errno;
    close(fd);
    emit("cwd_backend", 1, "cwd_backend:fchdir_failed", 1, e);
    return 1;
  }
  close(fd);
  if (!getcwd(cwd, sizeof(cwd)) || strcmp(cwd, base) != 0) {
    emit("cwd_backend", 1, "cwd_backend:getcwd_after_fchdir_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (chdir("/tmp/yurt-cwd-missing") != -1 || errno != ENOENT) {
    emit("cwd_backend", 1, "cwd_backend:missing_not_enoent", 1, errno);
    return 1;
  }

  emit("cwd_backend", 0, "cwd_backend:ok", 0, 0);
  return 0;
}

static int case_realpath_backend(void) {
  const char *base = "/tmp/yurt-realpath-canary";
  char resolved[128];
  mkdir(base, 0755);
  mkdir("/tmp/yurt-realpath-canary/real", 0755);
  mkdir("/tmp/yurt-realpath-canary/sub", 0755);
  symlink("../real", "/tmp/yurt-realpath-canary/sub/fake");

  errno = 0;
  if (!realpath("/tmp/yurt-realpath-canary/./sub/fake/.", resolved) ||
      strcmp(resolved, "/tmp/yurt-realpath-canary/real") != 0) {
    emit("realpath_backend", 1, resolved[0] ? resolved : "realpath_backend:canonical_failed", 1, errno);
    return 1;
  }

  errno = 0;
  char *allocated = realpath("/tmp/yurt-realpath-canary/sub/fake", NULL);
  if (!allocated || strcmp(allocated, "/tmp/yurt-realpath-canary/real") != 0) {
    int e = errno;
    free(allocated);
    emit("realpath_backend", 1, "realpath_backend:null_buffer_failed", 1, e);
    return 1;
  }
  free(allocated);

  errno = 0;
  if (realpath("/tmp/yurt-realpath-canary/missing", resolved) != NULL || errno != ENOENT) {
    emit("realpath_backend", 1, "realpath_backend:missing_not_enoent", 1, errno);
    return 1;
  }

  emit("realpath_backend", 0, "realpath_backend:ok", 0, 0);
  return 0;
}

static int case_ttyname_stdio(void) {
  errno = 0;
  char *name = ttyname(0);
  if (name != NULL || errno != ENOTTY) {
    emit("ttyname_stdio", 1, name ? name : "ttyname_stdio:ttyname_not_enotty", 1, errno);
    return 1;
  }

  char buf[16];
  errno = 0;
  int rc = ttyname_r(1, buf, sizeof(buf));
  if (rc != ENOTTY) {
    emit("ttyname_stdio", 1, "ttyname_stdio:ttyname_r_not_enotty", 1, rc);
    return 1;
  }

  emit("ttyname_stdio", 0, "ttyname_stdio:enotty", 0, 0);
  return 0;
}

static int case_priority_unsupported(void) {
  errno = 0;
  int prio = getpriority(PRIO_PROCESS, 0);
  if (prio != 0 || errno != 0) {
    emit("priority_unsupported", 1, "priority_unsupported:getpriority_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (setpriority(PRIO_PROCESS, 0, 5) != -1 || errno != ENOSYS) {
    emit("priority_unsupported", 1, "priority_unsupported:setpriority_not_enosys", 1, errno);
    return 1;
  }

  errno = 0;
  if (nice(1) != -1 || errno != ENOSYS) {
    emit("priority_unsupported", 1, "priority_unsupported:nice_not_enosys", 1, errno);
    return 1;
  }

  emit("priority_unsupported", 0, "priority_unsupported:ok", 0, 0);
  return 0;
}

static int case_fcntl_pipe_status_flags(void) {
  int fds[2];
  if (pipe(fds) != 0) {
    emit("fcntl_pipe_status_flags", 1, "fcntl_pipe_status_flags:pipe_failed", 1, errno);
    return 1;
  }

  errno = 0;
  int flags = fcntl(fds[0], F_GETFL);
  if (flags < 0) {
    int e = errno;
    close(fds[0]);
    close(fds[1]);
    emit("fcntl_pipe_status_flags", 1, "fcntl_pipe_status_flags:getfl_failed", 1, e);
    return 1;
  }

  errno = 0;
  if (fcntl(fds[0], F_SETFL, flags | O_NONBLOCK) != 0) {
    int e = errno;
    close(fds[0]);
    close(fds[1]);
    emit("fcntl_pipe_status_flags", 1, "fcntl_pipe_status_flags:setfl_failed", 1, e);
    return 1;
  }

  errno = 0;
  int updated = fcntl(fds[0], F_GETFL);
  close(fds[0]);
  close(fds[1]);
  if (updated < 0 || (updated & O_NONBLOCK) == 0) {
    emit("fcntl_pipe_status_flags", 1, "fcntl_pipe_status_flags:nonblock_missing", updated < 0, errno);
    return 1;
  }

  emit("fcntl_pipe_status_flags", 0, "fcntl_pipe_status_flags:ok", 0, 0);
  return 0;
}

static int case_fcntl_setfl_masks_access_mode(void) {
  const char *path = "/tmp/yurt-fcntl-mask.txt";
  unlink(path);
  int seed = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (seed < 0) {
    emit("fcntl_setfl_masks_access_mode", 1, "fcntl_setfl_masks_access_mode:create_failed", 1, errno);
    return 1;
  }
  if (write(seed, "x", 1) != 1) {
    int e = errno;
    close(seed);
    emit("fcntl_setfl_masks_access_mode", 1, "fcntl_setfl_masks_access_mode:write_failed", 1, e);
    return 1;
  }
  close(seed);

  int fd = open(path, O_RDONLY);
  if (fd < 0) {
    emit("fcntl_setfl_masks_access_mode", 1, "fcntl_setfl_masks_access_mode:open_failed", 1, errno);
    return 1;
  }

  errno = 0;
  if (fcntl(fd, F_SETFL, O_RDWR | O_NONBLOCK) != 0) {
    int e = errno;
    close(fd);
    emit("fcntl_setfl_masks_access_mode", 1, "fcntl_setfl_masks_access_mode:setfl_failed", 1, e);
    return 1;
  }

  errno = 0;
  int flags = fcntl(fd, F_GETFL);
  close(fd);
  if (flags < 0 || (flags & O_ACCMODE) != O_RDONLY || (flags & O_NONBLOCK) == 0) {
    char out[96];
    snprintf(out, sizeof(out), "fcntl_setfl_masks_access_mode:bad_flags:%d:%d:%d", flags, O_ACCMODE, O_RDONLY);
    emit("fcntl_setfl_masks_access_mode", 1, out, flags < 0, errno);
    return 1;
  }

  emit("fcntl_setfl_masks_access_mode", 0, "fcntl_setfl_masks_access_mode:ok", 0, 0);
  return 0;
}

static int case_readdir_dot_entries(void) {
  if (mkdir("/tmp/dirent-canary", 0777) != 0 && errno != EEXIST) {
    emit("readdir_dot_entries", 1, "readdir_dot_entries:mkdir_failed", 1, errno);
    return 1;
  }
  FILE *f = fopen("/tmp/dirent-canary/file.txt", "wb");
  if (!f) {
    emit("readdir_dot_entries", 1, "readdir_dot_entries:fopen_failed", 1, errno);
    return 1;
  }
  if (fputs("ok", f) < 0 || fclose(f) != 0) {
    emit("readdir_dot_entries", 1, "readdir_dot_entries:fwrite_failed", 1, errno);
    return 1;
  }

  DIR *dir = opendir("/tmp/dirent-canary");
  if (!dir) {
    emit("readdir_dot_entries", 1, "readdir_dot_entries:opendir_failed", 1, errno);
    return 1;
  }
  int saw_dot = 0;
  int saw_dotdot = 0;
  int saw_file = 0;
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0) saw_dot = 1;
    if (strcmp(entry->d_name, "..") == 0) saw_dotdot = 1;
    if (strcmp(entry->d_name, "file.txt") == 0) saw_file = 1;
  }
  int close_rc = closedir(dir);
  if (close_rc != 0) {
    emit("readdir_dot_entries", 1, "readdir_dot_entries:closedir_failed", 1, errno);
    return 1;
  }
  if (!saw_dot || !saw_dotdot || !saw_file) {
    char out[96];
    snprintf(out, sizeof(out), "readdir_dot_entries:%d:%d:%d", saw_dot, saw_dotdot, saw_file);
    emit("readdir_dot_entries", 1, out, 0, 0);
    return 1;
  }
  emit("readdir_dot_entries", 0, "readdir_dot_entries:ok", 0, 0);
  return 0;
}

static int case_utimes_mtime(void) {
  FILE *f = fopen("/tmp/utimes-canary.txt", "wb");
  if (!f) {
    emit("utimes_mtime", 1, "utimes_mtime:fopen_failed", 1, errno);
    return 1;
  }
  if (fputs("ok", f) < 0 || fclose(f) != 0) {
    emit("utimes_mtime", 1, "utimes_mtime:fwrite_failed", 1, errno);
    return 1;
  }

  struct timeval times[2];
  times[0].tv_sec = 10;
  times[0].tv_usec = 0;
  times[1].tv_sec = 10;
  times[1].tv_usec = 0;
  if (utimes("/tmp/utimes-canary.txt", times) != 0) {
    emit("utimes_mtime", 1, "utimes_mtime:utimes_failed", 1, errno);
    return 1;
  }
  struct stat st;
  if (stat("/tmp/utimes-canary.txt", &st) != 0) {
    emit("utimes_mtime", 1, "utimes_mtime:stat_failed", 1, errno);
    return 1;
  }
  if (st.st_mtime != 10) {
    char out[96];
    snprintf(out, sizeof(out), "utimes_mtime:%lld", (long long)st.st_mtime);
    emit("utimes_mtime", 1, out, 0, 0);
    return 1;
  }
  emit("utimes_mtime", 0, "utimes_mtime:ok", 0, 0);
  return 0;
}

static int case_poll_regular_fd(void) {
  const char *path = "/tmp/yurt-poll-canary.txt";
  unlink(path);
  int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
  if (fd < 0) {
    emit("poll_regular_fd", 1, "poll_regular_fd:open_failed", 1, errno);
    return 1;
  }
  if (write(fd, "x", 1) != 1) {
    int e = errno;
    close(fd);
    emit("poll_regular_fd", 1, "poll_regular_fd:write_failed", 1, e);
    return 1;
  }

  struct pollfd fds[2];
  fds[0].fd = fd;
  fds[0].events = POLLIN | POLLOUT;
  fds[0].revents = 0;
  fds[1].fd = -123;
  fds[1].events = POLLIN;
  fds[1].revents = 0;

  errno = 0;
  int rc = poll(fds, 2, 0);
  close(fd);
  if (rc != 1 ||
      (fds[0].revents & (POLLIN | POLLOUT)) != (POLLIN | POLLOUT) ||
      fds[1].revents != 0) {
    char out[128];
    snprintf(out, sizeof(out), "poll_regular_fd:bad:%d:%d:%d", rc, fds[0].revents, fds[1].revents);
    emit("poll_regular_fd", 1, out, 1, errno);
    return 1;
  }

  fds[0].fd = 9999;
  fds[0].events = POLLIN;
  fds[0].revents = 0;
  errno = 0;
  rc = poll(fds, 1, 0);
  if (rc != 1 || fds[0].revents != POLLNVAL) {
    char out[128];
    snprintf(out, sizeof(out), "poll_regular_fd:bad_invalid:%d:%d", rc, fds[0].revents);
    emit("poll_regular_fd", 1, out, 1, errno);
    return 1;
  }

  emit("poll_regular_fd", 0, "poll_regular_fd:ok", 0, 0);
  return 0;
}

static int case_select_regular_fd(void) {
  const char *path = "/tmp/yurt-select-canary.txt";
  unlink(path);
  int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
  if (fd < 0) {
    emit("select_regular_fd", 1, "select_regular_fd:open_failed", 1, errno);
    return 1;
  }
  if (write(fd, "x", 1) != 1) {
    int e = errno;
    close(fd);
    emit("select_regular_fd", 1, "select_regular_fd:write_failed", 1, e);
    return 1;
  }

  fd_set readfds;
  fd_set writefds;
  FD_ZERO(&readfds);
  FD_ZERO(&writefds);
  FD_SET(fd, &readfds);
  FD_SET(fd, &writefds);
  struct timeval timeout = {0, 0};

  errno = 0;
  int rc = select(fd + 1, &readfds, &writefds, NULL, &timeout);
  if (rc != 2 || !FD_ISSET(fd, &readfds) || !FD_ISSET(fd, &writefds)) {
    char out[128];
    snprintf(out, sizeof(out), "select_regular_fd:bad:%d:%d:%d", rc, FD_ISSET(fd, &readfds), FD_ISSET(fd, &writefds));
    close(fd);
    emit("select_regular_fd", 1, out, 1, errno);
    return 1;
  }
  close(fd);

  FD_ZERO(&readfds);
  int invalid_fd = FD_SETSIZE - 1;
  FD_SET(invalid_fd, &readfds);
  timeout.tv_sec = 0;
  timeout.tv_usec = 0;
  errno = 0;
  rc = select(invalid_fd + 1, &readfds, NULL, NULL, &timeout);
  if (rc != -1 || errno != EBADF) {
    char out[128];
    snprintf(out, sizeof(out), "select_regular_fd:bad_invalid:%d:%d", rc, errno);
    emit("select_regular_fd", 1, out, 1, errno);
    return 1;
  }

  emit("select_regular_fd", 0, "select_regular_fd:ok", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "hostname") == 0) return case_hostname();
  if (strcmp(name, "hostname_too_small") == 0) return case_hostname_too_small();
  if (strcmp(name, "loopback_name_to_index") == 0) return case_loopback_name_to_index();
  if (strcmp(name, "missing_name") == 0) return case_missing_name();
  if (strcmp(name, "loopback_index_to_name") == 0) return case_loopback_index_to_name();
  if (strcmp(name, "missing_index") == 0) return case_missing_index();
  if (strcmp(name, "sendfile_zero_count") == 0) return case_sendfile_zero_count();
  if (strcmp(name, "sendfile_bad_fd") == 0) return case_sendfile_bad_fd();
  if (strcmp(name, "chmod_readonly") == 0) return case_chmod_readonly();
  if (strcmp(name, "chown_denied") == 0) return case_chown_denied();
  if (strcmp(name, "identity_kernel") == 0) return case_identity_kernel();
  if (strcmp(name, "cwd_backend") == 0) return case_cwd_backend();
  if (strcmp(name, "realpath_backend") == 0) return case_realpath_backend();
  if (strcmp(name, "ttyname_stdio") == 0) return case_ttyname_stdio();
  if (strcmp(name, "priority_unsupported") == 0) return case_priority_unsupported();
  if (strcmp(name, "fcntl_pipe_status_flags") == 0) return case_fcntl_pipe_status_flags();
  if (strcmp(name, "fcntl_setfl_masks_access_mode") == 0) return case_fcntl_setfl_masks_access_mode();
  if (strcmp(name, "readdir_dot_entries") == 0) return case_readdir_dot_entries();
  if (strcmp(name, "utimes_mtime") == 0) return case_utimes_mtime();
  if (strcmp(name, "poll_regular_fd") == 0) return case_poll_regular_fd();
  if (strcmp(name, "select_regular_fd") == 0) return case_select_regular_fd();
  fprintf(stderr, "posix-runtime-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("hostname");
  puts("hostname_too_small");
  puts("loopback_name_to_index");
  puts("missing_name");
  puts("loopback_index_to_name");
  puts("missing_index");
  puts("sendfile_zero_count");
  puts("sendfile_bad_fd");
  puts("chmod_readonly");
  puts("chown_denied");
  puts("identity_kernel");
  puts("cwd_backend");
  puts("realpath_backend");
  puts("ttyname_stdio");
  puts("priority_unsupported");
  puts("fcntl_pipe_status_flags");
  puts("fcntl_setfl_masks_access_mode");
  puts("readdir_dot_entries");
  puts("utimes_mtime");
  puts("poll_regular_fd");
  puts("select_regular_fd");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    if (case_hostname() != 0) return 1;
    if (case_loopback_name_to_index() != 0) return 1;
    if (case_loopback_index_to_name() != 0) return 1;
    if (case_sendfile_zero_count() != 0) return 1;
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: posix-runtime-canary [--case <name> | --list-cases]\n");
  return 2;
}
