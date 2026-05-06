#![allow(dead_code)] // Phase 4: used via StoreData; some helpers reserved for Phase 5+
//! Process kernel: in-process fd table and child-process tracking.
//!
//! Provides the host-side state for:
//! - `host_pipe` / `host_close_fd` / `host_dup` / `host_dup2`
//! - `host_read_fd` / `host_write_fd`
//! - `host_spawn_async` / `host_waitpid` / `host_waitpid_nohang`
//! - `host_list_processes`

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::oneshot;

// ── Pipe buffer ───────────────────────────────────────────────────────────────

/// Shared in-memory byte buffer for one pipe.
///
/// Both the read-end and write-end `FdEntry` clone this `Arc`.
/// Writers append; readers drain.
pub type PipeBuf = Arc<Mutex<Vec<u8>>>;

// ── FdEntry ───────────────────────────────────────────────────────────────────

/// A single entry in the host fd table.
#[derive(Clone)]
pub enum FdEntry {
    /// One end of a pipe (read or write — both share the same buffer).
    Pipe(PipeBuf),
    /// /dev/null — writes are discarded, reads return empty.
    Null,
}

impl FdEntry {
    /// Append `data` to this fd (for pipes: appends to shared buffer).
    pub fn write(&self, data: &[u8]) {
        match self {
            Self::Pipe(buf) => buf.lock().unwrap().extend_from_slice(data),
            Self::Null => {}
        }
    }

    /// Drain and return all available bytes from this fd.
    pub fn read_all(&self) -> Vec<u8> {
        match self {
            Self::Pipe(buf) => {
                let mut guard = buf.lock().unwrap();
                std::mem::take(&mut *guard)
            }
            Self::Null => Vec::new(),
        }
    }
}

// ── ChildState ────────────────────────────────────────────────────────────────

pub enum ChildState {
    /// Still running; `rx` delivers the exit code when done.
    Running(oneshot::Receiver<i32>),
    /// Exited with this code.
    Done(i32),
}

/// Snapshot for `host_list_processes`.
#[derive(Serialize)]
pub struct ProcessInfo {
    pub pid: i32,
    pub state: &'static str,
    pub exit_code: Option<i32>,
}

// ── ProcessKernel ─────────────────────────────────────────────────────────────

/// Host-managed file descriptors and child processes for one sandbox.
pub struct ProcessKernel {
    /// fd → entry.  fds 0/1/2 are handled by WASI; this table starts at 3.
    fds: HashMap<i32, FdEntry>,
    /// pid → state.
    procs: HashMap<i32, ChildState>,
    next_fd: i32,
    next_pid: i32,
}

impl Default for ProcessKernel {
    fn default() -> Self {
        Self {
            fds: HashMap::new(),
            procs: HashMap::new(),
            next_fd: 3,
            next_pid: 1,
        }
    }
}

impl ProcessKernel {
    // ── fd management ──────────────────────────────────────────────────────

    /// Allocate two fds that share a pipe buffer: `(read_fd, write_fd)`.
    pub fn pipe(&mut self) -> (i32, i32) {
        let buf: PipeBuf = Arc::new(Mutex::new(Vec::new()));
        let read_fd = self.alloc_fd(FdEntry::Pipe(buf.clone()));
        let write_fd = self.alloc_fd(FdEntry::Pipe(buf));
        (read_fd, write_fd)
    }

    fn alloc_fd(&mut self, entry: FdEntry) -> i32 {
        let fd = self.next_fd;
        self.next_fd += 1;
        self.fds.insert(fd, entry);
        fd
    }

    /// Close an fd.  Returns `true` if the fd existed.
    pub fn close_fd(&mut self, fd: i32) -> bool {
        self.fds.remove(&fd).is_some()
    }

    /// Duplicate `fd`: allocate a new fd pointing to the same underlying entry.
    /// Returns the new fd, or `None` if `fd` does not exist.
    pub fn dup(&mut self, fd: i32) -> Option<i32> {
        let entry = self.fds.get(&fd)?.clone();
        Some(self.alloc_fd(entry))
    }

    /// Make `dst_fd` refer to the same entry as `src_fd`, closing `dst_fd` first
    /// if it exists.  Returns `false` if `src_fd` does not exist.
    pub fn dup2(&mut self, src_fd: i32, dst_fd: i32) -> bool {
        let entry = match self.fds.get(&src_fd) {
            Some(e) => e.clone(),
            None => return false,
        };
        self.fds.insert(dst_fd, entry);
        true
    }

    /// Drain all bytes from `fd`'s buffer.  Returns `None` if `fd` is unknown.
    pub fn read_fd(&self, fd: i32) -> Option<Vec<u8>> {
        self.fds.get(&fd).map(|e| e.read_all())
    }

    /// Write `data` to `fd`.  Returns `false` if `fd` is unknown.
    pub fn write_fd(&self, fd: i32, data: &[u8]) -> bool {
        match self.fds.get(&fd) {
            Some(e) => {
                e.write(data);
                true
            }
            None => false,
        }
    }

    /// Return the underlying `PipeBuf` for `fd`, if it's a pipe entry.
    /// Used by spawn logic to connect a child's stdout to a parent pipe fd.
    pub fn pipe_buf(&self, fd: i32) -> Option<PipeBuf> {
        match self.fds.get(&fd) {
            Some(FdEntry::Pipe(buf)) => Some(buf.clone()),
            _ => None,
        }
    }

    // ── process management ─────────────────────────────────────────────────

    /// Register a new child process.  Returns its PID.
    pub fn add_process(&mut self, rx: oneshot::Receiver<i32>) -> i32 {
        let pid = self.next_pid;
        self.next_pid += 1;
        self.procs.insert(pid, ChildState::Running(rx));
        pid
    }

    /// Take the wait-state for `pid`, replacing it with `Done(-1)` as a
    /// placeholder (the caller is responsible for updating it once awaited).
    pub fn take_state(&mut self, pid: i32) -> Option<ChildState> {
        self.procs.insert(pid, ChildState::Done(-1))
    }

    /// Record the exit code after `wait` completes.
    pub fn set_exit_code(&mut self, pid: i32, code: i32) {
        self.procs.insert(pid, ChildState::Done(code));
    }

    /// Non-blocking check.  Returns the exit code if the child is done,
    /// `None` if it is still running or unknown.
    pub fn poll_exit(&mut self, pid: i32) -> Option<i32> {
        match self.procs.get_mut(&pid)? {
            ChildState::Done(code) => Some(*code),
            ChildState::Running(rx) => match rx.try_recv() {
                Ok(code) => {
                    self.procs.insert(pid, ChildState::Done(code));
                    Some(code)
                }
                Err(_) => None,
            },
        }
    }

    /// Snapshot all processes for `host_list_processes`.
    pub fn list(&self) -> Vec<ProcessInfo> {
        self.procs
            .iter()
            .map(|(&pid, state)| match state {
                ChildState::Running(_) => ProcessInfo { pid, state: "running", exit_code: None },
                ChildState::Done(code) => ProcessInfo { pid, state: "done", exit_code: Some(*code) },
            })
            .collect()
    }
}
