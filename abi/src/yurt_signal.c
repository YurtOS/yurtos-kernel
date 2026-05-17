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
YURT_DECLARE_MARKER(sigaltstack);
YURT_DECLARE_MARKER(sigtimedwait);
YURT_DECLARE_MARKER(pause);

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
YURT_DEFINE_MARKER(sigaltstack,  0x73616c74u) /* salt */
YURT_DEFINE_MARKER(sigtimedwait, 0x73747764u) /* stwd */
YURT_DEFINE_MARKER(pause,        0x70617573u) /* paus */

#ifndef NSIG
#define NSIG 64
#endif

static struct sigaction yurt_signal_actions[NSIG];
static int yurt_signal_initialized = 0;
static unsigned yurt_alarm_seconds = 0;
static unsigned long long yurt_signal_mask = 0;
static unsigned long long yurt_pending_signal_mask = 0;
static int yurt_signal_validate(int sig);
static int yurt_signal_compact_slot(int sig);
static int yurt_sigset_mask_bit(int sig, sigset_t *bit);
static int yurt_signal_default_terminates(int sig);
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
  /* Marshal 6-byte request: i32 how (4 LE) + u8 has_set + u8 set */
  unsigned char req[6];
  unsigned int how_u = (unsigned int)how;
  req[0] = (unsigned char)(how_u & 0xffu);
  req[1] = (unsigned char)((how_u >> 8) & 0xffu);
  req[2] = (unsigned char)((how_u >> 16) & 0xffu);
  req[3] = (unsigned char)((how_u >> 24) & 0xffu);
  req[4] = (unsigned char)(set != NULL ? 1 : 0);
  req[5] = (unsigned char)(set != NULL ? *set : 0u);
  /* 1-byte response buffer for the prior mask */
  unsigned char resp[1] = { 0 };
  int64_t rc = yurt_host_sigprocmask(
    (int)(intptr_t)req, (int)sizeof(req),
    (int)(intptr_t)resp, (int)sizeof(resp));
  if (rc < 0) {
    errno = (int)(-rc);
    return -1;
  }
  if (oldset != NULL) {
    *oldset = (sigset_t)resp[0];
  }
  return 0;
}

int pthread_sigmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset) {
  YURT_MARKER_CALL(pthread_sigmask);
  return sigprocmask(how, set, oldset);
}

int sigsuspend(const sigset_t *mask) {
  YURT_MARKER_CALL(sigsuspend);
  /* Marshal 2-byte request: u8 has_mask + u8 mask */
  unsigned char req[2];
  req[0] = (unsigned char)(mask != NULL ? 1 : 0);
  req[1] = (unsigned char)(mask != NULL ? *mask : 0u);
  int64_t rc = yurt_host_sigsuspend((int)(intptr_t)req, (int)sizeof(req));
  errno = (int)(-rc); /* kernel always returns -EINTR */
  return -1;
}

int sigaltstack(const stack_t *restrict ss, stack_t *restrict oss) {
  YURT_MARKER_CALL(sigaltstack);
  /* Marshal 13-byte request: u8 has_ss + u32 sp + i32 flags + u32 size (all LE) */
  unsigned char req[13];
  req[0] = (unsigned char)(ss != NULL ? 1 : 0);
  uint32_t sp    = (ss != NULL) ? (uint32_t)(uintptr_t)ss->ss_sp : 0u;
  int32_t  flags = (ss != NULL) ? ss->ss_flags : 0;
  uint32_t size  = (ss != NULL) ? (uint32_t)ss->ss_size : 0u;
  req[1] = (unsigned char)(sp & 0xffu);
  req[2] = (unsigned char)((sp >> 8) & 0xffu);
  req[3] = (unsigned char)((sp >> 16) & 0xffu);
  req[4] = (unsigned char)((sp >> 24) & 0xffu);
  uint32_t fv;
  memcpy(&fv, &flags, 4);
  req[5] = (unsigned char)(fv & 0xffu);
  req[6] = (unsigned char)((fv >> 8) & 0xffu);
  req[7] = (unsigned char)((fv >> 16) & 0xffu);
  req[8] = (unsigned char)((fv >> 24) & 0xffu);
  req[9]  = (unsigned char)(size & 0xffu);
  req[10] = (unsigned char)((size >> 8) & 0xffu);
  req[11] = (unsigned char)((size >> 16) & 0xffu);
  req[12] = (unsigned char)((size >> 24) & 0xffu);
  /* 12-byte response: u32 sp + i32 flags + u32 size (LE) */
  unsigned char resp[12];
  memset(resp, 0, sizeof(resp));
  int64_t rc = yurt_host_sigaltstack(
    (int)(intptr_t)req, (int)sizeof(req),
    (int)(intptr_t)resp, (int)sizeof(resp));
  if (rc < 0) {
    errno = (int)(-rc);
    return -1;
  }
  if (oss != NULL) {
    uint32_t resp_sp, resp_size;
    int32_t  resp_flags;
    memcpy(&resp_sp,    resp + 0, 4);
    memcpy(&resp_flags, resp + 4, 4);
    memcpy(&resp_size,  resp + 8, 4);
    oss->ss_sp    = (void *)(uintptr_t)resp_sp;
    oss->ss_flags = (int)resp_flags;
    oss->ss_size  = (size_t)resp_size;
  }
  return 0;
}

int sigtimedwait(
  const sigset_t *restrict set,
  siginfo_t *restrict info,
  const struct timespec *restrict timeout
) {
  YURT_MARKER_CALL(sigtimedwait);
  if (set == NULL) {
    errno = EINVAL;
    return -1;
  }
  /* Marshal 18-byte request: u8 set + u8 has_timeout + i64 tv_sec + i64 tv_nsec */
  unsigned char req[18];
  req[0] = *set;
  req[1] = (unsigned char)(timeout != NULL ? 1 : 0);
  /* tv_sec as i64 LE at offset 2 */
  int64_t tv_sec = (timeout != NULL) ? (int64_t)timeout->tv_sec : 0;
  int64_t tv_nsec = (timeout != NULL) ? (int64_t)timeout->tv_nsec : 0;
  unsigned char *p = req + 2;
  uint64_t sv;
  memcpy(&sv, &tv_sec, 8);
  p[0] = (unsigned char)(sv & 0xffu);
  p[1] = (unsigned char)((sv >> 8) & 0xffu);
  p[2] = (unsigned char)((sv >> 16) & 0xffu);
  p[3] = (unsigned char)((sv >> 24) & 0xffu);
  p[4] = (unsigned char)((sv >> 32) & 0xffu);
  p[5] = (unsigned char)((sv >> 40) & 0xffu);
  p[6] = (unsigned char)((sv >> 48) & 0xffu);
  p[7] = (unsigned char)((sv >> 56) & 0xffu);
  p = req + 10;
  memcpy(&sv, &tv_nsec, 8);
  p[0] = (unsigned char)(sv & 0xffu);
  p[1] = (unsigned char)((sv >> 8) & 0xffu);
  p[2] = (unsigned char)((sv >> 16) & 0xffu);
  p[3] = (unsigned char)((sv >> 24) & 0xffu);
  p[4] = (unsigned char)((sv >> 32) & 0xffu);
  p[5] = (unsigned char)((sv >> 40) & 0xffu);
  p[6] = (unsigned char)((sv >> 48) & 0xffu);
  p[7] = (unsigned char)((sv >> 56) & 0xffu);
  /* 16-byte response: { i32 si_signo, i32 si_code, u32 si_pid, i32 si_value } (LE) */
  unsigned char resp[16];
  memset(resp, 0, sizeof(resp));
  int64_t rc = yurt_host_sigtimedwait(
    (int)(intptr_t)req, (int)sizeof(req),
    (int)(intptr_t)resp, (int)sizeof(resp));
  if (rc < 0) {
    errno = (int)(-rc);
    return -1;
  }
  if (info != NULL) {
    memset(info, 0, sizeof(*info));
    /* Kernel 16-byte siginfo layout (dispatch/process.rs sigwaitinfo):
     *   byte  0..4  i32 si_signo
     *   byte  4..8  i32 si_code  (SI_QUEUE = -1)
     *   byte  8..12 u32 si_pid   (sender_pid)
     *   byte 12..16 i32 si_value (sival_int; no si_value field in this siginfo_t)
     * All little-endian. */
    int32_t v;
    memcpy(&v, resp + 0, 4); info->si_signo = (int)v;
    memcpy(&v, resp + 4, 4); info->si_code  = (int)v;
    memcpy(&v, resp + 8, 4); info->si_pid   = (pid_t)v;
    /* si_value (resp+12): this siginfo_t lacks si_value; stored in si_status
     * as a best-effort substitute until the struct gains the sigval union. */
    memcpy(&v, resp + 12, 4); info->si_status = (int)v;
  }
  /* returns the accepted signal number */
  int32_t yurt_st_signo;
  memcpy(&yurt_st_signo, resp, 4);
  return (int)yurt_st_signo;
}

int pause(void) {
  YURT_MARKER_CALL(pause);
  /* pause = sigsuspend with has_mask=0 (kernel keeps current mask) */
  unsigned char req[2] = { 0, 0 };
  int64_t rc = yurt_host_sigsuspend((int)(intptr_t)req, (int)sizeof(req));
  errno = (int)(-rc); /* kernel always returns -EINTR */
  return -1;
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
