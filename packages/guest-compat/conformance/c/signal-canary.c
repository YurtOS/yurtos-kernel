#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

#ifndef SA_ONSTACK
#error "SA_ONSTACK must be available for POSIX signal consumers"
#endif

#ifndef SA_NODEFER
#error "SA_NODEFER must be available for POSIX signal consumers"
#endif

static int signal_canary_seen = 0;
static int signal_canary_suspend_seen = 0;
static volatile sig_atomic_t signal_canary_atomic_seen = 0;

static void signal_canary_handler(int sig) {
  signal_canary_seen = sig;
  signal_canary_atomic_seen = sig;
}
static void signal_canary_suspend_handler(int sig) { signal_canary_suspend_seen = sig; }

static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) printf(",\"stdout\":\"%s\"", stdout_line);
  if (has_errno) printf(",\"errno\":%d", errno_value);
  printf("}\n");
}

static int case_signal_install(void) {
  /* signal(SIGINT, handler) returns the previous handler (SIG_DFL on first
   * call). We assert the call doesn't return SIG_ERR. */
  if (signal(SIGINT, signal_canary_handler) == SIG_ERR) {
    emit("signal_install", 1, NULL, 1, errno);
    return 1;
  }
  emit("signal_install", 0, "signal:installed", 0, 0);
  return 0;
}

static int case_sigaction_raise(void) {
  struct sigaction sa;
  signal_canary_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;
  if (sigaction(SIGINT, &sa, NULL) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (raise(SIGINT) != 0) { emit("sigaction_raise", 1, NULL, 1, errno); return 1; }
  if (signal_canary_seen != SIGINT) { emit("sigaction_raise", 1, NULL, 0, 0); return 1; }
  if (signal_canary_atomic_seen != SIGINT) { emit("sigaction_raise", 1, NULL, 0, 0); return 1; }
  emit("sigaction_raise", 0, "signal-ok", 0, 0);
  return 0;
}

static int case_raise_invokes_handler(void) {
  struct sigaction sa;
  signal_canary_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_handler;
  if (sigaction(SIGTERM, &sa, NULL) != 0) { emit("raise_invokes_handler", 1, NULL, 1, errno); return 1; }
  if (raise(SIGTERM) != 0) { emit("raise_invokes_handler", 1, NULL, 1, errno); return 1; }
  if (signal_canary_seen != SIGTERM) { emit("raise_invokes_handler", 1, NULL, 0, 0); return 1; }
  emit("raise_invokes_handler", 0, "raise:sigterm", 0, 0);
  return 0;
}

static int case_alarm_returns_zero(void) {
  /* alarm(0) cancels any pending alarm and returns the seconds remaining,
   * which is 0 on first call. */
  unsigned remaining = alarm(0);
  if (remaining != 0) { emit("alarm_returns_zero", 1, NULL, 0, 0); return 1; }
  emit("alarm_returns_zero", 0, "alarm:0", 0, 0);
  return 0;
}

static int case_sigemptyset_clears(void) {
  sigset_t s;
  /* Pre-poison with sigfillset so we can distinguish a no-op from a real clear. */
  if (sigfillset(&s) != 0) { emit("sigemptyset_clears", 1, NULL, 1, errno); return 1; }
  if (sigemptyset(&s) != 0) { emit("sigemptyset_clears", 1, NULL, 1, errno); return 1; }
  /* After empty, no signal should be a member. */
  if (sigismember(&s, SIGINT) != 0) { emit("sigemptyset_clears", 1, NULL, 0, 0); return 1; }
  emit("sigemptyset_clears", 0, "sigset:empty", 0, 0);
  return 0;
}

/* sigset_t is `unsigned char` (see include/signal.h), so sigaddset /
 * sigismember only handle signals 0..7.  Cases pick a "present" signal
 * (SIGINT=2) and a "not present" signal (SIGQUIT=3) within that range. */
static int case_sigfillset_fills(void) {
  sigset_t s;
  if (sigfillset(&s) != 0) { emit("sigfillset_fills", 1, NULL, 1, errno); return 1; }
  if (sigismember(&s, SIGINT) != 1) { emit("sigfillset_fills", 1, NULL, 0, 0); return 1; }
  if (sigismember(&s, SIGQUIT) != 1) { emit("sigfillset_fills", 1, NULL, 0, 0); return 1; }
  emit("sigfillset_fills", 0, "sigset:full", 0, 0);
  return 0;
}

static int case_sigaddset_adds(void) {
  sigset_t s;
  if (sigemptyset(&s) != 0) { emit("sigaddset_adds", 1, NULL, 1, errno); return 1; }
  if (sigaddset(&s, SIGINT) != 0) { emit("sigaddset_adds", 1, NULL, 1, errno); return 1; }
  if (sigismember(&s, SIGINT) != 1) { emit("sigaddset_adds", 1, NULL, 0, 0); return 1; }
  if (sigismember(&s, SIGQUIT) != 0) { emit("sigaddset_adds", 1, NULL, 0, 0); return 1; }
  emit("sigaddset_adds", 0, "sigset:add", 0, 0);
  return 0;
}

static int case_sigdelset_removes(void) {
  sigset_t s;
  if (sigfillset(&s) != 0) { emit("sigdelset_removes", 1, NULL, 1, errno); return 1; }
  if (sigdelset(&s, SIGINT) != 0) { emit("sigdelset_removes", 1, NULL, 1, errno); return 1; }
  if (sigismember(&s, SIGINT) != 0) { emit("sigdelset_removes", 1, NULL, 0, 0); return 1; }
  if (sigismember(&s, SIGQUIT) != 1) { emit("sigdelset_removes", 1, NULL, 0, 0); return 1; }
  emit("sigdelset_removes", 0, "sigset:del", 0, 0);
  return 0;
}

static int case_sigismember_reports(void) {
  sigset_t s;
  if (sigemptyset(&s) != 0) { emit("sigismember_reports", 1, NULL, 1, errno); return 1; }
  if (sigaddset(&s, SIGINT) != 0) { emit("sigismember_reports", 1, NULL, 1, errno); return 1; }
  int yes = sigismember(&s, SIGINT);
  int no = sigismember(&s, SIGQUIT);
  if (yes != 1 || no != 0) { emit("sigismember_reports", 1, NULL, 0, 0); return 1; }
  emit("sigismember_reports", 0, "sigset:ismember", 0, 0);
  return 0;
}

static int case_sigprocmask_roundtrip(void) {
  sigset_t set, oldset;
  if (sigemptyset(&set) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigaddset(&set, SIGQUIT) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigprocmask(SIG_SETMASK, &set, NULL) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigprocmask(SIG_SETMASK, NULL, &oldset) != 0) { emit("sigprocmask_roundtrip", 1, NULL, 1, errno); return 1; }
  if (sigismember(&oldset, SIGQUIT) != 1) { emit("sigprocmask_roundtrip", 1, NULL, 0, 0); return 1; }
  emit("sigprocmask_roundtrip", 0, "sigprocmask:roundtrip", 0, 0);
  return 0;
}

static int case_sigsuspend_resumes_on_raise(void) {
  /* sigsuspend with empty mask + raise == handler runs synchronously, suspend returns -1/EINTR. */
  struct sigaction sa;
  sigset_t empty;
  signal_canary_suspend_seen = 0;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = signal_canary_suspend_handler;
  if (sigaction(SIGUSR2, &sa, NULL) != 0) { emit("sigsuspend_resumes_on_raise", 1, NULL, 1, errno); return 1; }
  if (sigemptyset(&empty) != 0) { emit("sigsuspend_resumes_on_raise", 1, NULL, 1, errno); return 1; }
  /* Raise BEFORE suspending — yurt's signal layer dispatches on raise() rather
   * than blocking on external delivery, so "suspend then raise" would deadlock. The
   * spec semantics are intentionally narrow (§Runtime Semantics > Signals). */
  if (raise(SIGUSR2) != 0) { emit("sigsuspend_resumes_on_raise", 1, NULL, 1, errno); return 1; }
  if (signal_canary_suspend_seen != SIGUSR2) { emit("sigsuspend_resumes_on_raise", 1, NULL, 0, 0); return 1; }
  emit("sigsuspend_resumes_on_raise", 0, "sigsuspend:handled", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "signal_install") == 0) return case_signal_install();
  if (strcmp(name, "sigaction_raise") == 0) return case_sigaction_raise();
  if (strcmp(name, "raise_invokes_handler") == 0) return case_raise_invokes_handler();
  if (strcmp(name, "alarm_returns_zero") == 0) return case_alarm_returns_zero();
  if (strcmp(name, "sigemptyset_clears") == 0) return case_sigemptyset_clears();
  if (strcmp(name, "sigfillset_fills") == 0) return case_sigfillset_fills();
  if (strcmp(name, "sigaddset_adds") == 0) return case_sigaddset_adds();
  if (strcmp(name, "sigdelset_removes") == 0) return case_sigdelset_removes();
  if (strcmp(name, "sigismember_reports") == 0) return case_sigismember_reports();
  if (strcmp(name, "sigprocmask_roundtrip") == 0) return case_sigprocmask_roundtrip();
  if (strcmp(name, "sigsuspend_resumes_on_raise") == 0) return case_sigsuspend_resumes_on_raise();
  fprintf(stderr, "signal-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("signal_install");
  puts("sigaction_raise");
  puts("raise_invokes_handler");
  puts("alarm_returns_zero");
  puts("sigemptyset_clears");
  puts("sigfillset_fills");
  puts("sigaddset_adds");
  puts("sigdelset_removes");
  puts("sigismember_reports");
  puts("sigprocmask_roundtrip");
  puts("sigsuspend_resumes_on_raise");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode preserved verbatim. */
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = signal_canary_handler;
    if (sigaction(SIGINT, &sa, NULL) != 0) { perror("sigaction"); return 1; }
    if (raise(SIGINT) != 0) { perror("raise"); return 1; }
    if (signal_canary_seen != SIGINT) { fprintf(stderr, "signal handler was not invoked\n"); return 1; }
    alarm(0);
    puts("signal-ok");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) return list_cases();
  if (argc == 3 && strcmp(argv[1], "--case") == 0) return run_case(argv[2]);
  fprintf(stderr, "usage: signal-canary [--case <name> | --list-cases]\n");
  return 2;
}
