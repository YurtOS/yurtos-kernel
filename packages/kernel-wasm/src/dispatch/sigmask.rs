//! Guest 1-byte compact `sigset_t` ⇄ canonical `1<<(sig-1)` u64 remap.
//! The wire carries the guest byte verbatim (thin C); this is the only
//! place the slot table lives (spec §3.1). Slot map (yurt_signal.c
//! `yurt_signal_compact_slot`): SIGHUP1→0 SIGINT2→1 SIGQUIT3→2
//! SIGTERM15→3 SIGCHLD17→4 SIGWINCH28→5 SIGPIPE13→6
//! SIGUSR1/USR2/ALRM(10,12,14)→7.

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

use super::DispatchContext;
use crate::abi;
use crate::kernel::with_kernel;

const SIG_BLOCK: i32 = 0;
const SIG_UNBLOCK: i32 = 1;
const SIG_SETMASK: i32 = 2;
/// SIGKILL=9, SIGSTOP=19 — never maskable (Linux).
const UNMASKABLE: u64 = (1u64 << (9 - 1)) | (1u64 << (19 - 1));

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
