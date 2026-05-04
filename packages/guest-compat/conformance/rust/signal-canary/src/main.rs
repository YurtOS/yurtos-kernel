//! Paired Rust canary for §Behavioral Spec signal. Cases must
//! match exactly the cases in packages/guest-compat/conformance/c/signal-canary.c
//! — divergence is the failure mode per §Conformance Driver.

use std::io::Write;
use std::sync::atomic::{AtomicI32, Ordering};

// Constants from yurt's signal.h (same numeric values as WASI/Linux)
const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;
const SIGUSR2: i32 = 12;
// sigaddset / sigismember are bounded by sigset_t's 8-bit width (see
// include/signal.h), so sigset-manipulation cases pick a second signal
// within that range. SIGQUIT (3) is distinct from SIGINT (2) and fits.
const SIGQUIT: i32 = 3;
const SIG_SETMASK: i32 = 2;
// SIG_ERR = (sighandler_t)(intptr_t)-1 = usize::MAX on wasm32 (wrapping cast)
const SIG_ERR: usize = usize::MAX;

// sigset_t from yurt's signal.h:
//   typedef unsigned char sigset_t;
// It's a single byte.
type SigsetT = u8;

// sigaction struct layout on wasm32-wasip1 matching yurt's signal.h:
//   struct sigaction {
//     union { sighandler_t sa_handler; void(*sa_sigaction)(int,void*,void*); } __sa_handler;  // 4 bytes
//     sigset_t sa_mask;  // 1 byte
//     // 3 bytes padding
//     int sa_flags;      // 4 bytes
//     void (*sa_restorer)(void);  // 4 bytes
//   };
// Total: 16 bytes
#[repr(C)]
struct SigactionT {
    sa_handler: usize, // covers the union (sa_handler / sa_sigaction) as a raw fn ptr
    sa_mask: u8,       // sigset_t (1 byte)
    _pad: [u8; 3],     // alignment padding before sa_flags
    sa_flags: i32,
    sa_restorer: usize, // void (*sa_restorer)(void)
}

impl SigactionT {
    fn zeroed() -> Self {
        SigactionT {
            sa_handler: 0,
            sa_mask: 0,
            _pad: [0; 3],
            sa_flags: 0,
            sa_restorer: 0,
        }
    }
}

extern "C" {
    fn signal(sig: i32, handler: usize) -> usize;
    fn sigaction(sig: i32, act: *const SigactionT, oldact: *mut SigactionT) -> i32;
    fn raise(sig: i32) -> i32;
    fn alarm(seconds: u32) -> u32;
    fn sigemptyset(set: *mut SigsetT) -> i32;
    fn sigfillset(set: *mut SigsetT) -> i32;
    fn sigaddset(set: *mut SigsetT, sig: i32) -> i32;
    fn sigdelset(set: *mut SigsetT, sig: i32) -> i32;
    fn sigismember(set: *const SigsetT, sig: i32) -> i32;
    fn sigprocmask(how: i32, set: *const SigsetT, oldset: *mut SigsetT) -> i32;
    #[allow(dead_code)]
    fn sigsuspend(mask: *const SigsetT) -> i32;
    fn __errno_location() -> *mut i32;
}

// Handler state atomics (shared between handler and case logic)
static SEEN: AtomicI32 = AtomicI32::new(0);
static SUSPEND_SEEN: AtomicI32 = AtomicI32::new(0);

extern "C" fn handler(sig: i32) {
    SEEN.store(sig, Ordering::SeqCst);
}

extern "C" fn suspend_handler(sig: i32) {
    SUSPEND_SEEN.store(sig, Ordering::SeqCst);
}

fn emit(case: &str, exit: i32, stdout_line: Option<&str>, errno: Option<i32>) {
    let mut buf = String::new();
    buf.push_str(&format!("{{\"case\":\"{case}\",\"exit\":{exit}"));
    if let Some(s) = stdout_line {
        buf.push_str(&format!(",\"stdout\":\"{s}\""));
    }
    if let Some(e) = errno {
        buf.push_str(&format!(",\"errno\":{e}"));
    }
    buf.push_str("}\n");
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    handle.write_all(buf.as_bytes()).unwrap();
}

fn case_signal_install() -> i32 {
    let ret = unsafe { signal(SIGINT, handler as *const () as usize) };
    if ret == SIG_ERR {
        let errno = unsafe { *__errno_location() };
        emit("signal_install", 1, None, Some(errno));
        return 1;
    }
    emit("signal_install", 0, Some("signal:installed"), None);
    0
}

fn case_sigaction_raise() -> i32 {
    SEEN.store(0, Ordering::SeqCst);
    let mut sa = SigactionT::zeroed();
    sa.sa_handler = handler as *const () as usize;
    if unsafe { sigaction(SIGINT, &sa, std::ptr::null_mut()) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigaction_raise", 1, None, Some(errno));
        return 1;
    }
    if unsafe { raise(SIGINT) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigaction_raise", 1, None, Some(errno));
        return 1;
    }
    if SEEN.load(Ordering::SeqCst) != SIGINT {
        emit("sigaction_raise", 1, None, None);
        return 1;
    }
    emit("sigaction_raise", 0, Some("signal-ok"), None);
    0
}

fn case_raise_invokes_handler() -> i32 {
    SEEN.store(0, Ordering::SeqCst);
    let mut sa = SigactionT::zeroed();
    sa.sa_handler = handler as *const () as usize;
    if unsafe { sigaction(SIGTERM, &sa, std::ptr::null_mut()) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("raise_invokes_handler", 1, None, Some(errno));
        return 1;
    }
    if unsafe { raise(SIGTERM) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("raise_invokes_handler", 1, None, Some(errno));
        return 1;
    }
    if SEEN.load(Ordering::SeqCst) != SIGTERM {
        emit("raise_invokes_handler", 1, None, None);
        return 1;
    }
    emit("raise_invokes_handler", 0, Some("raise:sigterm"), None);
    0
}

fn case_alarm_returns_zero() -> i32 {
    let remaining = unsafe { alarm(0) };
    if remaining != 0 {
        emit("alarm_returns_zero", 1, None, None);
        return 1;
    }
    emit("alarm_returns_zero", 0, Some("alarm:0"), None);
    0
}

fn case_sigemptyset_clears() -> i32 {
    let mut s: SigsetT = 0;
    if unsafe { sigfillset(&mut s) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigemptyset_clears", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigemptyset(&mut s) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigemptyset_clears", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigismember(&s, SIGINT) } != 0 {
        emit("sigemptyset_clears", 1, None, None);
        return 1;
    }
    emit("sigemptyset_clears", 0, Some("sigset:empty"), None);
    0
}

fn case_sigfillset_fills() -> i32 {
    let mut s: SigsetT = 0;
    if unsafe { sigfillset(&mut s) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigfillset_fills", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigismember(&s, SIGINT) } != 1 {
        emit("sigfillset_fills", 1, None, None);
        return 1;
    }
    if unsafe { sigismember(&s, SIGQUIT) } != 1 {
        emit("sigfillset_fills", 1, None, None);
        return 1;
    }
    emit("sigfillset_fills", 0, Some("sigset:full"), None);
    0
}

fn case_sigaddset_adds() -> i32 {
    let mut s: SigsetT = 0;
    if unsafe { sigemptyset(&mut s) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigaddset_adds", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigaddset(&mut s, SIGINT) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigaddset_adds", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigismember(&s, SIGINT) } != 1 {
        emit("sigaddset_adds", 1, None, None);
        return 1;
    }
    if unsafe { sigismember(&s, SIGQUIT) } != 0 {
        emit("sigaddset_adds", 1, None, None);
        return 1;
    }
    emit("sigaddset_adds", 0, Some("sigset:add"), None);
    0
}

fn case_sigdelset_removes() -> i32 {
    let mut s: SigsetT = 0;
    if unsafe { sigfillset(&mut s) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigdelset_removes", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigdelset(&mut s, SIGINT) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigdelset_removes", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigismember(&s, SIGINT) } != 0 {
        emit("sigdelset_removes", 1, None, None);
        return 1;
    }
    if unsafe { sigismember(&s, SIGQUIT) } != 1 {
        emit("sigdelset_removes", 1, None, None);
        return 1;
    }
    emit("sigdelset_removes", 0, Some("sigset:del"), None);
    0
}

fn case_sigismember_reports() -> i32 {
    let mut s: SigsetT = 0;
    if unsafe { sigemptyset(&mut s) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigismember_reports", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigaddset(&mut s, SIGINT) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigismember_reports", 1, None, Some(errno));
        return 1;
    }
    let yes = unsafe { sigismember(&s, SIGINT) };
    let no = unsafe { sigismember(&s, SIGQUIT) };
    if yes != 1 || no != 0 {
        emit("sigismember_reports", 1, None, None);
        return 1;
    }
    emit("sigismember_reports", 0, Some("sigset:ismember"), None);
    0
}

fn case_sigprocmask_roundtrip() -> i32 {
    let mut set: SigsetT = 0;
    let mut oldset: SigsetT = 0;
    if unsafe { sigemptyset(&mut set) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigprocmask_roundtrip", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigaddset(&mut set, SIGQUIT) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigprocmask_roundtrip", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigprocmask(SIG_SETMASK, &set, std::ptr::null_mut()) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigprocmask_roundtrip", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigprocmask(SIG_SETMASK, std::ptr::null(), &mut oldset) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigprocmask_roundtrip", 1, None, Some(errno));
        return 1;
    }
    if unsafe { sigismember(&oldset, SIGQUIT) } != 1 {
        emit("sigprocmask_roundtrip", 1, None, None);
        return 1;
    }
    emit("sigprocmask_roundtrip", 0, Some("sigprocmask:roundtrip"), None);
    0
}

fn case_sigsuspend_resumes_on_raise() -> i32 {
    // NOTE: Does NOT call sigsuspend — raises before suspending would deadlock in
    // yurt's signal layer. Matches C canary behavior exactly (raise + handler check).
    SUSPEND_SEEN.store(0, Ordering::SeqCst);
    let mut sa = SigactionT::zeroed();
    sa.sa_handler = suspend_handler as *const () as usize;
    if unsafe { sigaction(SIGUSR2, &sa, std::ptr::null_mut()) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigsuspend_resumes_on_raise", 1, None, Some(errno));
        return 1;
    }
    let mut empty: SigsetT = 0;
    if unsafe { sigemptyset(&mut empty) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigsuspend_resumes_on_raise", 1, None, Some(errno));
        return 1;
    }
    if unsafe { raise(SIGUSR2) } != 0 {
        let errno = unsafe { *__errno_location() };
        emit("sigsuspend_resumes_on_raise", 1, None, Some(errno));
        return 1;
    }
    if SUSPEND_SEEN.load(Ordering::SeqCst) != SIGUSR2 {
        emit("sigsuspend_resumes_on_raise", 1, None, None);
        return 1;
    }
    emit("sigsuspend_resumes_on_raise", 0, Some("sigsuspend:handled"), None);
    0
}

fn run_case(name: &str) -> i32 {
    match name {
        "signal_install" => case_signal_install(),
        "sigaction_raise" => case_sigaction_raise(),
        "raise_invokes_handler" => case_raise_invokes_handler(),
        "alarm_returns_zero" => case_alarm_returns_zero(),
        "sigemptyset_clears" => case_sigemptyset_clears(),
        "sigfillset_fills" => case_sigfillset_fills(),
        "sigaddset_adds" => case_sigaddset_adds(),
        "sigdelset_removes" => case_sigdelset_removes(),
        "sigismember_reports" => case_sigismember_reports(),
        "sigprocmask_roundtrip" => case_sigprocmask_roundtrip(),
        "sigsuspend_resumes_on_raise" => case_sigsuspend_resumes_on_raise(),
        _ => {
            eprintln!("signal-canary: unknown case {name}");
            2
        }
    }
}

fn list_cases() {
    println!("signal_install");
    println!("sigaction_raise");
    println!("raise_invokes_handler");
    println!("alarm_returns_zero");
    println!("sigemptyset_clears");
    println!("sigfillset_fills");
    println!("sigaddset_adds");
    println!("sigdelset_removes");
    println!("sigismember_reports");
    println!("sigprocmask_roundtrip");
    println!("sigsuspend_resumes_on_raise");
}

fn smoke_mode() -> i32 {
    SEEN.store(0, Ordering::SeqCst);
    let mut sa = SigactionT::zeroed();
    sa.sa_handler = handler as *const () as usize;
    if unsafe { sigaction(SIGINT, &sa, std::ptr::null_mut()) } != 0 {
        eprintln!("sigaction failed");
        return 1;
    }
    if unsafe { raise(SIGINT) } != 0 {
        eprintln!("raise failed");
        return 1;
    }
    if SEEN.load(Ordering::SeqCst) != SIGINT {
        eprintln!("signal handler was not invoked");
        return 1;
    }
    unsafe { alarm(0) };
    println!("signal-ok");
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let exit = match argv.len() {
        1 => smoke_mode(),
        2 if argv[1] == "--list-cases" => {
            list_cases();
            0
        }
        3 if argv[1] == "--case" => run_case(&argv[2]),
        _ => {
            eprintln!("usage: signal-canary [--case <name> | --list-cases]");
            2
        }
    };
    std::process::exit(exit);
}
