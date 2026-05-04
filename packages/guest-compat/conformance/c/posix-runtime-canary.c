#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sendfile.h>
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

  emit("identity_kernel", 0, "identity_kernel:ok", 0, 0);
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
