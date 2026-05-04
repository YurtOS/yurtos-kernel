/* execv / execvp / execve — POSIX process-image replacement.
 *
 * wasm has no native process-replacement primitive; the WASI
 * `process-replace` proposal isn't standardized.  Yurt's process
 * kernel does have host_spawn (used by posix_spawn) and host_waitpid,
 * which together can emulate exec semantics:
 *
 *   1. spawn the new program with the caller's current stdin/stdout/
 *      stderr fds and environment
 *   2. wait for it to exit
 *   3. exit with its exit code
 *
 * The caller process never resumes.  This is functionally equivalent
 * to a real exec for any program that fits the
 * "fork-then-exec-then-wait" pattern (which is the common one).  The
 * differences from a real exec are bookkeeping:
 *
 * - getpid() in the new program returns a NEW pid (not the caller's).
 *   Real exec preserves pid; we don't.  Programs that rely on pid
 *   continuity across exec (uncommon outside daemonization tricks)
 *   will see the discontinuity.
 * - The caller's wasm instance is still around in memory until the
 *   child exits; in real exec, the caller's image is gone immediately.
 *   For the sandbox this means slightly higher peak memory; semantically
 *   transparent.
 *
 * On failure (program not found, spawn rejected, etc.) exec returns
 * -1 with errno set, mirroring POSIX.
 */

#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <errno.h>
#include <spawn.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

YURT_DECLARE_MARKER(execv);
YURT_DECLARE_MARKER(execvp);
YURT_DECLARE_MARKER(execve);

YURT_DEFINE_MARKER(execv,  0x65786376u) /* "excv" */
YURT_DEFINE_MARKER(execvp, 0x65786370u) /* "excp" */
YURT_DEFINE_MARKER(execve, 0x65786365u) /* "exce" */

extern char **environ;

/* Spawn `prog` with `argv` and `envp`, wait for it, exit with its
 * status code.  On any failure before the exit, return -1 with errno
 * set to ENOENT (closest portable match for "couldn't run that"). */
static int exec_via_spawn(const char *prog, char *const argv[], char *const envp[]) {
  if (!prog || !argv) {
    errno = EFAULT;
    return -1;
  }
  pid_t child = -1;
  int rc = posix_spawnp(&child, prog, /*file_actions=*/NULL, /*attrp=*/NULL,
                        argv, envp ? envp : environ);
  if (rc != 0 || child < 0) {
    errno = ENOENT;
    return -1;
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child) {
    /* Child spawned but couldn't be reaped — surface as a generic
     * exec failure.  In practice this path is rare. */
    errno = ECHILD;
    return -1;
  }
  /* Mirror the child's exit status, just like a successful exec
   * would: the caller process disappears and only the child's exit
   * remains visible to the parent of the caller. */
  if (WIFEXITED(status)) {
    exit(WEXITSTATUS(status));
  } else if (WIFSIGNALED(status)) {
    /* Signal-terminated child: encode the same way a real shell
     * would (128 + signum), since we can't actually re-raise the
     * signal in the sandbox. */
    exit(128 + WTERMSIG(status));
  }
  exit(0);
  /* Unreachable. */
  return 0;
}

int execv(const char *path, char *const argv[]) {
  YURT_MARKER_CALL(execv);
  return exec_via_spawn(path, argv, environ);
}

int execvp(const char *file, char *const argv[]) {
  YURT_MARKER_CALL(execvp);
  /* Same as execv for yurt: the kernel's tool registry IS our
   * "PATH" — there's no per-directory search. */
  return exec_via_spawn(file, argv, environ);
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  YURT_MARKER_CALL(execve);
  return exec_via_spawn(path, argv, envp);
}
