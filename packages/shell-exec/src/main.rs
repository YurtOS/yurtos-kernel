fn main() {
    // For wasm32-wasip1: main() is a no-op. The host calls __run_command directly.
    // main() must exist because the binary target requires it, and wasm32-wasip1
    // entry point is _start which calls main().
}

// ---------------------------------------------------------------------------
// __run_command export (wasm32 only)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
mod wasm_entry {
    use std::sync::Mutex;
    use std::sync::OnceLock;

    use yurt_shell_exec::control::{ControlFlow, RunResult};
    use yurt_shell_exec::executor::exec_command;
    use yurt_shell_exec::host::WasmHost;
    use yurt_shell_exec::shell_eprintln;
    use yurt_shell_exec::state::ShellState;

    static STATE: OnceLock<Mutex<ShellState>> = OnceLock::new();

    fn get_state() -> &'static Mutex<ShellState> {
        STATE.get_or_init(|| Mutex::new(ShellState::new_default()))
    }

    /// Execute a shell command and write the JSON result into the output buffer.
    ///
    /// # Parameters
    /// - `cmd_ptr` / `cmd_len`: pointer and length of the UTF-8 command string
    /// - `out_ptr` / `out_cap`: pointer and capacity of the caller-allocated output buffer
    ///
    /// # Returns
    /// The number of bytes written to `out_ptr`.
    /// If the output buffer is too small, returns the required size (caller should
    /// allocate a larger buffer and retry).
    #[no_mangle]
    pub extern "C" fn __run_command(
        cmd_ptr: *const u8,
        cmd_len: u32,
        out_ptr: *mut u8,
        out_cap: u32,
    ) -> i32 {
        let cmd_str = unsafe {
            std::str::from_utf8_unchecked(std::slice::from_raw_parts(cmd_ptr, cmd_len as usize))
        };

        let mut state = get_state().lock().unwrap();
        let host = WasmHost;

        // Track command in history
        state.history.push(cmd_str.to_string());

        let ast = yurt_shell::parser::parse(cmd_str);
        let result = match exec_command(&mut state, &host, &ast) {
            Ok(ControlFlow::Normal(r)) => r,
            Ok(ControlFlow::Exit(code)) => RunResult::exit(code),
            Ok(_) => RunResult::empty(),
            Err(e) => {
                shell_eprintln!("{e}");
                RunResult::exit(1)
            }
        };

        // Fire EXIT trap if one is registered
        if let Some(trap_cmd) = state.traps.remove("EXIT") {
            let trap_ast = yurt_shell::parser::parse(&trap_cmd);
            let _ = exec_command(&mut state, &host, &trap_ast);
        }

        // Include env state in result for host sync
        #[derive(serde::Serialize)]
        struct WasmOutput {
            #[serde(flatten)]
            result: RunResult,
            env: std::collections::HashMap<String, String>,
        }
        let output = WasmOutput {
            result,
            env: state.env.clone(),
        };
        let json = serde_json::to_vec(&output).unwrap();
        if json.len() > out_cap as usize {
            return json.len() as i32; // signal: need bigger buffer
        }
        unsafe {
            std::ptr::copy_nonoverlapping(json.as_ptr(), out_ptr, json.len());
        }
        json.len() as i32
    }
}

// ---------------------------------------------------------------------------
// WASM allocator exports -- allow the host to allocate/free guest memory
// ---------------------------------------------------------------------------

/// Allocate `size` bytes of guest memory and return the pointer.
/// Used by the host to prepare buffers before calling into the guest.
#[no_mangle]
pub extern "C" fn __alloc(size: u32) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size as usize, 1).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

/// Free `size` bytes of guest memory starting at `ptr`.
///
/// # Safety
///
/// `ptr` must have been allocated by `__alloc` with the same `size`.
#[no_mangle]
pub unsafe extern "C" fn __dealloc(ptr: *mut u8, size: u32) {
    let layout = std::alloc::Layout::from_size_align(size as usize, 1).unwrap();
    std::alloc::dealloc(ptr, layout);
}
