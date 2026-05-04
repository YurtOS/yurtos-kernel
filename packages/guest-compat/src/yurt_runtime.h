#ifndef YURT_RUNTIME_H
#define YURT_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

__attribute__((import_module("yurt"), import_name("host_run_command")))
int yurt_host_run_command(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_dup2")))
int yurt_host_dup2(int src_fd, int dst_fd);

__attribute__((import_module("yurt"), import_name("host_yield")))
void yurt_host_yield(void);

__attribute__((import_module("yurt"), import_name("host_file_lock")))
int yurt_host_file_lock(int fd, int operation);

__attribute__((import_module("yurt"), import_name("host_chmod")))
int yurt_host_chmod(int path_ptr, int path_len, int mode);

__attribute__((import_module("yurt"), import_name("host_chown")))
int yurt_host_chown(int path_ptr, int path_len, int uid, int gid, int follow_symlinks);

__attribute__((import_module("yurt"), import_name("host_fchown")))
int yurt_host_fchown(int fd, int uid, int gid);

__attribute__((import_module("yurt"), import_name("host_network_fetch")))
int yurt_host_network_fetch(int req_ptr, int req_len, int out_ptr, int out_cap);

/* Process identity / signalling — yurt's process kernel owns the
 * sandbox's PID space and tracks parent links and process state.  These
 * imports route guest libc calls (getpid/getppid/kill) to the kernel,
 * so they return real values instead of wasi-libc's stubs. */
__attribute__((import_module("yurt"), import_name("host_getpid")))
int yurt_host_getpid(void);

__attribute__((import_module("yurt"), import_name("host_getppid")))
int yurt_host_getppid(void);

__attribute__((import_module("yurt"), import_name("host_getuid")))
int yurt_host_getuid(void);

__attribute__((import_module("yurt"), import_name("host_geteuid")))
int yurt_host_geteuid(void);

__attribute__((import_module("yurt"), import_name("host_getgid")))
int yurt_host_getgid(void);

__attribute__((import_module("yurt"), import_name("host_getegid")))
int yurt_host_getegid(void);

__attribute__((import_module("yurt"), import_name("host_setresuid")))
int yurt_host_setresuid(int ruid, int euid, int suid);

__attribute__((import_module("yurt"), import_name("host_setresgid")))
int yurt_host_setresgid(int rgid, int egid, int sgid);

__attribute__((import_module("yurt"), import_name("host_umask")))
int yurt_host_umask(int mask);

__attribute__((import_module("yurt"), import_name("host_getcwd")))
int yurt_host_getcwd(int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_chdir")))
int yurt_host_chdir(int path_ptr, int path_len);

__attribute__((import_module("yurt"), import_name("host_fchdir")))
int yurt_host_fchdir(int fd);

__attribute__((import_module("yurt"), import_name("host_getpriority")))
int yurt_host_getpriority(int which, int who);

__attribute__((import_module("yurt"), import_name("host_setpriority")))
int yurt_host_setpriority(int which, int who, int prio);

__attribute__((import_module("yurt"), import_name("host_sched_getscheduler")))
int yurt_host_sched_getscheduler(int pid);

__attribute__((import_module("yurt"), import_name("host_sched_getparam")))
int yurt_host_sched_getparam(int pid);

__attribute__((import_module("yurt"), import_name("host_sched_setscheduler")))
int yurt_host_sched_setscheduler(int pid, int policy, int priority);

__attribute__((import_module("yurt"), import_name("host_sched_setparam")))
int yurt_host_sched_setparam(int pid, int priority);

__attribute__((import_module("yurt"), import_name("host_getrlimit")))
int yurt_host_getrlimit(int resource, void *out);

__attribute__((import_module("yurt"), import_name("host_setrlimit")))
int yurt_host_setrlimit(int resource, unsigned int soft, unsigned int hard);

/* host_kill returns 0 on success, -1 with kill(2)-style ESRCH (no such
 * process) on failure.  sig=0 is the existence probe (no signal sent). */
__attribute__((import_module("yurt"), import_name("host_kill")))
int yurt_host_kill(int pid, int sig);

/* host_pipe creates a pipe and writes JSON `{"read_fd":N,"write_fd":M}`
 * to the output buffer.  Returns the byte count written, or the
 * required size if out_cap was too small.  The 64-byte buffer in
 * pipe()/pipe2() is sized for that JSON shape. */
__attribute__((import_module("yurt"), import_name("host_pipe")))
int yurt_host_pipe(int out_ptr, int out_cap);

/* host_dup duplicates a fd in the caller's table and writes JSON
 * `{"fd":<new_fd>}` to the output buffer.  Returns byte count or -1.
 * dup(2) needs this so we can hand back a fresh kernel-managed fd. */
__attribute__((import_module("yurt"), import_name("host_dup")))
int yurt_host_dup(int fd, int out_ptr, int out_cap);

/* host_spawn synchronously spawns a child WASM process from a JSON
 * SpawnRequest.  Returns the new child's PID, or -1 on failure.
 * Used by posix_spawn / posix_spawnp.  See SpawnRequest in
 * packages/kernel/src/process/kernel.ts for the JSON shape. */
__attribute__((import_module("yurt"), import_name("host_spawn")))
int yurt_host_spawn(int req_ptr, int req_len);

/* host_waitpid blocks until the named child exits and writes JSON
 * `{"exit_code":N}` to the output buffer.  Returns byte count or -1.
 * The kernel wraps this with WebAssembly.Suspending (JSPI) or
 * the asyncify bridge automatically — backend choice is host-wide
 * (wasi2-preempt > JSPI > asyncify), so the C caller just sees a
 * normal blocking call.  Used by waitpid(pid > 0). */
__attribute__((import_module("yurt"), import_name("host_waitpid")))
int yurt_host_waitpid(int pid, int out_ptr, int out_cap);

/* host_waitpid_nohang is the synchronous non-blocking variant.
 * It writes {"pid":N,"exit_code":M} and returns the byte count when
 * a child was reaped, -1 when no child has exited, and -2 for ECHILD. */
__attribute__((import_module("yurt"), import_name("host_waitpid_nohang")))
int yurt_host_waitpid_nohang(int pid, int out_ptr, int out_cap);

/* host_wait_any writes { pid, exit_code } JSON into the output buffer and
 * suspends (JSPI) until a child exits.  Returns bytes written or -1.
 * Used by waitpid(-1, ..., 0) — blocking wait-any. */
__attribute__((import_module("yurt"), import_name("host_wait_any")))
int yurt_host_wait_any(int out_ptr, int out_cap);

/* host_wait_any_nohang writes { pid, exit_code } if a child has already
 * exited, or { pid: 0 } if no child is ready.  Returns bytes written or -1.
 * Used by waitpid(-1, ..., WNOHANG). */
__attribute__((import_module("yurt"), import_name("host_wait_any_nohang")))
int yurt_host_wait_any_nohang(int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_fork")))
int yurt_host_fork(void);

__attribute__((import_module("yurt"), import_name("host_thread_spawn")))
int yurt_host_thread_spawn(int fn_ptr, int arg);

__attribute__((import_module("yurt"), import_name("host_thread_join")))
int yurt_host_thread_join(int tid);

__attribute__((import_module("yurt"), import_name("host_thread_detach")))
int yurt_host_thread_detach(int tid);

__attribute__((import_module("yurt"), import_name("host_thread_self")))
int yurt_host_thread_self(void);

__attribute__((import_module("yurt"), import_name("host_thread_yield")))
int yurt_host_thread_yield(void);

__attribute__((import_module("yurt"), import_name("host_mutex_lock")))
int yurt_host_mutex_lock(int mutex_ptr);

__attribute__((import_module("yurt"), import_name("host_mutex_unlock")))
int yurt_host_mutex_unlock(int mutex_ptr);

__attribute__((import_module("yurt"), import_name("host_mutex_trylock")))
int yurt_host_mutex_trylock(int mutex_ptr);

__attribute__((import_module("yurt"), import_name("host_cond_wait")))
int yurt_host_cond_wait(int cond_ptr, int mutex_ptr);

__attribute__((import_module("yurt"), import_name("host_cond_signal")))
int yurt_host_cond_signal(int cond_ptr);

__attribute__((import_module("yurt"), import_name("host_cond_broadcast")))
int yurt_host_cond_broadcast(int cond_ptr);

__attribute__((import_module("yurt"), import_name("host_socket_open")))
int yurt_host_socket_open(int domain, int type, int protocol);

__attribute__((import_module("yurt"), import_name("host_socket_connect")))
int yurt_host_socket_connect(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_bind")))
int yurt_host_socket_bind(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_listen")))
int yurt_host_socket_listen(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_accept")))
int yurt_host_socket_accept(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_send")))
int yurt_host_socket_send(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_recv")))
int yurt_host_socket_recv(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_addr")))
int yurt_host_socket_addr(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_option")))
int yurt_host_socket_option(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_socket_close")))
int yurt_host_socket_close(int req_ptr, int req_len);

/* host_dns_resolve resolves a hostname to a dotted-decimal IPv4 string and
 * writes it to [out_ptr, out_cap).  Returns bytes written, or -1 on failure.
 * Async (JSPI): the guest blocks until the host DNS lookup completes. */
__attribute__((import_module("yurt"), import_name("host_dns_resolve")))
int yurt_host_dns_resolve(int host_ptr, int host_len, int out_ptr, int out_cap);

const char *yurt_netdb_host_for_addr(uint32_t addr_be);
uint32_t yurt_netdb_addr_for_host(const char *host);

int yurt_json_call(const char *json, char **out, size_t *out_len);

/* Process groups and sessions ─────────────────────────────────────────────
 * host_getpgid / host_setpgid / host_getsid / host_setsid route through
 * the kernel's process table so job-control shells (ash) see real pgroup
 * and session ids rather than the stub value 1. */
__attribute__((import_module("yurt"), import_name("host_getpgid")))
int yurt_host_getpgid(int pid);

__attribute__((import_module("yurt"), import_name("host_setpgid")))
int yurt_host_setpgid(int pid, int pgid);

__attribute__((import_module("yurt"), import_name("host_getsid")))
int yurt_host_getsid(int pid);

__attribute__((import_module("yurt"), import_name("host_setsid")))
int yurt_host_setsid(void);

__attribute__((import_module("yurt"), import_name("host_killpg")))
int yurt_host_killpg(int pgid, int sig);

/* TTY ─────────────────────────────────────────────────────────────────────
 * These bridge libc terminal APIs to the kernel's TTY state so shells can
 * call isatty()/tcgetpgrp()/tcsetpgrp() and get sensible answers. */
__attribute__((import_module("yurt"), import_name("host_isatty")))
int yurt_host_isatty(int fd);

__attribute__((import_module("yurt"), import_name("host_tcgetpgrp")))
int yurt_host_tcgetpgrp(int fd);

__attribute__((import_module("yurt"), import_name("host_tcsetpgrp")))
int yurt_host_tcsetpgrp(int fd, int pgid);

/* host_tcgetattr writes a musl wasm32 termios struct into [out_ptr, out_cap).
 * Returns bytes written, or -1 if fd is not a terminal. */
__attribute__((import_module("yurt"), import_name("host_tcgetattr")))
int yurt_host_tcgetattr(int fd, int out_ptr, int out_cap);

/* host_tcsetattr accepts terminal attribute changes silently.
 * Returns 0 if fd is a terminal, -1 otherwise. */
__attribute__((import_module("yurt"), import_name("host_tcsetattr")))
int yurt_host_tcsetattr(int fd, int actions, int termios_ptr);

/* host_winsize writes a struct winsize { rows, cols, xpix, ypix } into
 * [out_ptr, out_cap).  Returns bytes written, or -1 if not a terminal. */
__attribute__((import_module("yurt"), import_name("host_winsize")))
int yurt_host_winsize(int fd, int out_ptr, int out_cap);

/* host_tiocsctty registers fd as the calling process's controlling terminal.
 * Called by yurt_ioctl when it dispatches TIOCSCTTY.
 * Returns 0 on success, -1 if fd is not a TTY. */
__attribute__((import_module("yurt"), import_name("host_tiocsctty")))
int yurt_host_tiocsctty(int fd);

#endif
