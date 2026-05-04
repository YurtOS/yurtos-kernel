#ifndef YURT_BUSYBOX_COMPAT_SYS_WAIT_H
#define YURT_BUSYBOX_COMPAT_SYS_WAIT_H

#include <sys/types.h>

#ifndef WNOHANG
#define WNOHANG 0x00000001
#endif

#ifndef WUNTRACED
#define WUNTRACED 0x00000002
#endif

#ifndef WEXITSTATUS
#define WEXITSTATUS(status) (((status) >> 8) & 0xff)
#endif

#ifndef WTERMSIG
#define WTERMSIG(status) ((status) & 0x7f)
#endif

#ifndef WSTOPSIG
#define WSTOPSIG(status) WEXITSTATUS(status)
#endif

#ifndef WIFEXITED
#define WIFEXITED(status) (WTERMSIG(status) == 0)
#endif

#ifndef WIFSIGNALED
#define WIFSIGNALED(status) (((signed char)(((status) & 0x7f) + 1) >> 1) > 0)
#endif

#ifndef WIFSTOPPED
#define WIFSTOPPED(status) (((status) & 0xff) == 0x7f)
#endif

#include <errno.h>

/* No child processes in wasi: wait/waitpid return -1/ECHILD. Inline here so
 * the symbol is resolvable by every translation unit that includes this. */
static inline pid_t wait(int *status) { (void)status; errno = ECHILD; return -1; }
static inline pid_t waitpid(pid_t pid, int *status, int options) {
    (void)pid; (void)status; (void)options; errno = ECHILD; return -1;
}
static inline pid_t wait3(int *status, int options, void *rusage) {
    (void)status; (void)options; (void)rusage; errno = ECHILD; return -1;
}
static inline pid_t wait4(pid_t pid, int *status, int options, void *rusage) {
    (void)pid; (void)status; (void)options; (void)rusage; errno = ECHILD; return -1;
}

#endif
