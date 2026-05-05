/* spawn-wait-canary — end-to-end test of posix_spawn + waitpid.
 *
 * Spawns a child via posix_spawnp("true"), then blocks in waitpid()
 * until the child exits.  This exercises the full async path:
 *   posix_spawn  → host_spawn (sync)
 *   waitpid      → host_waitpid (async, JSPI-wrapped or asyncify)
 *
 * The kernel's host scheduler (wasi-2-preempt > JSPI > asyncify)
 * is what makes the C caller see waitpid as a normal blocking call —
 * the choice is host-wide and orthogonal to setjmp/longjmp.
 *
 * Expected: the child exits with code 0 (`true` always returns 0),
 * waitpid returns the child's pid, status decodes as WIFEXITED with
 * WEXITSTATUS == 0.
 */
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void emit(const char *case_name, int exit_code, int v) {
    printf("{\"case\":\"%s\",\"exit\":%d,\"v\":%d}\n", case_name, exit_code, v);
}

int main(void) {
    pid_t child = -1;
    char *const argv[] = { "true", NULL };

    /* posix_spawn the child.  /usr/bin/true is the BusyBox `true`
     * applet under yurt's default userland — exits with code 0. */
    int rc = posix_spawnp(&child, "true", NULL, NULL, argv, environ);
    if (rc != 0 || child < 0) {
        emit("spawn_fail", 1, rc);
        return 1;
    }
    emit("spawn", 0, (int)child);

    /* Block via waitpid → host_waitpid.  The async host import is
     * wrapped at instantiation time; from C this just blocks. */
    int status = 0;
    pid_t reaped = waitpid(child, &status, 0);
    if (reaped != child) {
        emit("wait_wrong_pid", 1, (int)reaped);
        return 1;
    }
    if (!WIFEXITED(status)) {
        emit("not_exited", 1, status);
        return 1;
    }
    if (WEXITSTATUS(status) != 0) {
        emit("nonzero_exit", 1, WEXITSTATUS(status));
        return 1;
    }
    emit("waitpid", 0, WEXITSTATUS(status));

    /* POSIX says re-waiting a reaped child returns ECHILD.  Our
     * kernel doesn't currently mark reaped entries, so the second
     * call returns the cached exit code again — wrong, but harmless
     * for tools that wait once per child (the common case).  Adding
     * reap tracking is a follow-up; not exercised here. */

    return 0;
}
