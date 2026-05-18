//! T1 fixture: fork() then the child immediately exec()s a known
//! program; the parent emits its role and exits. Distinguishes a real
//! continuation (two roles, child path reached) from a rebuild.
//!
//! The child uses `yurt_process::Command` (the same surface `spawn-wait`
//! uses — the only exec-adjacent API the yurt_process crate exposes).
//! Parent emits `fork-exec parent forked rc=pid` and exits 0.
//! Child emits `fork-exec child exec=/child-exit7.wasm`, runs it, then
//! exits 0.  On fork errno, emits `fork-exec errno rc=<n>` and exits
//! abs(errno).
//!
//! Asyncify buffer exports mirror `fork-twice`; required for T1.5+
//! bridge initialisation.
use std::io::Write;

use yurt_process::Command;

#[link(wasm_import_module = "yurt")]
extern "C" {
    fn host_fork() -> i32;
}

fn emit(role: &str, detail: &str) {
    let line = format!("fork-exec {role} {detail}\n");
    std::io::stdout().write_all(line.as_bytes()).unwrap();
    std::io::stdout().flush().unwrap();
}

// Asyncify save-state buffer — mirrors fork-twice; required by T1.5+
// asyncify bridge initialisation.
const YURT_ASYNCIFY_BUF_SIZE: usize = 65536;

#[repr(align(16))]
struct AlignedBuf([u8; YURT_ASYNCIFY_BUF_SIZE]);

static mut ASYNCIFY_BUF: AlignedBuf = AlignedBuf([0u8; YURT_ASYNCIFY_BUF_SIZE]);

#[export_name = "yurt_asyncify_buf_addr"]
pub unsafe extern "C" fn yurt_asyncify_buf_addr() -> *mut u8 {
    std::ptr::addr_of_mut!(ASYNCIFY_BUF.0) as *mut u8
}

#[export_name = "yurt_asyncify_buf_size"]
pub extern "C" fn yurt_asyncify_buf_size() -> i32 {
    YURT_ASYNCIFY_BUF_SIZE as i32
}

fn main() {
    let rc = unsafe { host_fork() };
    if rc < 0 {
        emit("errno", &format!("rc={rc}"));
        std::process::exit(-rc);
    }
    if rc == 0 {
        // Child: exec a fixed program using the yurt_process Command
        // surface (same API spawn-wait uses — the only exec-adjacent
        // surface the crate exposes; no free exec() fn exists).
        emit("child", "exec=/child-exit7.wasm");
        let _status = Command::new("/child-exit7.wasm").status();
        std::process::exit(0);
    }
    // Parent: rc > 0 is the child pid; emit role and exit.
    emit("parent", &format!("forked rc=pid"));
    std::process::exit(0);
}
