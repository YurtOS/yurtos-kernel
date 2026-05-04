//! Paired Rust canary for §Behavioral Spec dup2.spec.toml. Cases must
//! match exactly the cases in packages/guest-compat/conformance/c/dup2-canary.c
//! — divergence is the failure mode per §Conformance Driver.

use std::io::Write;

extern "C" {
    fn dup2(oldfd: i32, newfd: i32) -> i32;
    fn __errno_location() -> *mut i32;
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

fn case_happy_path() -> i32 {
    let rc = unsafe { dup2(1, 2) };
    if rc < 0 {
        let errno = unsafe { *__errno_location() };
        emit("happy_path", 1, None, Some(errno));
        return 1;
    }
    emit("happy_path", 0, Some("dup2-ok"), None);
    0
}

fn case_invalid_fd() -> i32 {
    unsafe { *__errno_location() = 0 };
    let rc = unsafe { dup2(999, 2) };
    if rc >= 0 {
        emit("invalid_fd", 1, None, None);
        return 1;
    }
    let errno = unsafe { *__errno_location() };
    emit("invalid_fd", 1, None, Some(errno));
    1
}

fn run_case(name: &str) -> i32 {
    match name {
        "happy_path" => case_happy_path(),
        "invalid_fd" => case_invalid_fd(),
        _ => {
            eprintln!("dup2-canary: unknown case {name}");
            2
        }
    }
}

fn list_cases() {
    println!("happy_path");
    println!("invalid_fd");
}

fn smoke_mode() -> i32 {
    let rc = unsafe { dup2(1, 2) };
    if rc < 0 {
        eprintln!("dup2: failed");
        return 1;
    }
    eprintln!("dup2-ok");
    0
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let exit = match argv.len() {
        1 => smoke_mode(),
        2 if argv[1] == "--list-cases" => { list_cases(); 0 }
        3 if argv[1] == "--case" => run_case(&argv[2]),
        _ => {
            eprintln!("usage: dup2-canary [--case <name> | --list-cases]");
            2
        }
    };
    std::process::exit(exit);
}
