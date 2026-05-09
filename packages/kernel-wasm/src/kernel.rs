//! Kernel state.
//!
//! Per-pid `Process` records plus a singleton [`Kernel`] holding the
//! map. New state-dependent syscalls (umask, cwd, fd table, …) read
//! and write through `with_kernel(|k| k.process(pid)…)`. The map
//! lazily inserts a default `Process` for unknown pids so that the
//! first syscall from a freshly-spawned process Just Works without
//! requiring an explicit registration step. Real `sys_spawn` semantics
//! land in a later phase and replace lazy insert with explicit
//! creation tied to the parent's process record.
//!
//! Kernel.wasm is single-threaded by design (the spec calls this out),
//! but `static` requires `Sync`; we use `Mutex` rather than `RefCell`
//! so the type system reflects the actual single-locking discipline.

// `BTreeMap`, not `HashMap`: HashMap's RandomState pulls
// `wasi_snapshot_preview1::random_get` into kernel.wasm's import set,
// which violates the architectural invariant that the kernel only
// imports `kh_*`. BTreeMap is deterministic and trivially fast at the
// process counts we actually run.
use std::collections::BTreeMap;
use std::sync::{LazyLock, Mutex};

use crate::state::Credentials;

pub type Pid = u32;

pub const DEFAULT_UMASK: u16 = 0o022;

#[derive(Clone, Debug)]
pub struct Process {
    pub umask: u16,
    pub credentials: Credentials,
    /// Working directory as raw bytes (cwd has no UTF-8 guarantee in
    /// POSIX). Default `/`.
    pub cwd: Vec<u8>,
}

impl Default for Process {
    fn default() -> Self {
        Self {
            umask: DEFAULT_UMASK,
            credentials: Credentials::DEFAULT,
            cwd: b"/".to_vec(),
        }
    }
}

pub struct Kernel {
    processes: BTreeMap<Pid, Process>,
}

impl Kernel {
    fn new() -> Self {
        Self {
            processes: BTreeMap::new(),
        }
    }

    /// Get a mutable reference to the process record for `pid`.
    /// Lazily inserts a default `Process` if no entry exists yet.
    pub fn process_mut(&mut self, pid: Pid) -> &mut Process {
        self.processes.entry(pid).or_default()
    }

    /// Get an immutable reference to the process record for `pid`.
    /// Lazily inserts a default `Process` if no entry exists yet.
    pub fn process(&mut self, pid: Pid) -> &Process {
        self.processes.entry(pid).or_default()
    }
}

static KERNEL: LazyLock<Mutex<Kernel>> = LazyLock::new(|| Mutex::new(Kernel::new()));

pub fn with_kernel<R>(f: impl FnOnce(&mut Kernel) -> R) -> R {
    let mut k = KERNEL.lock().expect("kernel state poisoned");
    f(&mut k)
}

#[cfg(test)]
pub fn reset_for_tests() {
    let mut k = KERNEL.lock().unwrap();
    k.processes.clear();
}

/// Native unit tests share the same `static KERNEL` and run in
/// parallel by default. Tests that observe global state should hold
/// this guard so they serialize relative to each other. Wasm runtime
/// is single-threaded by design — this is a native-test-only concern.
#[cfg(test)]
pub struct TestGuard {
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl TestGuard {
    pub fn acquire() -> Self {
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_tests();
        Self { _guard: guard }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_insert_yields_defaults() {
        let _g = TestGuard::acquire();
        let umask = with_kernel(|k| k.process_mut(42).umask);
        let cwd = with_kernel(|k| k.process_mut(42).cwd.clone());
        assert_eq!(umask, DEFAULT_UMASK);
        assert_eq!(cwd, b"/");
    }

    #[test]
    fn writes_persist_across_calls() {
        let _g = TestGuard::acquire();
        with_kernel(|k| k.process_mut(1).umask = 0o077);
        let again = with_kernel(|k| k.process_mut(1).umask);
        assert_eq!(again, 0o077);
    }

    #[test]
    fn pids_are_independent() {
        let _g = TestGuard::acquire();
        with_kernel(|k| k.process_mut(1).umask = 0o077);
        with_kernel(|k| k.process_mut(2).umask = 0o022);
        assert_eq!(with_kernel(|k| k.process_mut(1).umask), 0o077);
        assert_eq!(with_kernel(|k| k.process_mut(2).umask), 0o022);
    }
}
