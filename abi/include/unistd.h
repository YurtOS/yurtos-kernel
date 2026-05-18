#ifndef YURT_COMPAT_UNISTD_H
#define YURT_COMPAT_UNISTD_H

/* Pull in the real wasi-sdk unistd.h.  wasi-libc marks getpid() as
 * deprecated unless _WASI_EMULATED_GETPID is defined. Yurt provides a real
 * getpid() via libyurt_abi (yurt_process.c -> yurt_host_getpid ->
 * kernel.allocPid), so importing the deprecated declaration is misleading.
 * A later redeclaration cannot remove Clang's deprecated attribute, so force
 * wasi-libc's non-deprecated declaration while this overlay includes it. */
#ifndef _WASI_EMULATED_GETPID
#define YURT_DEFINED_WASI_EMULATED_GETPID 1
#define _WASI_EMULATED_GETPID 1
#endif
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#define getpid __yurt_hidden_wasilibc_getpid
#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <unistd.h>
#pragma pop_macro("__wasi__")
#undef getpid
#pragma clang diagnostic pop
#ifdef YURT_DEFINED_WASI_EMULATED_GETPID
#undef _WASI_EMULATED_GETPID
#undef YURT_DEFINED_WASI_EMULATED_GETPID
#endif

#ifdef __cplusplus
extern "C" {
#endif

int dup2(int oldfd, int newfd);
int getgroups(int size, gid_t list[]);

/* pipe(2) — real impl in libyurt_abi.a (yurt_pipe.c)
 * routes through host_pipe to the yurt kernel.  The prototype is
 * exposed unconditionally so callers don't need to negotiate
 * _GNU_SOURCE / _BSD_SOURCE / etc. */
int pipe(int fd[2]);
/* pipe2(2) is a Linux extension — wasi-libc doesn't even declare it.
 * Yurt honors O_CLOEXEC and accepts the other common pipe flags for
 * compatibility. Declared here so HAVE_PIPE2 detection in autoconf-built
 * ports finds the linker symbol. */
int pipe2(int fd[2], int flags);

/* dup(2) and dup3(2) — real impls in libyurt_abi.a
 * (yurt_dup.c) call through to host_dup / host_dup2.  dup3 is a
 * Linux extension that bundles dup2 with O_CLOEXEC; yurt has no
 * exec, so the flag is ignored. */
int dup(int oldfd);
int dup3(int oldfd, int newfd, int flags);
int gethostname(char *name, size_t len);
int isatty(int fd);

/* wasi-libc gates many POSIX entries behind __wasilibc_unmodified_upstream
 * so they are absent on wasm32-wasip1.  The block below restores enough
 * surface for typical guest C/C++ programs to compile and link.  Real
 * impls (getpid/getppid/kill) come from libyurt_abi;
 * everything else is honest no-op-or-ENOSYS so callers can detect the
 * gap and degrade gracefully. */

#ifndef __wasilibc_unmodified_upstream

#include <errno.h>
#include <sys/types.h>

/* dup/dup3 are also declared above the wasilibc gate (next to pipe/
 * pipe2) since they have real impls in libyurt_abi.a. */

/* chown family / fchdir — wasi-libc has none of these, but gnulib
 * REPLACE_* probes link-test for them and will compile its own
 * replacement if the symbol is missing.  Static inline definitions
 * collide with gnulib's replacement at compile time, so we ship real
 * symbols in libyurt_abi.a (yurt_fs.c) — gnulib then
 * accepts ours and skips its own.  Sandbox semantics: chown family
 * routes through the host/kernel ownership checks; fchdir/chroot return
 * ENOSYS. */
int chown(const char *path, uid_t owner, gid_t group);
int lchown(const char *path, uid_t owner, gid_t group);
int fchown(int fd, uid_t owner, gid_t group);
int fchdir(int fd);
int chdir(const char *path);
char *getcwd(char *buf, size_t size);
int chroot(const char *path);

/* fork / vfork — wasm has no fork(); both return -1/ENOSYS.  Real
 * symbols in libyurt_abi.a (yurt_process.c) so
 * BusyBox + autoconf-built ports' link probes find them.  Autoconf
 * ports that detect neither fork nor vfork emit `#define vfork fork`
 * in config.h; that's harmless because both forward to the same
 * impl.  When autoconf DOES detect them (because configure links
 * the compat archive), the macro doesn't fire.
 *
 * exec family — replace the calling process image with a new program.
 * Yurt's emulation: spawn the new program (host_spawn), wait for
 * it (host_wait), exit with its status — the caller's wasm
 * instance never resumes, semantically equivalent to a real exec
 * for the fork+exec+wait pattern.  Real impls in yurt_exec.c.
 * The l-form variadic helpers below are still inline; they delegate
 * to execv / execvp. */
pid_t fork(void) __attribute__((returns_twice));
pid_t vfork(void) __attribute__((returns_twice));
int execv(const char *path, char *const argv[]);
int execvp(const char *file, char *const argv[]);
int execve(const char *path, char *const argv[], char *const envp[]);

#include <stdarg.h>
#define YURT_EXEC_MAX_ARGS 64

static inline int execl(const char *path, const char *arg0, ...) {
    const char *argv_local[YURT_EXEC_MAX_ARGS + 1];
    int n = 0;
    argv_local[n++] = arg0;
    va_list ap;
    va_start(ap, arg0);
    const char *a;
    while (n <= YURT_EXEC_MAX_ARGS && (a = va_arg(ap, const char *)) != NULL) {
        argv_local[n++] = a;
    }
    va_end(ap);
    argv_local[n] = NULL;
    return execv(path, (char *const *)argv_local);
}

static inline int execlp(const char *file, const char *arg0, ...) {
    const char *argv_local[YURT_EXEC_MAX_ARGS + 1];
    int n = 0;
    argv_local[n++] = arg0;
    va_list ap;
    va_start(ap, arg0);
    const char *a;
    while (n <= YURT_EXEC_MAX_ARGS && (a = va_arg(ap, const char *)) != NULL) {
        argv_local[n++] = a;
    }
    va_end(ap);
    argv_local[n] = NULL;
    return execvp(file, (char *const *)argv_local);
}

static inline int execle(const char *path, const char *arg0, ...) {
    /* execle: arg0, ..., NULL, envp.  Walk the va_list, build argv up to
     * the NULL, then take the next va_arg as envp. */
    const char *argv_local[YURT_EXEC_MAX_ARGS + 1];
    int n = 0;
    argv_local[n++] = arg0;
    va_list ap;
    va_start(ap, arg0);
    const char *a;
    while (n <= YURT_EXEC_MAX_ARGS && (a = va_arg(ap, const char *)) != NULL) {
        argv_local[n++] = a;
    }
    argv_local[n] = NULL;
    char *const *envp = va_arg(ap, char *const *);
    va_end(ap);
    return execve(path, (char *const *)argv_local, envp);
}

/* Process tree introspection — getpid()/getppid() are provided by
 * libyurt_abi (yurt_process.c) and route through real
 * kernel state.  Re-declare here without the wasi-libc deprecation
 * attribute so static-inline callers below don't emit warnings. */
extern pid_t getpid(void);
extern pid_t getppid(void);

/* Process group / session APIs — real symbols in libyurt_abi.a
 * (yurt_process.c).  The kernel owns process groups, sessions, and
 * foreground TTY state; exports remain real symbols so autoconf link
 * probes detect them and gnulib doesn't compile redundant replacements. */
pid_t setsid(void);
pid_t getsid(pid_t pid);
pid_t getpgrp(void);
pid_t getpgid(pid_t pid);
int   setpgid(pid_t pid, pid_t pgid);
pid_t setpgrp(void);
pid_t tcgetpgrp(int fd);
int   tcsetpgrp(int fd, pid_t pgrp);

/* uid/gid accessors and mutators — real symbols in libyurt_abi.a
 * (yurt_fs.c).  The yurt process kernel owns credentials and authorization
 * checks use the caller's effective uid/gid at the host boundary. */
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
int setuid(uid_t uid);
int seteuid(uid_t uid);
int setgid(gid_t gid);
int setegid(gid_t gid);
int setresuid(uid_t r, uid_t e, uid_t s);
int setresgid(gid_t r, gid_t e, gid_t s);

#ifndef L_cuserid
#define L_cuserid 32
#endif
char *cuserid(char *s);

/* ttyname_r: POSIX requires ENOTTY when fd isn't a terminal.  We
 * defer to isatty() (which wasi-libc implements via fdstat) and
 * synthesize a name when the fd IS a tty.  The sandbox doesn't have
 * a real tty device path, but "/dev/tty" is the conventional answer
 * and matches what stdio expects. */
static inline int ttyname_r(int fd, char *buf, size_t buflen) {
    if (!buf || buflen == 0) return EINVAL;
    if (!isatty(fd)) return ENOTTY;
    static const char tty[] = "/dev/tty";
    if (buflen < sizeof(tty)) return ERANGE;
    for (size_t i = 0; i < sizeof(tty); i++) buf[i] = tty[i];
    return 0;
}

static inline char *ttyname(int fd) {
    static char tty[sizeof("/dev/tty")];
    int rc = ttyname_r(fd, tty, sizeof(tty));
    if (rc != 0) {
        errno = rc;
        return NULL;
    }
    return tty;
}

/* Process groups / sessions are real symbols above; nothing to declare here. */

/* sethostname() — wasi-libc has gethostname but not the setter.  Stub
 * to ENOSYS so callers see the failure; the sandbox hostname is
 * effectively read-only from the guest's perspective. */
static inline int sethostname(const char *name, size_t len) {
    (void)name; (void)len; errno = ENOSYS; return -1;
}

/* Some C code out there guards `#include <sys/sysinfo.h>` behind
 * `#ifdef __linux__` (or relies on the glibc convenience of getting
 * it transitively through unistd.h) and then uses `struct sysinfo`
 * unconditionally — fine on Linux, broken on every other platform.
 * Pulling sysinfo.h here makes the declarations visible regardless
 * of whether the consumer remembered the include.  The actual impl
 * lives in libyurt_abi (yurt_sysinfo.c). */
#include <sys/sysinfo.h>

/* kill() is declared in <signal.h> in POSIX, but many programs reach
 * for it via <unistd.h> include paths.  Bring it in here so callers
 * see the prototype either way; the body lives in
 * libyurt_abi (yurt_process.c). */
#include <signal.h>
extern int kill(pid_t pid, int sig);
extern int killpg(pid_t pgrp, int sig);

/* Default guest user exposed by the kernel for normal processes. */
#define YURT_DEFAULT_UID ((uid_t)1000)
#define YURT_DEFAULT_GID ((gid_t)1000)

/* waitpid/wait: stubbed in sys/wait.h. */

/* sync — POSIX no-op: the kernel's in-memory ramfs has no buffer
 * cache to flush. POSIX defines sync(2) as void; nothing to validate. */
static inline void sync(void) {}

/* syncfs — Linux extension. The kernel's METHOD_SYS_SYNCFS (issue #88)
 * gates on fd validity AND fd type: EBADF for closed / unknown fds,
 * EINVAL for pipe / socket (non-syncable) fds. Mirror both gates here
 * via fstat — fcntl(F_GETFD) succeeds on pipes and sockets so the
 * earlier probe under-rejected. Proper kernel routing via a dedicated
 * host_syncfs import is a follow-up. */
#include <sys/stat.h>
static inline int syncfs(int fd) {
    struct stat _st;
    if (fstat(fd, &_st) < 0) return -1; /* EBADF / errno already set */
    if (S_ISFIFO(_st.st_mode) || S_ISSOCK(_st.st_mode)) {
        errno = EINVAL;
        return -1;
    }
    return 0;
}

/* pause() — suspend until a signal is delivered; real impl in yurt_signal.c */
int pause(void);

/* nice() — adjust process priority; real impl in yurt_fs.c via
 * getpriority/setpriority. */
int nice(int inc);

#endif /* !__wasilibc_unmodified_upstream */

#ifdef __cplusplus
}
#endif

#endif /* YURT_COMPAT_UNISTD_H */
