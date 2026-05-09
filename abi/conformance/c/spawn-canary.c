/* spawn-canary — verifies the posix_spawn(3) family compiles and
 * links against libyurt_abi.  Exercises the file-actions
 * and attr APIs at minimum (init/destroy + each setter).  We don't
 * actually spawn a child here because the canary is run standalone
 * (no kernel host imports wired up); link-time presence of all
 * symbols is the objective.
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>

static void emit(const char *case_name, int exit_code) {
  printf("{\"case\":\"%s\",\"exit\":%d}\n", case_name, exit_code);
}

static int case_file_actions(void) {
  posix_spawn_file_actions_t fa;
  if (posix_spawn_file_actions_init(&fa) != 0) { emit("fa_init_fail", 1); return 1; }
  if (posix_spawn_file_actions_addopen(&fa, 1, "/tmp/out", 0, 0) != 0) { emit("fa_addopen_fail", 1); return 1; }
  if (posix_spawn_file_actions_addclose(&fa, 5) != 0) { emit("fa_addclose_fail", 1); return 1; }
  if (posix_spawn_file_actions_adddup2(&fa, 3, 7) != 0) { emit("fa_adddup2_fail", 1); return 1; }
  if (posix_spawn_file_actions_addchdir_np(&fa, "/tmp") != 0) { emit("fa_addchdir_fail", 1); return 1; }
  if (posix_spawn_file_actions_destroy(&fa) != 0) { emit("fa_destroy_fail", 1); return 1; }
  emit("file_actions", 0);
  return 0;
}

static int case_attrs(void) {
  posix_spawnattr_t at;
  if (posix_spawnattr_init(&at) != 0) { emit("attr_init_fail", 1); return 1; }

  if (posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSIGMASK) != 0) { emit("attr_setflags_fail", 1); return 1; }
  short flags = 0;
  if (posix_spawnattr_getflags(&at, &flags) != 0 || flags != POSIX_SPAWN_SETSIGMASK) {
    emit("attr_getflags_fail", 1); return 1;
  }

  pid_t pg = 42;
  if (posix_spawnattr_setpgroup(&at, pg) != 0) { emit("attr_setpgroup_fail", 1); return 1; }
  pid_t pg_out = 0;
  if (posix_spawnattr_getpgroup(&at, &pg_out) != 0 || pg_out != 42) {
    emit("attr_getpgroup_fail", 1); return 1;
  }

  sigset_t set;
  sigemptyset(&set);
  if (posix_spawnattr_setsigmask(&at, &set) != 0) { emit("attr_setsigmask_fail", 1); return 1; }
  if (posix_spawnattr_setsigdefault(&at, &set) != 0) { emit("attr_setsigdefault_fail", 1); return 1; }

  if (posix_spawnattr_destroy(&at) != 0) { emit("attr_destroy_fail", 1); return 1; }
  emit("attrs", 0);
  return 0;
}

static int case_open_errno(void) {
  posix_spawn_file_actions_t fa;
  pid_t pid = -1;
  char *argv[] = { "missing-open", NULL };
  if (posix_spawn_file_actions_init(&fa) != 0) { emit("open_errno_init_fail", 1); return 1; }
  if (posix_spawn_file_actions_addopen(&fa, 7, "/tmp/does-not-exist-for-spawn", O_RDONLY, 0) != 0) {
    emit("open_errno_addopen_fail", 1);
    return 1;
  }
  errno = 0;
  int rc = posix_spawn(&pid, "missing-open", &fa, NULL, argv, NULL);
  int saved_errno = errno;
  if (posix_spawn_file_actions_destroy(&fa) != 0) { emit("open_errno_destroy_fail", 1); return 1; }
  if (rc != ENOENT || saved_errno != ENOENT) {
    emit("open_errno_fail", 1);
    return 1;
  }
  emit("open_errno", 0);
  return 0;
}

int main(void) {
  int rc = 0;
  rc |= case_file_actions();
  rc |= case_attrs();
  rc |= case_open_errno();
  return rc;
}
