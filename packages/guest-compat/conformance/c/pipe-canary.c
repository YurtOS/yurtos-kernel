/* pipe-canary — exercises pipe(2), pipe2(2), dup(2), dup3(2).
 * Validates the symbols compile, link, and route through the yurt
 * kernel (host_pipe / host_dup) returning sensible fd values. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

static void emit(const char *case_name, int exit_code, int v) {
  printf("{\"case\":\"%s\",\"exit\":%d,\"v\":%d}\n", case_name, exit_code, v);
}

static int case_pipe(void) {
  int fds[2] = { -1, -1 };
  if (pipe(fds) != 0) { emit("pipe_fail", 1, errno); return 1; }
  if (fds[0] < 0 || fds[1] < 0 || fds[0] == fds[1]) {
    emit("pipe_bad_fds", 1, fds[0] | (fds[1] << 16));
    return 1;
  }
  close(fds[0]);
  close(fds[1]);
  emit("pipe", 0, 0);
  return 0;
}

static int case_pipe2(void) {
  int fds[2] = { -1, -1 };
  /* O_CLOEXEC is the canonical pipe2 flag; yurt accepts and
   * ignores it (no exec()). */
  if (pipe2(fds, O_CLOEXEC) != 0) { emit("pipe2_fail", 1, errno); return 1; }
  if (fds[0] < 0 || fds[1] < 0) { emit("pipe2_bad_fds", 1, 0); return 1; }
  close(fds[0]);
  close(fds[1]);
  emit("pipe2", 0, 0);
  return 0;
}

static int case_dup(void) {
  int fds[2];
  if (pipe(fds) != 0) { emit("dup_pipe_fail", 1, errno); return 1; }
  int copy = dup(fds[0]);
  if (copy < 0 || copy == fds[0]) { emit("dup_bad_fd", 1, copy); return 1; }
  close(fds[0]);
  close(fds[1]);
  close(copy);
  emit("dup", 0, 0);
  return 0;
}

static int case_dup3_invalid(void) {
  /* Linux dup3 rejects oldfd == newfd with EINVAL — verify our
   * error path. */
  errno = 0;
  if (dup3(1, 1, 0) >= 0 || errno != EINVAL) {
    emit("dup3_should_einval", 1, errno);
    return 1;
  }
  emit("dup3_einval", 0, 0);
  return 0;
}

int main(void) {
  int rc = 0;
  rc |= case_pipe();
  rc |= case_pipe2();
  rc |= case_dup();
  rc |= case_dup3_invalid();
  return rc;
}
