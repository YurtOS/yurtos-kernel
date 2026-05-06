#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#if YURT_FORK_CANARY_CONTINUATION
#include <setjmp.h>
#endif

static int fork_memory_probe = 17;
#if YURT_FORK_CANARY_CONTINUATION
static jmp_buf fork_jump;
static jmp_buf fork_nested_top;
static jmp_buf fork_nested_func;
static jmp_buf fork_wait_top;
#endif

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

#if YURT_FORK_CANARY_CONTINUATION
static int expect_child_longjmp_to_prefork_handler(void) {
    int rc = setjmp(fork_jump);
    if (rc != 0) {
        _exit(rc);
    }

    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "fork failed errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        longjmp(fork_jump, 9);
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid) {
        fprintf(stderr, "waitpid returned %ld for child %ld errno=%d\n", (long)waited, (long)pid, errno);
        return 2;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 9) {
        fprintf(stderr, "child longjmp status mismatch: raw=%d\n", status);
        return 3;
    }

    puts("fork-child-longjmp-ok");
    return 0;
}

static int simulated_function_exit(void) {
    int rc = setjmp(fork_nested_func);
    if (rc != 0) {
        return rc;
    }
    longjmp(fork_nested_func, 7);
}

static int expect_child_nested_longjmp_to_prefork_handler(void) {
    int rc = setjmp(fork_nested_top);
    if (rc != 0) {
        _exit(rc);
    }

    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "fork failed errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        if (simulated_function_exit() != 0) {
            longjmp(fork_nested_top, 11);
        }
        _exit(12);
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid) {
        fprintf(stderr, "waitpid returned %ld for child %ld errno=%d\n", (long)waited, (long)pid, errno);
        return 2;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 11) {
        fprintf(stderr, "child nested longjmp status mismatch: raw=%d\n", status);
        return 3;
    }

    puts("fork-child-nested-longjmp-ok");
    return 0;
}

static int expect_child_wait_then_longjmp_to_prefork_handler(void) {
    int rc = setjmp(fork_wait_top);
    if (rc != 0) {
        _exit(rc);
    }

    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "fork failed errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        pid_t grandchild = fork();
        if (grandchild < 0) _exit(2);
        if (grandchild == 0) _exit(0);
        int status = 0;
        while (waitpid(grandchild, &status, 0) != grandchild) {
            if (errno != EINTR) _exit(3);
        }
        longjmp(fork_wait_top, 13);
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid) {
        fprintf(stderr, "waitpid returned %ld for child %ld errno=%d\n", (long)waited, (long)pid, errno);
        return 4;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 13) {
        fprintf(stderr, "child wait+longjmp status mismatch: raw=%d\n", status);
        return 5;
    }

    puts("fork-child-wait-longjmp-ok");
    return 0;
}
#endif

static int usage(const char *argv0) {
    fprintf(stderr, "usage: %s [--case default-enosys|continuation-split|child-longjmp-prefork|child-nested-longjmp-prefork|child-wait-longjmp-prefork]\n", argv0);
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
#if YURT_FORK_CANARY_CONTINUATION
    if (strcmp(name, "child-longjmp-prefork") == 0) return expect_child_longjmp_to_prefork_handler();
    if (strcmp(name, "child-nested-longjmp-prefork") == 0) return expect_child_nested_longjmp_to_prefork_handler();
    if (strcmp(name, "child-wait-longjmp-prefork") == 0) return expect_child_wait_then_longjmp_to_prefork_handler();
#endif
    return usage(argv[0]);
}
