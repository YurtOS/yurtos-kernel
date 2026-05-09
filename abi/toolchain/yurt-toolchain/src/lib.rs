pub mod archive;
pub mod cargo_yurt;
pub mod conform;
pub mod env;
pub mod features;
pub mod maturin_yurt;
pub mod precheck;
pub mod preserve;
pub mod rust_std;
pub mod rustc_wrapper;
pub mod spec;
pub mod trace;
pub mod wasi_sdk;
pub mod wasm_opt;

/// Tier 1 symbols from §Compatibility Tiers. Consumed by `yurt-cc` (to
/// force-export each symbol + its marker at link time) and `yurt-check`
/// (as the default list for §Verifying Precedence).
pub const TIER1: &[&str] = &[
    "chown",
    "chroot",
    "chmod",
    "flockfile",
    "ftrylockfile",
    "funlockfile",
    "qsort_r",
    "setresgid",
    "setresuid",
    "dup",
    "dup2",
    "dup3",
    "execv",
    "execve",
    "execvp",
    "fchdir",
    "fchown",
    "fork",
    "vfork",
    "gethostname",
    "getaddrinfo",
    "freeaddrinfo",
    "getnameinfo",
    "gethostbyname",
    "gethostbyaddr",
    "getgroups",
    "getpriority",
    "getrlimit",
    "getpgid",
    "getpgrp",
    "getsid",
    "lchown",
    "mkdtemp",
    "mkostemp",
    "mkstemp",
    "mktemp",
    "setpgid",
    "setpgrp",
    "setpriority",
    "setsid",
    "tcgetpgrp",
    "tcsetpgrp",
    "umask",
    "pipe",
    "pipe2",
    "if_indextoname",
    "if_nametoindex",
    "sendfile",
    "posix_spawn",
    "posix_spawnp",
    "posix_spawn_file_actions_init",
    "posix_spawnattr_init",
    "setrlimit",
    "sched_getaffinity",
    "sched_setaffinity",
    "sched_getcpu",
    "signal",
    "sigaction",
    "raise",
    "alarm",
    "sigemptyset",
    "sigfillset",
    "sigaddset",
    "sigdelset",
    "sigismember",
    "sigprocmask",
    "sigsuspend",
    "tzset",
    "wait",
    "waitpid",
    "pthread_create",
    "pthread_join",
    "pthread_detach",
    "pthread_exit",
    "pthread_self",
    "pthread_mutex_lock",
    "pthread_mutex_unlock",
    "pthread_cond_wait",
    "pthread_cond_signal",
    "pthread_key_create",
    "pthread_setspecific",
    "pthread_getspecific",
    "pthread_once",
];

/// POSIX symbols that are also present as strong wasi-libc definitions.
/// Link with `--wrap` so guests consistently call libyurt's versions.
pub const WRAPPED_WASI_LIBC_SYMBOLS: &[&str] = &[
    "accept",
    "getsockopt",
    "pthread_setspecific",
    "recv",
    "send",
];

pub const YURT_INTERNAL_EXPORTS: &[&str] = &["__stack_pointer", "yurt_deliver_signal"];
