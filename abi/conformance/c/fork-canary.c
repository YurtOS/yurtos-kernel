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
extern char **environ;
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

static int expect_child_exec_after_fork(void) {
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "fork failed errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        char *child_argv[] = { "true", NULL };
        execve("/usr/bin/true", child_argv, environ);
        fprintf(stderr, "child execve failed errno=%d\n", errno);
        _exit(111);
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid) {
        fprintf(stderr, "waitpid returned %ld for child %ld errno=%d\n", (long)waited, (long)pid, errno);
        return 2;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child exec status mismatch: raw=%d\n", status);
        return 3;
    }

    puts("fork-child-exec-ok");
    return 0;
}

static pid_t wrapped_fork(void) {
    return fork();
}

static int expect_wrapped_fork_parent_continues(void) {
    pid_t pid = wrapped_fork();
    if (pid < 0) {
        fprintf(stderr, "wrapped fork failed errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        puts("wrapped-child");
        _exit(0);
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid) {
        fprintf(stderr, "waitpid returned %ld for child %ld errno=%d\n", (long)waited, (long)pid, errno);
        return 2;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "wrapped child status mismatch: raw=%d\n", status);
        return 3;
    }

    puts("wrapped-parent");
    return 0;
}

static int expect_pipe_synced_fork_parent_continues(void) {
    int fds[2];
    if (pipe(fds) != 0) {
        fprintf(stderr, "pipe failed errno=%d\n", errno);
        return 1;
    }

    pid_t pid = wrapped_fork();
    if (pid < 0) {
        fprintf(stderr, "wrapped fork failed errno=%d\n", errno);
        return 2;
    }
    if (pid == 0) {
        close(fds[0]);
        const char msg[] = "ready";
        if (write(fds[1], msg, sizeof(msg)) != (ssize_t)sizeof(msg)) _exit(4);
        close(fds[1]);
        puts("pipe-child");
        _exit(0);
    }

    close(fds[1]);
    char buf[sizeof("ready")];
    ssize_t n = read(fds[0], buf, sizeof(buf));
    close(fds[0]);
    if (n != (ssize_t)sizeof(buf) || memcmp(buf, "ready", sizeof(buf)) != 0) {
        fprintf(stderr, "parent read sync failed n=%ld errno=%d\n", (long)n, errno);
        return 3;
    }

    int status = 0;
    pid_t waited = waitpid(pid, &status, 0);
    if (waited != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "pipe child status mismatch waited=%ld raw=%d errno=%d\n", (long)waited, status, errno);
        return 4;
    }

    puts("pipe-parent");
    return 0;
}

static int expect_wait_any_after_fork(void) {
    pid_t pid = wrapped_fork();
    if (pid < 0) {
        fprintf(stderr, "wrapped fork failed errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        puts("wait-any-child");
        _exit(0);
    }

    int status = 0;
    pid_t waited = waitpid(-1, &status, 0);
    if (waited != pid || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "wait-any mismatch waited=%ld child=%ld raw=%d errno=%d\n", (long)waited, (long)pid, status, errno);
        return 2;
    }

    puts("wait-any-parent");
    return 0;
}
#endif

static int usage(const char *argv0) {
    fprintf(stderr, "usage: %s [--case default-enosys|continuation-split|child-longjmp-prefork|child-nested-longjmp-prefork|child-wait-longjmp-prefork|child-exec|wrapped-fork|pipe-synced-fork|wait-any]\n", argv0);
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
    if (strcmp(name, "child-exec") == 0) return expect_child_exec_after_fork();
    if (strcmp(name, "wrapped-fork") == 0) return expect_wrapped_fork_parent_continues();
    if (strcmp(name, "pipe-synced-fork") == 0) return expect_pipe_synced_fork_parent_continues();
    if (strcmp(name, "wait-any") == 0) return expect_wait_any_after_fork();
#endif
    return usage(argv[0]);
}
