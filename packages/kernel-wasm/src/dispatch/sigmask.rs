//! Guest 1-byte compact `sigset_t` ⇄ canonical `1<<(sig-1)` u64 remap,
//! plus the single-producer signal-pending funnel and deliverability query.
//!
//! The wire carries the guest byte verbatim (thin C shim); this module is
//! the only place the slot table lives (spec §3.1).  Slot map mirrors
//! `yurt_signal_compact_slot()` in `abi/src/yurt_signal.c`:
//!   SIGHUP1→0  SIGINT2→1  SIGQUIT3→2  SIGTERM15→3
//!   SIGCHLD17→4  SIGWINCH28→5  SIGPIPE13→6  SIGUSR1/USR2/ALRM(10,12,14)→7

use crate::abi;
use crate::dispatch::DispatchContext;
use crate::kernel::with_kernel;
use crate::kernel::RtSignal;

// ── §3.1 compact-slot ⇄ canonical remap ─────────────────────────────────────

/// `(compact_slot, &[signo...])` — slot 7 aliases SIGUSR1/SIGUSR2/SIGALRM.
const SLOTS: &[(u8, &[u32])] = &[
    (0, &[1]),
    (1, &[2]),
    (2, &[3]),
    (3, &[15]),
    (4, &[17]),
    (5, &[28]),
    (6, &[13]),
    (7, &[10, 12, 14]),
];

/// Guest compact byte → canonical `1<<(sig-1)` u64.
pub fn expand(compact: u8) -> u64 {
    let mut out = 0u64;
    for &(slot, signos) in SLOTS {
        if compact & (1 << slot) != 0 {
            for &s in signos {
                out |= 1u64 << (s - 1);
            }
        }
    }
    out
}

/// Canonical u64 → guest compact byte (any aliased signo ⇒ slot 7 set).
pub fn narrow(canonical: u64) -> u8 {
    let mut out = 0u8;
    for &(slot, signos) in SLOTS {
        if signos.iter().any(|&s| canonical & (1u64 << (s - 1)) != 0) {
            out |= 1 << slot;
        }
    }
    out
}

// ── §2/§4 signal pending funnel ─────────────────────────────────────────────

const SIGKILL: u32 = 9;
const SIGSTOP: u32 = 19;
const SIGCONT: u32 = 18;
const STOPSIGS: &[u32] = &[
    SIGSTOP, 20, /*SIGTSTP*/
    21, /*SIGTTIN*/
    22, /*SIGTTOU*/
];
const UNMASKABLE: u64 = (1u64 << (SIGKILL - 1)) | (1u64 << (SIGSTOP - 1));

/// Which pool a producer targets.
pub enum Pool {
    Process,
    Thread(u32 /* tid */),
}

/// The SINGLE producer funnel.
///
/// `disp_ignored` = caller-resolved (per-process disposition for `sig`
/// is `SIG_IGN`).
///
/// Returns `true` iff the signal was enqueued.  Returns `false` (nothing
/// enqueued) in four cases:
/// (a) `sig` out of `1..=64`;
/// (b) `disp_ignored` (SIG_IGN ⇒ discard, POSIX-success at the call site —
///     caller returns 0, NOT an error);
/// (c) `Pool::Thread(tid)` names a non-existent thread;
/// (d) the destination RT queue is at `KERNEL_RT_SIGNAL_QUEUE_CAP` (caller
///     maps to `EAGAIN`).
///
/// Callers that must distinguish (b)/(d) rely on the `disp_ignored` they
/// themselves pass plus their own prior `sig`-range / target-exists
/// validation — `pend` does not encode the reason.
pub(crate) fn pend(
    p: &mut crate::kernel::Process,
    pool: Pool,
    sig: u32,
    rt: Option<RtSignal>,
    disp_ignored: bool,
) -> bool {
    if !(1..=64).contains(&sig) {
        return false;
    }
    if disp_ignored {
        return false; // SIG_IGN ⇒ discard, never enqueue
    }
    // job-control mutual discard at produce-time (both pools)
    if sig == SIGCONT {
        purge(p, STOPSIGS);
    }
    if STOPSIGS.contains(&sig) {
        purge(p, &[SIGCONT]);
    }
    let bit = 1u64 << (sig - 1);
    let set = match pool {
        Pool::Process => &mut p.pending,
        Pool::Thread(tid) => match p.threads.get_mut(&tid) {
            Some(t) => &mut t.pending,
            None => return false,
        },
    };
    match rt {
        Some(r) => {
            if set.rt.len() >= crate::kernel::KERNEL_RT_SIGNAL_QUEUE_CAP {
                return false; // RT queue full — caller maps to EAGAIN (spec §4)
            }
            set.rt.push_back(r);
        }
        None => set.standard |= bit,
    }
    true
}

/// Remove all pending instances of every signal in `sigs` from the
/// process pool and every thread pool.
fn purge(p: &mut crate::kernel::Process, sigs: &[u32]) {
    for &s in sigs {
        let b = 1u64 << (s - 1);
        p.pending.standard &= !b;
        p.pending.rt.retain(|r| r.signo != s);
        for t in p.threads.values_mut() {
            t.pending.standard &= !b;
            t.pending.rt.retain(|r| r.signo != s);
        }
    }
}

/// Disposition→IGN purge: clears `sig` from the process pool and every
/// thread pool.  Called when a `sigaction` sets a disposition to `SIG_IGN`.
pub(crate) fn purge_ignored(p: &mut crate::kernel::Process, sig: u32) {
    if (1..=64).contains(&sig) {
        purge(p, &[sig]);
    }
}

/// Returns `true` when thread `tid` has at least one signal that is
/// pending (process-pool or thread-pool) **and** not blocked by that
/// thread's mask.
///
/// Disposition (`SIG_IGN`) is excluded at produce-time by `pend()` and
/// is not rechecked here; callers that need raise semantics handle it.
pub(crate) fn thread_has_deliverable(p: &crate::kernel::Process, tid: u32) -> bool {
    let thr = p.threads.get(&tid);
    let blk = thr.map(|t| t.blocked_signals).unwrap_or(0);
    let proc_std = p.pending.standard;
    let thrd_std = thr.map(|t| t.pending.standard).unwrap_or(0);
    let std_unblocked = (proc_std | thrd_std) & !blk;
    if std_unblocked != 0 {
        return true;
    }
    let rt_unblocked = |q: &std::collections::VecDeque<RtSignal>| {
        q.iter()
            .any(|r| (1..=64).contains(&r.signo) && blk & (1u64 << (r.signo - 1)) == 0)
    };
    rt_unblocked(&p.pending.rt) || thr.map(|t| rt_unblocked(&t.pending.rt)).unwrap_or(false)
}

// ── sys_sigprocmask ──────────────────────────────────────────────────────────

const SIG_BLOCK: i32 = 0;
const SIG_UNBLOCK: i32 = 1;
const SIG_SETMASK: i32 = 2;

/// `sys_sigprocmask` / `pthread_sigmask` — per-calling-thread blocked
/// mask. Wire: request `[how:i32 LE][has:u8][set:u8 compact]` (6 bytes),
/// response `[oset:u8 compact]` (prior mask). `how` 0=BLOCK 1=UNBLOCK
/// 2=SETMASK (else EINVAL). `has==0` ⇒ pure query (oldset only, mask
/// unchanged). SIGKILL/SIGSTOP are never settable (`& !UNMASKABLE`).
/// Compact⇄`1<<(sig-1)` remap is kernel-side (`expand`/`narrow`).
pub(super) fn sys_sigprocmask(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 6 || response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let how = i32::from_le_bytes(request[0..4].try_into().expect("4"));
    let has = request[4] != 0;
    let set = expand(request[5]);
    with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        if has {
            // Validate `how` BEFORE writing oldset so an invalid `how`
            // returns EINVAL with the mask unchanged and `response`
            // left undefined (POSIX: oldset unspecified on failure).
            let n = match how {
                SIG_BLOCK => t.blocked_signals | set,
                SIG_UNBLOCK => t.blocked_signals & !set,
                SIG_SETMASK => set,
                _ => return -(abi::EINVAL as i64),
            };
            response[0] = narrow(t.blocked_signals); // prior mask, before mutate
            t.blocked_signals = n & !UNMASKABLE;
        } else {
            response[0] = narrow(t.blocked_signals); // pure query: oldset only
        }
        1
    })
}

// ── sys_signal_raise / sys_signal_query ─────────────────────────────────────

/// `sys_signal_raise(sig)` — synchronous self-signal (`raise`/`pthread_kill(self)`).
/// Kernel-authored verdict: request `[sig:u32]` (4B) → response
/// `[action:i32][handler_token:u32]` (8B), return 8. action: 0 NONE
/// (blocked⇒pended in CALLER-THREAD pool, or SIG_IGN⇒discarded — guest
/// does nothing), 1 RUN_HANDLER (guest runs token→fn), 2 DFL_TERMINATE,
/// 3 DFL_STOP, 4 DFL_CONT. The guest holds NO signo→action policy — it
/// only executes this enum.
pub(super) fn sys_signal_raise(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 4 || response.len() < 8 {
        return -(abi::EINVAL as i64);
    }
    let sig = u32::from_le_bytes(request[0..4].try_into().expect("4"));
    if !(1..=64).contains(&sig) {
        return -(abi::EINVAL as i64);
    }
    with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        let d = p.signal_dispositions[(sig - 1) as usize];
        let blocked = p
            .threads
            .get(&ctx.caller_tid)
            .map(|t| t.blocked_signals & (1u64 << (sig - 1)) != 0)
            .unwrap_or(false);
        let (action, token): (i32, u32) = if d.handler == crate::kernel::SIG_IGN_HANDLER {
            // SIG_IGN ⇒ discard uniformly, produce-time, even if blocked
            // (spec §2: ignored signals are never enqueued, by ANY producer).
            (0, 0) // NONE
        } else if blocked {
            // raise = pthread_kill(self): thread-directed, caller-thread pool.
            pend(p, Pool::Thread(ctx.caller_tid), sig, None, false);
            (0, 0) // NONE
        } else if d.handler != crate::kernel::SIG_DFL_HANDLER {
            (1, d.handler) // RUN_HANDLER + token
        } else {
            match default_action(sig) {
                Dfl::Term => (2, 0),
                Dfl::Stop => (3, 0),
                Dfl::Cont => (4, 0),
                Dfl::Ign => (0, 0), // default-ignore => NONE
            }
        };
        response[0..4].copy_from_slice(&action.to_le_bytes());
        response[4..8].copy_from_slice(&token.to_le_bytes());
        8
    })
}

/// Kernel-owned SIG_DFL default-action class (guest never decides this).
enum Dfl {
    Term,
    Stop,
    Cont,
    Ign,
}
fn default_action(sig: u32) -> Dfl {
    match sig {
        17 | 23 | 28 => Dfl::Ign, // SIGCHLD, SIGURG, SIGWINCH: default-ignore
        18 => Dfl::Cont,          // SIGCONT
        19..=22 => Dfl::Stop,     // SIGSTOP/TSTP/TTIN/TTOU
        _ => Dfl::Term,
    }
}

/// `sys_signal_query()` — non-destructive readiness probe for the
/// caller THREAD: does it have any deliverable signal
/// (`(proc∪thread).pending ∧ ¬thread.blocked`, SIG_IGN excluded at
/// produce-time)? Does NOT accept/remove (unlike `sys_sigwaitinfo`).
/// No args → `[u8: 0|1]`, return 1. (#91 pselect/ppoll consumes this.)
pub(super) fn sys_signal_query(ctx: DispatchContext, _request: &[u8], response: &mut [u8]) -> i64 {
    if response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let deliverable = with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        thread_has_deliverable(p, ctx.caller_tid)
    });
    response[0] = if deliverable { 1 } else { 0 };
    1
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::ThreadRecord;

    // ── remap ───────────────────────────────────────────────────────────────

    #[test]
    fn sigint_narrow_sets_slot1() {
        // SIGINT=2  ⇒  canonical bit 1  ⇒  compact slot 1
        assert_eq!(narrow(1u64 << (2 - 1)), 1 << 1);
    }

    #[test]
    fn slot7_expand_gives_usr1_usr2_alrm() {
        // slot 7 ⇒ SIGUSR1(10)|SIGUSR2(12)|SIGALRM(14)
        assert_eq!(expand(1u8 << 7), (1u64 << 9) | (1u64 << 11) | (1u64 << 13));
    }

    #[test]
    fn expand_zero_is_zero() {
        assert_eq!(expand(0), 0);
    }

    #[test]
    fn narrow_zero_is_zero() {
        assert_eq!(narrow(0), 0);
    }

    // ── pend: SIG_IGN discard ───────────────────────────────────────────────

    #[test]
    fn pend_sig_ign_returns_false_and_does_not_set_bit() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(200);
            let before = p.pending.standard;
            let pended = pend(p, Pool::Process, 15 /*SIGTERM*/, None, true);
            assert!(!pended, "SIG_IGN must discard");
            assert_eq!(p.pending.standard, before, "standard bits unchanged");
        });
    }

    // ── pend: standard signal into process pool ─────────────────────────────

    #[test]
    fn pend_sigterm_sets_process_pool_bit() {
        let _g = crate::kernel::TestGuard::acquire();
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(201);
            let pended = pend(p, Pool::Process, 15 /*SIGTERM*/, None, false);
            assert!(pended);
            assert_ne!(
                p.pending.standard & (1u64 << 14),
                0,
                "bit 14 (SIGTERM-1) must be set"
            );
        });
    }

    // ── SIGCONT purges stop signals from ALL pools ──────────────────────────

    #[test]
    fn sigcont_purges_sigstop_from_process_and_thread_pools() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 202;
        const TID: u32 = 2;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            // seed SIGSTOP(19) in process pool
            p.pending.standard |= 1u64 << (19 - 1);
            // seed SIGSTOP(19) in thread pool
            p.threads
                .entry(TID)
                .or_insert_with(|| ThreadRecord::new(TID, None, 0))
                .pending
                .standard |= 1u64 << (19 - 1);

            let pended = pend(p, Pool::Process, 18 /*SIGCONT*/, None, false);
            assert!(pended);
            // SIGSTOP bit must be cleared in both pools
            assert_eq!(
                p.pending.standard & (1u64 << (19 - 1)),
                0,
                "SIGSTOP cleared from process pool"
            );
            let thr_bit = p
                .threads
                .get(&TID)
                .map(|t| t.pending.standard & (1u64 << (19 - 1)))
                .unwrap_or(0);
            assert_eq!(thr_bit, 0, "SIGSTOP cleared from thread pool");
        });
    }

    // ── SIGSTOP purges SIGCONT ──────────────────────────────────────────────

    #[test]
    fn sigstop_purges_sigcont() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 203;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            // seed SIGCONT(18) in process pool
            p.pending.standard |= 1u64 << (18 - 1);
            let pended = pend(p, Pool::Process, 19 /*SIGSTOP*/, None, false);
            assert!(pended);
            assert_eq!(
                p.pending.standard & (1u64 << (18 - 1)),
                0,
                "SIGCONT must be purged when SIGSTOP is pended"
            );
        });
    }

    // ── pend into thread pool (not process pool) ────────────────────────────

    #[test]
    fn pend_thread_pool_does_not_touch_process_pool() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 204;
        const TID: u32 = 3;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            p.threads
                .entry(TID)
                .or_insert_with(|| ThreadRecord::new(TID, None, 0));
            let proc_before = p.pending.standard;
            let pended = pend(p, Pool::Thread(TID), 2 /*SIGINT*/, None, false);
            assert!(pended);
            assert_eq!(
                p.pending.standard, proc_before,
                "process pool must not be touched"
            );
            let thr_bit = p
                .threads
                .get(&TID)
                .map(|t| t.pending.standard & (1u64 << (2 - 1)))
                .unwrap_or(0);
            assert_ne!(thr_bit, 0, "SIGINT must be set in thread pool");
        });
    }

    // ── thread_has_deliverable ──────────────────────────────────────────────

    #[test]
    fn deliverable_false_when_blocked_true_when_unblocked() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 205;
        const TID: u32 = 1;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            // ensure main thread exists (tid=1 is MAIN_THREAD_TID)
            p.threads
                .entry(TID)
                .or_insert_with(|| ThreadRecord::new(TID, None, 0));

            // pending SIGTERM(15) in process pool, blocked by thread
            p.pending.standard = 1u64 << (15 - 1);
            p.threads.get_mut(&TID).unwrap().blocked_signals = 1u64 << (15 - 1);
            assert!(!thread_has_deliverable(p, TID), "blocked: not deliverable");

            // unblock ⇒ deliverable
            p.threads.get_mut(&TID).unwrap().blocked_signals = 0;
            assert!(thread_has_deliverable(p, TID), "unblocked: deliverable");
        });
    }

    #[test]
    fn deliverable_from_thread_pool_unblocked() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 206;
        const TID: u32 = 5;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            p.threads
                .entry(TID)
                .or_insert_with(|| ThreadRecord::new(TID, None, 0));
            // process pool empty, signal in thread pool
            p.pending.standard = 0;
            p.threads.get_mut(&TID).unwrap().pending.standard = 1u64 << (15 - 1);
            p.threads.get_mut(&TID).unwrap().blocked_signals = 0;
            assert!(
                thread_has_deliverable(p, TID),
                "thread-pool signal must be deliverable when unblocked"
            );
        });
    }

    // ── purge_ignored ───────────────────────────────────────────────────────

    #[test]
    fn purge_ignored_clears_from_process_and_thread_pools() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 207;
        const TID: u32 = 7;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            p.threads
                .entry(TID)
                .or_insert_with(|| ThreadRecord::new(TID, None, 0));

            // seed SIGTERM(15) in both pools
            let bit = 1u64 << (15 - 1);
            p.pending.standard |= bit;
            p.threads.get_mut(&TID).unwrap().pending.standard |= bit;

            purge_ignored(p, 15);

            assert_eq!(p.pending.standard & bit, 0, "process pool cleared");
            let thr_bit = p
                .threads
                .get(&TID)
                .map(|t| t.pending.standard & bit)
                .unwrap_or(0);
            assert_eq!(thr_bit, 0, "thread pool cleared");
        });
    }

    // ── RT queue cap ───────────────────────────────────────────────────────

    #[test]
    fn pend_rt_cap_blocks_at_limit() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 208;
        const SIGNO: u32 = 34; // first POSIX RT signal; not a stop/cont signal
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            let cap = crate::kernel::KERNEL_RT_SIGNAL_QUEUE_CAP;
            let rt_entry = || crate::kernel::RtSignal {
                signo: SIGNO,
                value: 0,
                sender_pid: 1,
            };

            // fill the queue to exactly CAP entries — every pend must return true
            for i in 0..cap {
                let result = pend(p, Pool::Process, SIGNO, Some(rt_entry()), false);
                assert!(result, "pend #{i} should succeed (queue not yet full)");
            }
            assert_eq!(
                p.pending.rt.len(),
                cap,
                "queue must be exactly at CAP after filling"
            );

            // one more pend must return false and leave the queue at CAP
            let overflow = pend(p, Pool::Process, SIGNO, Some(rt_entry()), false);
            assert!(!overflow, "pend at CAP+1 must return false (RT queue full)");
            assert_eq!(
                p.pending.rt.len(),
                cap,
                "queue must stay at CAP after rejected pend"
            );
        });
    }

    // ── out-of-range signo ─────────────────────────────────────────────────

    #[test]
    fn pend_out_of_range_signo_returns_false() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 209;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            let std_before = p.pending.standard;
            let rt_before = p.pending.rt.len();

            let r0 = pend(p, Pool::Process, 0, None, false);
            assert!(!r0, "signo 0 is out of range");

            // sig-64 (#131): signo 64 is SIGRTMAX (in range now); the
            // first out-of-range signo is 65.
            let r65 = pend(p, Pool::Process, 65, None, false);
            assert!(!r65, "signo 65 is out of range");

            assert_eq!(
                p.pending.standard, std_before,
                "standard bits unchanged after out-of-range signo"
            );
            assert_eq!(
                p.pending.rt.len(),
                rt_before,
                "RT queue unchanged after out-of-range signo"
            );
        });
    }

    // ── missing thread tid ─────────────────────────────────────────────────

    #[test]
    fn pend_missing_thread_returns_false_and_leaves_process_pool_clean() {
        let _g = crate::kernel::TestGuard::acquire();
        const PID: u32 = 210;
        const MISSING_TID: u32 = 9999;
        crate::kernel::with_kernel(|k| {
            let p = k.process_mut(PID);
            let std_before = p.pending.standard;

            let result = pend(p, Pool::Thread(MISSING_TID), 2 /*SIGINT*/, None, false);
            assert!(!result, "non-existent tid must return false");
            assert_eq!(
                p.pending.standard, std_before,
                "process pool must be untouched when thread does not exist"
            );
        });
    }
}
