/* exec-canary — verify execv/execvp/execve actually replace the
 * caller's exit status with the spawned program's.  Yurt
 * implements exec on top of host_spawn + host_wait + exit,
 * so a successful exec should:
 *   1. spawn the new program (BusyBox `true` — exits 0)
 *   2. wait for it
 *   3. exit with code 0 (the child's status)
 *
 * If any of those steps mis-wires, the canary returns its own
 * exit code (1 or 2 from main below) instead of 0.
 *
 * Tested cases run as separate canary invocations because each
 * exec call replaces the process.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char *argv[]) {
    /* Each test selects a case via argv.  Without args we print the
     * available cases, mimicking the other canaries. */
    if (argc < 2) {
        puts("execv");
        puts("execvp");
        puts("execve");
        puts("execv_enoent");
        puts("execv_eacces");
        return 0;
    }

    const char *casename = argv[1];

    if (strcmp(casename, "execv") == 0) {
        /* execv("true") should exit with code 0.  If it returns to
         * us instead, the exec failed — print the failure marker
         * and exit with a non-zero distinct code so the test driver
         * can tell. */
        char *new_argv[] = { (char *)"true", NULL };
        execv("true", new_argv);
        printf("{\"case\":\"execv\",\"exit\":2,\"errno\":%d}\n", errno);
        return 2;
    }
    if (strcmp(casename, "execvp") == 0) {
        char *new_argv[] = { (char *)"true", NULL };
        execvp("true", new_argv);
        printf("{\"case\":\"execvp\",\"exit\":2,\"errno\":%d}\n", errno);
        return 2;
    }
    if (strcmp(casename, "execve") == 0) {
        char *new_argv[] = { (char *)"true", NULL };
        execve("true", new_argv, environ);
        printf("{\"case\":\"execve\",\"exit\":2,\"errno\":%d}\n", errno);
        return 2;
    }
    if (strcmp(casename, "execv_enoent") == 0) {
        /* execv on a non-existent program should return -1 with
         * errno set, NOT exit. */
        char *new_argv[] = { (char *)"definitely-not-a-program", NULL };
        int rc = execv("definitely-not-a-program", new_argv);
        if (rc == -1 && errno != 0) {
            printf("{\"case\":\"execv_enoent\",\"exit\":0,\"errno\":%d}\n", errno);
            return 0;
        }
        printf("{\"case\":\"execv_enoent\",\"exit\":2,\"errno\":%d}\n", errno);
        return 2;
    }
    if (strcmp(casename, "execv_eacces") == 0) {
        const char *path = "/tmp/yurt-exec-not-executable";
        FILE *f = fopen(path, "w");
        if (!f) {
            printf("{\"case\":\"execv_eacces\",\"exit\":2,\"errno\":%d}\n", errno);
            return 2;
        }
        fputs("not wasm\n", f);
        fclose(f);
        chmod(path, 0644);

        char *new_argv[] = { (char *)path, NULL };
        int rc = execv(path, new_argv);
        if (rc == -1 && errno == EACCES) {
            printf("{\"case\":\"execv_eacces\",\"exit\":0,\"errno\":%d}\n", errno);
            return 0;
        }
        printf("{\"case\":\"execv_eacces\",\"exit\":2,\"errno\":%d}\n", errno);
        return 2;
    }
    fprintf(stderr, "exec-canary: unknown case %s\n", casename);
    return 2;
}
