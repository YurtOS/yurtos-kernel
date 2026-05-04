#ifndef YURT_COMPAT_SIGNAL_H
#define YURT_COMPAT_SIGNAL_H

#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>

#if !defined(__wasilibc___typedef_sigset_t_h) && !defined(__DEFINED_sigset_t)
/* Matches wasi-libc's current placeholder typedef (share/wasi-sysroot/
 * include/__typedef_sigset_t.h: `typedef unsigned char sigset_t;`).
 * Widening here would corrupt the stack of any caller compiled against
 * the canonical wasi-libc typedef (every Rust program hits that path via
 * libc-crate's `pub type sigset_t = c_uchar`, and their `zeroed::<sigset_t>`
 * allocates only one byte).  Keeping the 1-byte encoding limits
 * sigaddset/sigdelset to signals 0..7; conformance cases only use
 * signals within that range for that reason. */
typedef unsigned char sigset_t;
#define __DEFINED_sigset_t
#endif

typedef void (*sighandler_t)(int);

#if !defined(__DEFINED_sig_atomic_t)
typedef int sig_atomic_t;
#define __DEFINED_sig_atomic_t
#endif

/* POSIX-standard signal numbers, matching the values in
 * wasi-sysroot/include/wasm32-wasip1/bits/signal.h.  The full set is
 * exposed unconditionally — wasi-sdk gates these behind
 * _WASI_EMULATED_SIGNAL, but on yurt the runtime always provides
 * minimal signal semantics (SIGTERM via host_kill, etc.), so guest
 * code that just references the constants doesn't need to negotiate
 * an opt-in flag. */
#define SIGHUP 1
#define SIGINT 2
#define SIGQUIT 3
#define SIGILL 4
#define SIGTRAP 5
#define SIGABRT 6
#define SIGIOT SIGABRT
#define SIGBUS 7
#define SIGFPE 8
#define SIGKILL 9
#define SIGUSR1 10
#define SIGSEGV 11
#define SIGUSR2 12
#define SIGPIPE 13
#define SIGALRM 14
#define SIGTERM 15
#define SIGCHLD 17
#define SIGCONT 18
#define SIGSTOP 19
#define SIGTSTP 20
#define SIGTTIN 21
#define SIGTTOU 22
#define SIGURG 23
#define SIGXCPU 24
#define SIGXFSZ 25
#define SIGVTALRM 26

/* NSIG / _NSIG: highest-signal-number + 1, used for iteration and for
 * sizing tables.  Linux's 65 (32 classic + 32 RT + 1) reflects RT-
 * signal support.  Yurt has no RT signals (no signal queueing,
 * no dynamic SIGRTMIN/MAX), and gnulib's signal.h `verify_NSIG_constraint`
 * statically requires NSIG ≤ 32.  We pick 32 — the largest value gnulib
 * accepts and the natural ceiling for our classic-only signal set. */
#ifndef NSIG
#define NSIG 32
#endif
#ifndef _NSIG
#define _NSIG NSIG
#endif

#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2

#define SA_RESTART 0x10000000
#define SA_ONSTACK 0x08000000
#define SA_NODEFER 0x40000000

#define SIG_DFL ((sighandler_t)(intptr_t)0)
#define SIG_IGN ((sighandler_t)(intptr_t)-2)
#define SIG_ERR ((sighandler_t)(intptr_t)-1)

/* gnulib's signal.h replacement re-defines `struct sigaction` if
 * `GNULIB_defined_struct_sigaction` isn't set.  Setting it here means
 * gnulib accepts our layout — yurt's signal model is simpler than
 * gnulib's anyway (no real-time signals, no SA_SIGINFO siginfo), so
 * the struct shape we ship is sufficient for what gnulib actually
 * uses at compile time. */
#define GNULIB_defined_struct_sigaction 1

struct sigaction {
  union {
    sighandler_t sa_handler;
    void (*sa_sigaction)(int, void *, void *);
  } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};

#define sa_handler __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction

int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);

sighandler_t signal(int sig, sighandler_t handler);
int sigaction(int sig, const struct sigaction *restrict act, struct sigaction *restrict oldact);
int sigprocmask(int how, const sigset_t *restrict set, sigset_t *restrict oldset);
int sigsuspend(const sigset_t *mask);
int raise(int sig);
unsigned alarm(unsigned seconds);

#endif
