//! Paired Rust canary for §Behavioral Spec getgroups. Cases must
//! match exactly the cases in packages/guest-compat/conformance/c/getgroups-canary.c
//! — divergence is the failure mode per §Conformance Driver.

use std::io::Write;

extern "C" {
    fn getgroups(size: i32, list: *mut u32) -> i32;
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

fn case_count_only() -> i32 {
    let count = unsafe { getgroups(0, std::ptr::null_mut()) };
    if count != 1 {
        emit("count_only", 1, None, None);
        return 1;
    }
    emit("count_only", 0, Some("getgroups:1"), None);
    0
}

fn case_fetch_one() -> i32 {
    let mut groups: [u32; 1] = [99];
    let count = unsafe { getgroups(1, groups.as_mut_ptr()) };
    if count != 1 || groups[0] != 1000 {
        emit("fetch_one", 1, None, None);
        return 1;
    }
    emit("fetch_one", 0, Some("getgroups:1:1000"), None);
    0
}

fn run_case(name: &str) -> i32 {
    match name {
        "count_only" => case_count_only(),
        "fetch_one" => case_fetch_one(),
        _ => {
            eprintln!("getgroups-canary: unknown case {name}");
            2
        }
    }
}

fn list_cases() {
    println!("count_only");
    println!("fetch_one");
}

fn smoke_mode() -> i32 {
    let count = unsafe { getgroups(0, std::ptr::null_mut()) };
    if count != 1 {
        eprintln!("unexpected count");
        return 1;
    }
    let mut groups: [u32; 1] = [0];
    let count2 = unsafe { getgroups(1, groups.as_mut_ptr()) };
    if count2 != 1 {
        eprintln!("unexpected count2");
        return 1;
    }
    println!("getgroups:{}:{}", count2, groups[0]);
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
            eprintln!("usage: getgroups-canary [--case <name> | --list-cases]");
            2
        }
    };
    std::process::exit(exit);
}
