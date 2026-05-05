#ifndef YURT_COMPAT_SYS_WAIT_H
#define YURT_COMPAT_SYS_WAIT_H

/* POSIX <sys/wait.h> — wasi-libc doesn't ship one because WASI has
 * no traditional wait/waitpid model.  Yurt's process kernel does
 * track child PIDs (host_waitpid is async; host_waitpid_nohang is
 * sync), but exposing them under the standard libc names requires
 * a compat shim that we haven't wired yet (it would need a sync
 * polling loop or JSPI suspending from a sync libc call site).
 *
 * For the purposes of building POSIX C code that compiles regardless
 * of whether wait/waitpid actually work, we expose:
 *   - the W* macros for parsing exit status integers (pure
 *     bitfield operations, no syscalls)
 *   - WNOHANG / WUNTRACED / WCONTINUED option flags
 *   - wait/waitpid prototypes that return -1/ECHILD at runtime —
 *     posix_spawn'd children are reaped via host_waitpid_nohang
 *     elsewhere, not through this header
 *
 * Programs that do not actually call wait()/waitpid() at runtime
 * (the common case after `--disable-*` flags strip decompressor
 * pipelines and similar fork-using paths) will compile and link
 * with no observable issue.
 */

#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Exit-status parsing macros — pure bit-field math.  Same encoding
 * Linux uses: low byte = signal (0 if exited), bits 8-15 = exit code.
 * The yurt kernel reports exit codes directly via host_waitpid;
 * tools that need the W* macros (mostly to compose status ints) get
 * the right behaviour for synthetic statuses too. */
#define WNOHANG    1
#define WUNTRACED  2
#define WSTOPPED   2
#define WEXITED    4
#define WCONTINUED 8
#define WNOWAIT    0x01000000

#define WEXITSTATUS(s)  (((s) & 0xff00) >> 8)
#define WTERMSIG(s)     ((s) & 0x7f)
#define WSTOPSIG(s)     WEXITSTATUS(s)
#define WIFEXITED(s)    (WTERMSIG(s) == 0)
#define WIFSIGNALED(s)  (((s) & 0x7f) > 0 && ((s) & 0x7f) < 0x7f)
#define WIFSTOPPED(s)   (((s) & 0xff) == 0x7f)
#define WIFCONTINUED(s) ((s) == 0xffff)
#define WCOREDUMP(s)    ((s) & 0x80)

/* wait(2) / waitpid(2) — declared but not currently routed through
 * the yurt kernel (posix_spawn returns the child PID, and tools
 * that need to wait can poll via implementation-defined paths).
 * Both return -1 with errno = ECHILD at runtime via libyurt_abi. */
pid_t wait(int *wstatus);
pid_t waitpid(pid_t pid, int *wstatus, int options);

/* wait3/wait4 — BSD extensions; real impls in yurt_process.c wrap waitpid. */
#include <sys/resource.h>
pid_t wait3(int *wstatus, int options, struct rusage *rusage);
pid_t wait4(pid_t pid, int *wstatus, int options, struct rusage *rusage);

#ifdef __cplusplus
}
#endif

#endif
