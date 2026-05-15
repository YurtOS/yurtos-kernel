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
    "realpath",
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
    "tmpfile",
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
    "socketpair",
    "sendfile",
    "posix_spawn",
    "posix_spawnp",
    "posix_spawn_file_actions_init",
    "posix_spawnattr_init",
    "posix_madvise",
    "setrlimit",
    "sched_getaffinity",
    "sched_setaffinity",
    "sched_getcpu",
    "sched_getscheduler",
    "sched_setscheduler",
    "sched_getparam",
    "sched_setparam",
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
    "pthread_sigmask",
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
    "access",
    "bind",
    "chdir",
    "close",
    "connect",
    "fchdir",
    "fchownat",
    "faccessat",
    "fcntl",
    "fstat",
    "fstatat",
    "getcwd",
    "getegid",
    "geteuid",
    "getgid",
    "getpeername",
    "getpid",
    "getppid",
    "getsockname",
    "getsockopt",
    "getuid",
    "listen",
    "lstat",
    "mbrtowc",
    "mbtowc",
    "nl_langinfo",
    "nl_langinfo_l",
    "pthread_setspecific",
    "read",
    "realpath",
    "recv",
    "send",
    "setegid",
    "seteuid",
    "setgid",
    "setlocale",
    "setsockopt",
    "setuid",
    "shutdown",
    "socket",
    "stat",
    "strftime",
    "write",
    "wcrtomb",
    "wctomb",
    "__ctype_get_mb_cur_max",
];

pub const YURT_INTERNAL_EXPORTS: &[&str] = &[
    "__stack_pointer",
    "yurt_deliver_signal",
    // Phase 1 shared-library contract — see
    // docs/superpowers/specs/2026-05-09-shared-libraries-design.md §86.
    // `__alloc` / `__dealloc` are defined in libyurt_abi
    // (abi/src/yurt_dl_main.c) and the loader requires them on every
    // PIE main module that may host dlopen. `__wasi_init_tp` lives in
    // wasi-libc; the side modules wasm-ld --shared produces declare it
    // as an `env.*` import nominally backed by libc.so, and the loader
    // resolves it from main.instance.exports. Without the export
    // wasm-ld would let the symbol stay internal and side-module
    // instantiation fails with "function import requires a callable"
    // on `env.__wasi_init_tp`.
    "__alloc",
    "__dealloc",
    "__wasi_init_tp",
];

/// wasm thread-local-storage primitives. wasm-ld emits these only when
/// the binary contains `__thread` variables (cpython's `_Py_tss_tstate`,
/// ipykernel/libzmq locals, …); single-threaded binaries (file-conformance
/// fixtures, simple ABI canaries) don't have them. Use `--export-if-defined`
/// so the link doesn't fail on the non-TLS binaries.
///
/// Without these exports, every spawned pthread Worker shares the same
/// TLS region in shared linear memory — `_Py_tss_tstate` collides across
/// heartbeat / iostream threads → `_PyThreadState_Attach: non-NULL old
/// thread state` fatal. Force-exporting these lets `worker-thread-host.ts`
/// allocate per-pthread TLS, set `__tls_base`, and call
/// `__wasm_init_tls(tls_base)` to copy the template — same contract the
/// wasi-threads spec's `wasi_thread_start` shim would use if we exported
/// one.
pub const YURT_OPTIONAL_EXPORTS: &[&str] = &["__tls_size", "__tls_base", "__wasm_init_tls"];
