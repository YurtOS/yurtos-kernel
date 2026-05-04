/* resource-canary — exercises getrlimit / setrlimit. */
#include <errno.h>
#include <stdio.h>
#include <sys/resource.h>

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

static int case_setrlimit_accept(void) {
  /* Lowering NOFILE should succeed (we accept-and-ignore). */
  struct rlimit r = { 256, 256 };
  if (setrlimit(RLIMIT_NOFILE, &r) != 0) {
    emit("setrlimit_fail", 1, errno);
    return 1;
  }
  emit("setrlimit", 0, 256);
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

int main(void) {
  int rc = 0;
  rc |= case_nofile();
  rc |= case_setrlimit_accept();
  rc |= case_invalid();
  return rc;
}
