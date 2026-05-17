//! Guest 1-byte compact `sigset_t` ⇄ canonical `1<<(sig-1)` u64 remap.
//! The wire carries the guest byte verbatim (thin C); this is the only
//! place the slot table lives (spec §3.1). Slot map (yurt_signal.c
//! `yurt_signal_compact_slot`): SIGHUP1→0 SIGINT2→1 SIGQUIT3→2
//! SIGTERM15→3 SIGCHLD17→4 SIGWINCH28→5 SIGPIPE13→6
//! SIGUSR1/USR2/ALRM(10,12,14)→7.

use super::DispatchContext;
use crate::abi;
use crate::kernel::{with_kernel, SigAltStack, SS_DISABLE};

/// (compact_slot, &[signo...]) — slot 7 aliases three signals.
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

/// Canonical u64 → guest compact byte (any aliased signo ⇒ slot 7).
pub fn narrow(canonical: u64) -> u8 {
    let mut out = 0u8;
    for &(slot, signos) in SLOTS {
        if signos.iter().any(|&s| canonical & (1u64 << (s - 1)) != 0) {
            out |= 1 << slot;
        }
    }
    out
}

const SIG_BLOCK: i32 = 0;
const SIG_UNBLOCK: i32 = 1;
const SIG_SETMASK: i32 = 2;
/// SIGKILL=9, SIGSTOP=19 — never maskable (Linux).
const UNMASKABLE: u64 = (1u64 << (9 - 1)) | (1u64 << (19 - 1));
/// Minimum alternate-signal-stack size (POSIX; Linux uses 2048 on most arches).
const MINSIGSTKSZ: u32 = 2048;

pub(super) fn sys_sigprocmask(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 6 || response.is_empty() {
        return -(abi::EINVAL as i64);
    }
    let how = i32::from_le_bytes(request[0..4].try_into().expect("4"));
    let has_set = request[4] != 0;
    let set = expand(request[5]);
    with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        response[0] = narrow(t.blocked_signals);
        if has_set {
            let next = match how {
                SIG_BLOCK => t.blocked_signals | set,
                SIG_UNBLOCK => t.blocked_signals & !set,
                SIG_SETMASK => set,
                _ => return -(abi::EINVAL as i64),
            };
            t.blocked_signals = next & !UNMASKABLE;
        }
        1
    })
}

pub(super) fn sys_sigaltstack(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 13 || response.len() < 12 {
        return -(abi::EINVAL as i64);
    }
    let has_ss = request[0] != 0;
    let sp = u32::from_le_bytes(request[1..5].try_into().expect("4"));
    let flags = i32::from_le_bytes(request[5..9].try_into().expect("4"));
    let size = u32::from_le_bytes(request[9..13].try_into().expect("4"));
    with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        let prev = t.sigaltstack;
        response[0..4].copy_from_slice(&prev.sp.to_le_bytes());
        response[4..8].copy_from_slice(&prev.flags.to_le_bytes());
        response[8..12].copy_from_slice(&prev.size.to_le_bytes());
        if has_ss {
            if flags & SS_DISABLE != 0 {
                t.sigaltstack = SigAltStack::disabled();
            } else if size < MINSIGSTKSZ {
                return -(abi::EINVAL as i64);
            } else {
                t.sigaltstack = SigAltStack { sp, flags, size };
            }
        }
        0
    })
}

/// `sigtimedwait` — reuse the RT-queue dequeue (separated-producer:
/// RT queue only, never the kill bitmask — documented divergence
/// §11.6). Selection is by `set` regardless of blocked state (§5.1).
/// `timeout==0`/nothing pending ⇒ EAGAIN; nonzero-timeout blocking is
/// the gated stub (also immediate EAGAIN).
pub(super) fn sys_sigtimedwait(ctx: DispatchContext, request: &[u8], response: &mut [u8]) -> i64 {
    if request.len() != 18 || response.len() < 16 {
        return -(abi::EINVAL as i64);
    }
    let set = expand(request[0]);
    with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        let Some(idx) = p
            .pending_rt
            .iter()
            .position(|s| (1..=63).contains(&s.signo) && (set & (1u64 << (s.signo - 1))) != 0)
        else {
            return -(abi::EAGAIN as i64);
        };
        let sig = p.pending_rt.remove(idx).expect("idx from position");
        const SI_QUEUE: i32 = -1;
        response[0..4].copy_from_slice(&(sig.signo as i32).to_le_bytes());
        response[4..8].copy_from_slice(&SI_QUEUE.to_le_bytes());
        response[8..12].copy_from_slice(&sig.sender_pid.to_le_bytes());
        response[12..16].copy_from_slice(&sig.value.to_le_bytes());
        16
    })
}

pub(super) fn sys_sigsuspend(ctx: DispatchContext, request: &[u8], _response: &mut [u8]) -> i64 {
    if request.len() != 2 {
        return -(abi::EINVAL as i64);
    }
    let has_mask = request[0] != 0;
    let mask = expand(request[1]) & !UNMASKABLE;
    with_kernel(|k| {
        let p = k.process_mut(ctx.caller_pid);
        let Some(t) = p.threads.get_mut(&ctx.caller_tid) else {
            return -(abi::ESRCH as i64);
        };
        let prior = t.blocked_signals;
        if has_mask {
            t.blocked_signals = mask;
        }
        // Non-blocking pending check is a structural placeholder — no
        // observable effect until delivery (B1.8-b). Restore + EINTR
        // (true blocking AsyncBridge/B1.5-gated). spec §5/§11.4.
        t.blocked_signals = prior;
        -(abi::EINTR as i64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sigusr1_roundtrips_through_slot7_with_documented_aliasing() {
        let c = narrow(1u64 << (10 - 1)); // SIGUSR1
        assert_eq!(c, 1 << 7, "SIGUSR1 → slot 7");
        let e = expand(c);
        // slot-7 aliasing: expanding slot 7 yields USR1|USR2|ALRM
        assert_eq!(e, (1u64 << 9) | (1u64 << 11) | (1u64 << 13));
    }
    #[test]
    fn sigint_exact_roundtrip() {
        let c = narrow(1u64 << (2 - 1)); // SIGINT
        assert_eq!(c, 1 << 1);
        assert_eq!(expand(c), 1u64 << 1);
    }
}
