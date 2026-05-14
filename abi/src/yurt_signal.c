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

static struct sigaction yurt_signal_actions[NSIG];
static int yurt_signal_initialized = 0;
static unsigned yurt_alarm_seconds = 0;
static unsigned long long yurt_signal_mask = 0;
static unsigned long long yurt_pending_signal_mask = 0;
static int yurt_delivering_pending_signals = 0;

static int yurt_signal_validate(int sig);
static int yurt_signal_compact_slot(int sig);
static int yurt_sigset_mask_bit(int sig, sigset_t *bit);
static int yurt_signal_default_terminates(int sig);
static void yurt_signal_deliver_pending(void);
static int yurt_raise_now(int sig);
__attribute__((weak)) int yurt_forward_signal_to_exec_child(int sig);

static int yurt_pending_signal_bit(int sig, unsigned long long *bit) {
  if (yurt_signal_validate(sig) != 0) {
    return -1;
  }
  if (sig >= (int)(8 * sizeof(*bit))) {
    errno = EINVAL;
    return -1;
  }

  *bit = 1ull << sig;
  return 0;
}

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

static int yurt_signal_default_terminates(int sig) {
  switch (sig) {
    case SIGHUP:
    case SIGINT:
    case SIGQUIT:
    case SIGILL:
    case SIGTRAP:
    case SIGABRT:
    case SIGBUS:
    case SIGFPE:
    case SIGKILL:
    case SIGUSR1:
    case SIGSEGV:
    case SIGUSR2:
    case SIGPIPE:
    case SIGALRM:
    case SIGTERM:
    case SIGXCPU:
    case SIGXFSZ:
    case SIGVTALRM:
    case SIGIO:
    case SIGPWR:
    case SIGSYS:
      return 1;
    default:
      return 0;
  }
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

sighandler_t signal(int sig, sighandler_t handler) {
  YURT_MARKER_CALL(signal);
  sighandler_t old_handler;

  if (yurt_signal_validate(sig) != 0) {
    return SIG_ERR;
  }

  yurt_signal_init();
  old_handler = yurt_signal_actions[sig].sa_handler;
  yurt_signal_actions[sig].sa_handler = handler;
  memset(&yurt_signal_actions[sig].sa_mask, 0, sizeof(yurt_signal_actions[sig].sa_mask));
  yurt_signal_actions[sig].sa_flags = 0;
  yurt_signal_actions[sig].sa_restorer = NULL;
  return old_handler;
}

int sigaction(int sig, const struct sigaction *restrict act, struct sigaction *restrict oldact) {
  YURT_MARKER_CALL(sigaction);
  if (yurt_signal_validate(sig) != 0) {
    return -1;
  }

  yurt_signal_init();

  if (oldact) {
    *oldact = yurt_signal_actions[sig];
  }
  if (act) {
    yurt_signal_actions[sig] = *act;
  }

  return 0;
}

int sigprocmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset) {
  YURT_MARKER_CALL(sigprocmask);
  yurt_signal_init();

  if (oldset) {
    *oldset = (sigset_t)yurt_signal_mask;
  }
  if (set == NULL) {
    return 0;
  }

  switch (how) {
    case SIG_BLOCK:
      yurt_signal_mask |= (unsigned long long)(*set);
      yurt_signal_deliver_pending();
      return 0;
    case SIG_UNBLOCK:
      yurt_signal_mask &= ~((unsigned long long)(*set));
      yurt_signal_deliver_pending();
      return 0;
    case SIG_SETMASK:
      yurt_signal_mask = (unsigned long long)(*set);
      yurt_signal_deliver_pending();
      return 0;
    default:
      errno = EINVAL;
      return -1;
  }
}

int pthread_sigmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset) {
  YURT_MARKER_CALL(pthread_sigmask);
  return sigprocmask(how, set, oldset);
}

int sigsuspend(const sigset_t *mask) {
  unsigned long long old_mask;
  YURT_MARKER_CALL(sigsuspend);

  yurt_signal_init();
  old_mask = yurt_signal_mask;
  if (mask) {
    yurt_signal_mask = (unsigned long long)(*mask);
  }
  yurt_signal_deliver_pending();
  yurt_host_yield();
  yurt_signal_mask = old_mask;
  yurt_signal_deliver_pending();
  errno = EINTR;
  return -1;
}

int sigtimedwait(
  const sigset_t *restrict set,
  siginfo_t *restrict info,
  const struct timespec *restrict timeout
) {
  YURT_MARKER_CALL(sigsuspend);
  (void)timeout;

  yurt_signal_init();
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }

  for (int sig = 1; sig < NSIG; ++sig) {
    unsigned long long pending_bit;
    sigset_t mask_bit;
    if (yurt_pending_signal_bit(sig, &pending_bit) != 0 ||
        yurt_sigset_mask_bit(sig, &mask_bit) != 0 ||
        ((*set & mask_bit) == 0) ||
        ((yurt_pending_signal_mask & pending_bit) == 0)) {
      continue;
    }

    yurt_pending_signal_mask &= ~pending_bit;
    if (info != NULL) {
      memset(info, 0, sizeof(*info));
      info->si_signo = sig;
    }
    return sig;
  }

  yurt_host_yield();
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
  sighandler_t handler;
  unsigned long long pending_bit;
  sigset_t mask_bit;

  if (yurt_signal_validate(sig) != 0) {
    return -1;
  }

  yurt_signal_init();
  if (yurt_pending_signal_bit(sig, &pending_bit) != 0) {
    return -1;
  }
  if (yurt_sigset_mask_bit(sig, &mask_bit) == 0 &&
      (yurt_signal_mask & (unsigned long long)mask_bit) != 0) {
    yurt_pending_signal_mask |= pending_bit;
    return 0;
  }

  if (yurt_forward_signal_to_exec_child &&
      yurt_forward_signal_to_exec_child(sig)) {
    return 0;
  }

  handler = yurt_signal_actions[sig].sa_handler;

  if (handler == SIG_IGN) {
    return 0;
  }
  if (handler != SIG_DFL && handler != SIG_ERR && handler != NULL) {
    handler(sig);
    return 0;
  }

  if (yurt_signal_default_terminates(sig)) {
    _Exit(128 + sig);
  }

  return 0;
}

static void yurt_signal_deliver_pending(void) {
  if (yurt_delivering_pending_signals) {
    return;
  }

  yurt_delivering_pending_signals = 1;
  for (;;) {
    int delivered = 0;
    for (int sig = 1; sig < NSIG; ++sig) {
      unsigned long long pending_bit;
      sigset_t mask_bit;
      if (yurt_pending_signal_bit(sig, &pending_bit) != 0 ||
          (yurt_pending_signal_mask & pending_bit) == 0) {
        continue;
      }
      if (yurt_sigset_mask_bit(sig, &mask_bit) == 0 &&
          (yurt_signal_mask & (unsigned long long)mask_bit) != 0) {
        continue;
      }
      yurt_pending_signal_mask &= ~pending_bit;
      yurt_raise_now(sig);
      delivered = 1;
      break;
    }
    if (!delivered) break;
  }
  yurt_delivering_pending_signals = 0;
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
