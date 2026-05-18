#include <signal.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(signal);
YURT_DECLARE_MARKER(sigaction);
YURT_DECLARE_MARKER(raise);
YURT_DECLARE_MARKER(alarm);
YURT_DECLARE_MARKER(sigemptyset);
YURT_DECLARE_MARKER(sigfillset);
YURT_DECLARE_MARKER(sigaddset);
YURT_DECLARE_MARKER(sigdelset);
YURT_DECLARE_MARKER(sigismember);
YURT_DECLARE_MARKER(sigprocmask);
YURT_DECLARE_MARKER(pthread_sigmask);
YURT_DECLARE_MARKER(sigsuspend);

YURT_DEFINE_MARKER(signal,       0x73676e6cu) /* sgnl */
YURT_DEFINE_MARKER(sigaction,    0x73676163u) /* sgac */
YURT_DEFINE_MARKER(raise,        0x72616973u) /* rais */
YURT_DEFINE_MARKER(alarm,        0x616c726du) /* alrm */
YURT_DEFINE_MARKER(sigemptyset,  0x73656d70u) /* semp */
YURT_DEFINE_MARKER(sigfillset,   0x7366696cu) /* sfil */
YURT_DEFINE_MARKER(sigaddset,    0x73616464u) /* sadd */
YURT_DEFINE_MARKER(sigdelset,    0x7364656cu) /* sdel */
YURT_DEFINE_MARKER(sigismember,  0x7369736du) /* sism */
YURT_DEFINE_MARKER(sigprocmask,  0x7370726du) /* sprm */
YURT_DEFINE_MARKER(pthread_sigmask, 0x70736d6bu) /* psmk */
YURT_DEFINE_MARKER(sigsuspend,   0x73737370u) /* sssp */

#ifndef NSIG
#define NSIG 64
#endif

/* Execution-only handler registry.  The kernel owns mask/pending/disposition;
 * this array stores only the function pointer (or SIG_DFL/SIG_IGN) the guest
 * passed through sigaction/signal so that yurt_raise_now can dispatch it when
 * the kernel says action=RUN_HANDLER.  sa_mask and sa_flags in these entries
 * are NOT consulted for any masking decision. */
static struct sigaction yurt_signal_actions[NSIG];
static int yurt_signal_initialized = 0;
static unsigned yurt_alarm_seconds = 0;

static int yurt_signal_compact_slot(int sig);
static int yurt_sigset_mask_bit(int sig, sigset_t *bit);
static int yurt_signal_validate(int sig);
static int yurt_raise_now(int sig);
__attribute__((weak)) int yurt_forward_signal_to_exec_child(int sig);

static int yurt_signal_compact_slot(int sig) {
  switch (sig) {
    case SIGHUP: return 0;
    case SIGINT: return 1;
    case SIGQUIT: return 2;
    case SIGTERM: return 3;
    case SIGCHLD: return 4;
    case SIGWINCH: return 5;
    case SIGPIPE: return 6;
    case SIGUSR1:
    case SIGUSR2:
    case SIGALRM:
      return 7;
    default:
      errno = EINVAL;
      return -1;
  }
}

static int yurt_sigset_mask_bit(int sig, sigset_t *bit) {
  int slot;

  if (yurt_signal_validate(sig) != 0) {
    return -1;
  }

  slot = yurt_signal_compact_slot(sig);
  if (slot < 0) {
    return -1;
  }

  *bit = (sigset_t)(1u << slot);
  return 0;
}

static void yurt_signal_init(void) {
  if (yurt_signal_initialized) {
    return;
  }

  for (int i = 0; i < NSIG; ++i) {
    memset(&yurt_signal_actions[i], 0, sizeof(yurt_signal_actions[i]));
    yurt_signal_actions[i].sa_handler = SIG_DFL;
  }

  yurt_signal_initialized = 1;
}

static int yurt_signal_validate(int sig) {
  if (sig <= 0 || sig >= NSIG) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int sigemptyset(sigset_t *set) {
  YURT_MARKER_CALL(sigemptyset);
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  *set = 0;
  return 0;
}

int sigfillset(sigset_t *set) {
  YURT_MARKER_CALL(sigfillset);
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  *set = ~(sigset_t)0;
  return 0;
}

int sigaddset(sigset_t *set, int sig) {
  YURT_MARKER_CALL(sigaddset);
  sigset_t bit;

  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sigset_mask_bit(sig, &bit) != 0) {
    return -1;
  }

  *set |= bit;
  return 0;
}

int sigdelset(sigset_t *set, int sig) {
  YURT_MARKER_CALL(sigdelset);
  sigset_t bit;

  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sigset_mask_bit(sig, &bit) != 0) {
    return -1;
  }

  *set &= ~bit;
  return 0;
}

int sigismember(const sigset_t *set, int sig) {
  YURT_MARKER_CALL(sigismember);
  sigset_t bit;

  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (yurt_sigset_mask_bit(sig, &bit) != 0) {
    return -1;
  }

  return (*set & bit) != 0;
}

/* Shared helper: route one sigaction registration/query through the kernel.
 * sig: the signal number.
 * has_act: 1 = set the disposition (handler/mask/flags are live),
 *          0 = pure query (POSIX sigaction(_,NULL,&old)); the kernel
 *          MUST NOT mutate state — handler/mask/flags are don't-care.
 * handler: the sa_handler value cast to unsigned (don't-care if has_act==0).
 * mask: sa_mask as u64 (the kernel does compact<->canonical remap).
 * flags: sa_flags as unsigned.
 * oldact_out: if non-NULL, the prior kernel state is decoded into it.
 * Returns 0 on success, negative errno on failure (kernel convention). */
static int yurt_kernel_sigaction(int sig, int has_act, unsigned handler,
                                 unsigned long long mask, unsigned flags,
                                 struct sigaction *oldact_out) {
  unsigned char req[21];
  unsigned char resp[16];
  int rc;

  /* Pack req: u32 sig | u8 has_act | u32 handler | u64 sa_mask | u32 sa_flags (LE) */
  { unsigned u = (unsigned)sig;    memcpy(req + 0,  &u, 4); }
  { req[4] = (unsigned char)(has_act ? 1 : 0); }
  {                                memcpy(req + 5,  &handler, 4); }
  {                                memcpy(req + 9,  &mask, 8); }
  {                                memcpy(req + 17, &flags, 4); }

  rc = yurt_host_sigaction((int)(uintptr_t)req, 21,
                           (int)(uintptr_t)resp, 16);
  if (rc < 0) {
    return rc;  /* negative errno */
  }

  if (oldact_out != NULL) {
    unsigned prev_handler;
    unsigned long long prev_mask;
    unsigned prev_flags;
    memcpy(&prev_handler, resp + 0,  4);
    memcpy(&prev_mask,    resp + 4,  8);
    memcpy(&prev_flags,   resp + 12, 4);
    /* Use .sa_handler through the macro (expands to .__sa_handler.sa_handler). */
    oldact_out->sa_handler =
        (sighandler_t)(uintptr_t)prev_handler;
    /* Compact sigset_t is 1 byte; take the low byte of the kernel's u64. */
    oldact_out->sa_mask = (sigset_t)(prev_mask & 0xFFu);
    oldact_out->sa_flags = (int)prev_flags;
    oldact_out->sa_restorer = NULL;
  }

  return 0;
}

sighandler_t signal(int sig, sighandler_t handler) {
  YURT_MARKER_CALL(signal);
  sighandler_t old;
  int rc;

  if (yurt_signal_validate(sig) != 0) {
    return SIG_ERR;
  }

  yurt_signal_init();
  old = yurt_signal_actions[sig].sa_handler;
  rc = yurt_kernel_sigaction(sig, 1,
                             (unsigned)(uintptr_t)handler,
                             0ULL, 0U, NULL);
  if (rc < 0) {
    errno = -rc;
    return SIG_ERR;
  }

  /* Update execution-only registry. */
  yurt_signal_actions[sig].sa_handler = handler;
  return old;
}

int sigaction(int sig, const struct sigaction *restrict act,
              struct sigaction *restrict oldact) {
  YURT_MARKER_CALL(sigaction);
  unsigned handler;
  unsigned long long mask;
  unsigned flags;
  int rc;

  if (yurt_signal_validate(sig) != 0) {
    return -1;
  }

  yurt_signal_init();

  if (act != NULL) {
    handler = (unsigned)(uintptr_t)act->sa_handler;
    mask    = (unsigned long long)act->sa_mask;
    flags   = (unsigned)act->sa_flags;
  } else {
    /* Pure-query (act==NULL): POSIX sigaction(_,NULL,&old) MUST NOT
     * modify the disposition. has_act=0 makes the kernel a pure query;
     * do NOT read the guest-cached handler (that would reintroduce
     * guest-side signal state, the #90 defect class). The fields are
     * don't-care to the kernel — pass 0. */
    handler = 0U;
    mask    = 0ULL;
    flags   = 0U;
  }

  rc = yurt_kernel_sigaction(sig, act != NULL ? 1 : 0, handler, mask, flags,
                             oldact ? oldact : NULL);
  if (rc < 0) {
    errno = -rc;
    return -1;
  }

  /* Update execution-only registry only when a new action was set. */
  if (act != NULL) {
    yurt_signal_actions[sig].sa_handler = act->sa_handler;
  }

  return 0;
}

int sigprocmask(int how, const sigset_t *restrict set,
                sigset_t *restrict oldset) {
  YURT_MARKER_CALL(sigprocmask);
  yurt_signal_init();

  if (how != SIG_BLOCK && how != SIG_UNBLOCK && how != SIG_SETMASK) {
    errno = EINVAL;
    return -1;
  }

  /* Pack req: i32 how | u8 has_set | u8 set_byte  (6 bytes total) */
  unsigned char req[6];
  unsigned char out[1];
  { int h = how; memcpy(req, &h, 4); }
  req[4] = set ? 1 : 0;
  req[5] = set ? (unsigned char)*set : 0;

  int rc = yurt_host_sigprocmask((int)(uintptr_t)req, 6,
                                 (int)(uintptr_t)out, 1);
  if (rc < 0) {
    errno = -rc;
    return -1;
  }

  if (oldset) {
    *oldset = (sigset_t)out[0];
  }

  return 0;
}

int pthread_sigmask(int how, const sigset_t *restrict set,
                    sigset_t *restrict oldset) {
  YURT_MARKER_CALL(pthread_sigmask);
  return sigprocmask(how, set, oldset);
}

int sigsuspend(const sigset_t *mask) {
  YURT_MARKER_CALL(sigsuspend);
  yurt_signal_init();

  /* SETMASK to *mask, capturing old; query; restore old; yield; EINTR. */
  unsigned char req[6];
  unsigned char out[1];
  int how = SIG_SETMASK;  /* = 2 */
  memcpy(req, &how, 4);
  req[4] = mask ? 1 : 0;
  req[5] = mask ? (unsigned char)*mask : 0;
  int rc_set = yurt_host_sigprocmask((int)(uintptr_t)req, 6,
                                     (int)(uintptr_t)out, 1);
  if (rc_set < 0) {
    /* Could not enter the suspend mask: nothing was changed, nothing to
       restore, and `out` is unwritten — do NOT read it. */
    errno = -rc_set;
    return -1;
  }
  unsigned char old = out[0];   /* defined: SETMASK succeeded */

  /* Probe for a deliverable signal (gate-deferred: do not act on it in B). */
  unsigned char q[1];
  (void)yurt_host_signal_query((int)(uintptr_t)q, 1);

  /* Best-effort restore of the prior mask (we DID change it above). */
  int how2 = SIG_SETMASK;  /* = 2 */
  memcpy(req, &how2, 4);
  req[4] = 1;
  req[5] = old;
  (void)yurt_host_sigprocmask((int)(uintptr_t)req, 6, (int)(uintptr_t)out, 1);

  yurt_host_yield();   /* anti-CPU-spin */
  errno = EINTR;
  return -1;
}

/*
 * (B) gated stub: kernel sys_sigwaitinfo uses a canonical set; guest
 * sigset_t is 1-byte compact and the guest does no signo math (#90).
 * Real accept is a consumer/(C) slice.  Deliberately inert — no host
 * import is called, the mask is not touched.
 */
int sigtimedwait(
  const sigset_t *restrict set,
  siginfo_t *restrict info,
  const struct timespec *restrict timeout
) {
  YURT_MARKER_CALL(sigsuspend);   /* sigtimedwait has no dedicated marker in this (B) slice; reusing sigsuspend's is intentional — revisit when sigtimedwait is promoted in a (C)/consumer slice. */
  (void)set; (void)info; (void)timeout;
  yurt_host_yield();   /* anti-CPU-spin */
  errno = EAGAIN;
  return -1;
}

int pause(void) {
  sigset_t mask;
  sigprocmask(SIG_SETMASK, NULL, &mask);
  return sigsuspend(&mask);
}

static int yurt_raise_now(int sig) {
  YURT_MARKER_CALL(raise);
  if (yurt_signal_validate(sig) != 0) {
    return -1;
  }

  yurt_signal_init();

  unsigned char req[4];
  { unsigned u = (unsigned)sig; memcpy(req, &u, 4); }
  unsigned char resp[8];
  int rc = yurt_host_signal_raise((int)(uintptr_t)req, 4,
                                  (int)(uintptr_t)resp, 8);
  if (rc < 0) {
    errno = -rc;
    return -1;
  }

  int action;
  unsigned token;
  memcpy(&action, resp,     4);
  memcpy(&token,  resp + 4, 4);

  /* NONE: kernel pended-because-blocked or discarded-SIG_IGN.
   * Return immediately — do NOT forward to exec-child. */
  if (action == 0) {
    return 0;
  }

  /* For all non-NONE verdicts: attempt exec-child forward first. */
  if (yurt_forward_signal_to_exec_child &&
      yurt_forward_signal_to_exec_child(sig)) {
    return 0;
  }

  switch (action) {
    case 1: /* RUN_HANDLER */ {
      sighandler_t h = (sighandler_t)(uintptr_t)token;
      if (h && h != SIG_IGN && h != SIG_DFL && h != SIG_ERR) {
        h(sig);
      }
      return 0;
    }
    case 2: /* DFL_TERMINATE */
      _Exit(128 + sig);
    case 3: /* DFL_STOP */
      return 0;   /* interim no-op (real stop = (C)/job-control slice) */
    case 4: /* DFL_CONT */
      return 0;   /* interim no-op */
    default:
      return 0;
  }
}

int raise(int sig) {
  return yurt_raise_now(sig);
}

unsigned alarm(unsigned seconds) {
  YURT_MARKER_CALL(alarm);
  unsigned previous = yurt_alarm_seconds;
  yurt_alarm_seconds = seconds;
  return previous;
}

int yurt_deliver_signal(int sig) {
  return raise(sig);
}
