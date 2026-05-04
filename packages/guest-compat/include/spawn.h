#ifndef YURT_COMPAT_SPAWN_H
#define YURT_COMPAT_SPAWN_H

/* POSIX-1.2001 process-creation API.  wasi-sdk doesn't ship spawn.h
 * because WASI lacks fork/exec primitives — but yurt's process
 * kernel exposes a `host_spawn` import that creates a child WASM
 * instance with caller-resolved file descriptors, which is exactly
 * the effect posix_spawn is supposed to deliver.
 *
 * We expose the full POSIX surface here.  The opaque
 * posix_spawn_file_actions_t / posix_spawnattr_t hold an internal
 * pointer (plus padding for ABI margin); init/destroy manage the
 * heap state.  Supported file actions: addopen, adddup2, addclose,
 * addchdir_np.  Supported attr knobs: setflags / getflags (others
 * are accepted-and-ignored — yurt has no signal mask, no scheduling
 * priority, no setpgroup story, so the runtime is the source of
 * truth and per-spawn knobs would be misleading). */

#include <stddef.h>
#include <sys/types.h>
#include <sched.h>
#include <signal.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque handles.  Internal layout:
 *     __priv   pointer to a malloc'd state block
 *     __pad    reserved for ABI growth
 * Callers MUST treat these as opaque and only manipulate them via the
 * functions below. */
typedef struct {
  void *__priv;
  long  __pad[15];
} posix_spawn_file_actions_t;

typedef struct {
  void *__priv;
  long  __pad[7];
} posix_spawnattr_t;

/* posix_spawn flags (POSIX-defined constants).  Yurt accepts all
 * of them but only POSIX_SPAWN_USEVFORK is meaningful (it's a no-op
 * because we don't fork).  The others (sigmask, sigdef, schedparam,
 * scheduler, resetids, setpgroup) are stored in the attr but not
 * acted on — we have a single-thread, single-process-group sandbox. */
#define POSIX_SPAWN_RESETIDS      0x01
#define POSIX_SPAWN_SETPGROUP     0x02
#define POSIX_SPAWN_SETSIGDEF     0x04
#define POSIX_SPAWN_SETSIGMASK    0x08
#define POSIX_SPAWN_SETSCHEDPARAM 0x10
#define POSIX_SPAWN_SETSCHEDULER  0x20
#define POSIX_SPAWN_USEVFORK      0x40
#define POSIX_SPAWN_SETSID        0x80

/* ── Spawn calls ── */

int posix_spawn(pid_t *__restrict pid,
                const char *__restrict path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *__restrict attrp,
                char *const argv[__restrict],
                char *const envp[__restrict]);

int posix_spawnp(pid_t *__restrict pid,
                 const char *__restrict file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *__restrict attrp,
                 char *const argv[__restrict],
                 char *const envp[__restrict]);

/* ── File actions ── */

int posix_spawn_file_actions_init(posix_spawn_file_actions_t *fa);
int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *fa);

int posix_spawn_file_actions_addopen(posix_spawn_file_actions_t *fa,
                                     int fd,
                                     const char *path,
                                     int oflag,
                                     mode_t mode);
int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *fa, int fd);
int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *fa,
                                     int fd, int newfd);
int posix_spawn_file_actions_addchdir_np(posix_spawn_file_actions_t *fa,
                                         const char *path);

/* ── Attributes ── */

int posix_spawnattr_init(posix_spawnattr_t *attr);
int posix_spawnattr_destroy(posix_spawnattr_t *attr);

int posix_spawnattr_getflags(const posix_spawnattr_t *__restrict attr,
                             short *__restrict flags);
int posix_spawnattr_setflags(posix_spawnattr_t *attr, short flags);

int posix_spawnattr_getpgroup(const posix_spawnattr_t *__restrict attr,
                              pid_t *__restrict pgroup);
int posix_spawnattr_setpgroup(posix_spawnattr_t *attr, pid_t pgroup);

int posix_spawnattr_getsigmask(const posix_spawnattr_t *__restrict attr,
                               sigset_t *__restrict sigmask);
int posix_spawnattr_setsigmask(posix_spawnattr_t *__restrict attr,
                               const sigset_t *__restrict sigmask);

int posix_spawnattr_getsigdefault(const posix_spawnattr_t *__restrict attr,
                                  sigset_t *__restrict sigdefault);
int posix_spawnattr_setsigdefault(posix_spawnattr_t *__restrict attr,
                                  const sigset_t *__restrict sigdefault);

int posix_spawnattr_getschedparam(const posix_spawnattr_t *__restrict attr,
                                  struct sched_param *__restrict schedparam);
int posix_spawnattr_setschedparam(posix_spawnattr_t *__restrict attr,
                                  const struct sched_param *__restrict schedparam);

int posix_spawnattr_getschedpolicy(const posix_spawnattr_t *__restrict attr,
                                   int *__restrict schedpolicy);
int posix_spawnattr_setschedpolicy(posix_spawnattr_t *attr, int schedpolicy);

#ifdef __cplusplus
}
#endif

#endif
