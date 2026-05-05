#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int fork_memory_probe = 17;

static int expect_default_enosys(void) {
    errno = 0;
    pid_t pid = fork();
    if (pid != (pid_t)-1 || errno != ENOSYS) {
        fprintf(stderr, "expected fork -1/ENOSYS, got pid=%ld errno=%d\n", (long)pid, errno);
        return 1;
    }
    puts("fork-default-enosys");
    return 0;
}

static int expect_continuation_split(void) {
    pid_t parent_pid = getpid();
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "fork failed errno=%d\n", errno);
        return 1;
    }

    if (pid == 0) {
        if (getppid() != parent_pid) {
            fprintf(stderr, "child saw ppid=%ld expected=%ld\n", (long)getppid(), (long)parent_pid);
            return 2;
        }
        fork_memory_probe = 42;
        return 7;
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid) {
        fprintf(stderr, "waitpid returned %ld for child %ld errno=%d\n", (long)waited, (long)pid, errno);
        return 3;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 7) {
        fprintf(stderr, "child status mismatch: raw=%d\n", status);
        return 4;
    }
    if (fork_memory_probe != 17) {
        fprintf(stderr, "parent memory changed to %d\n", fork_memory_probe);
        return 5;
    }

    printf("fork-ok child=%ld parent=%ld\n", (long)pid, (long)parent_pid);
    return 0;
}

static int usage(const char *argv0) {
    fprintf(stderr, "usage: %s [--case default-enosys|continuation-split]\n", argv0);
    return 2;
}

int main(int argc, char **argv) {
    const char *name = "continuation-split";
    if (argc == 3 && strcmp(argv[1], "--case") == 0) {
        name = argv[2];
    } else if (argc != 1) {
        return usage(argv[0]);
    }

    if (strcmp(name, "default-enosys") == 0) return expect_default_enosys();
    if (strcmp(name, "continuation-split") == 0) return expect_continuation_split();
    return usage(argv[0]);
}
