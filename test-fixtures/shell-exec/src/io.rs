/// Write bytes to fd 1.
///
/// Writes directly through `libc::write`, bypassing Rust's stdout wrapper and
/// buffering. On wasm32-wasip1 this still reaches WASI `fd_write(1)`.
pub fn write_stdout(data: &[u8]) {
    let mut offset = 0;
    while offset < data.len() {
        let n = unsafe {
            libc::write(
                1,
                data[offset..].as_ptr() as *const libc::c_void,
                data[offset..].len(),
            )
        };
        if n <= 0 {
            break;
        }
        offset += n as usize;
    }
}

/// Write bytes to fd 2.
pub fn write_stderr(data: &[u8]) {
    let mut offset = 0;
    while offset < data.len() {
        let n = unsafe {
            libc::write(
                2,
                data[offset..].as_ptr() as *const libc::c_void,
                data[offset..].len(),
            )
        };
        if n <= 0 {
            break;
        }
        offset += n as usize;
    }
}

/// Convenience macros for writing formatted output to stdout/stderr via fd.
#[macro_export]
macro_rules! shell_print {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        $crate::io::write_stdout(s.as_bytes());
    }};
}

#[macro_export]
macro_rules! shell_println {
    ($($arg:tt)*) => {{
        let s = format!("{}\n", format_args!($($arg)*));
        $crate::io::write_stdout(s.as_bytes());
    }};
}

#[macro_export]
macro_rules! shell_eprint {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        $crate::io::write_stderr(s.as_bytes());
    }};
}

#[macro_export]
macro_rules! shell_eprintln {
    ($($arg:tt)*) => {{
        let s = format!("{}\n", format_args!($($arg)*));
        $crate::io::write_stderr(s.as_bytes());
    }};
}
