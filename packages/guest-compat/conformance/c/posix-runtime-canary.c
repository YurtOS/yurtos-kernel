#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdio.h>
#include <string.h>
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

static int run_case(const char *name) {
  if (strcmp(name, "hostname") == 0) return case_hostname();
  if (strcmp(name, "hostname_too_small") == 0) return case_hostname_too_small();
  if (strcmp(name, "loopback_name_to_index") == 0) return case_loopback_name_to_index();
  if (strcmp(name, "missing_name") == 0) return case_missing_name();
  if (strcmp(name, "loopback_index_to_name") == 0) return case_loopback_index_to_name();
  if (strcmp(name, "missing_index") == 0) return case_missing_index();
  if (strcmp(name, "sendfile_zero_count") == 0) return case_sendfile_zero_count();
  if (strcmp(name, "sendfile_bad_fd") == 0) return case_sendfile_bad_fd();
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
