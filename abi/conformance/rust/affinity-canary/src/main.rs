//! Paired Rust canary for §Behavioral Spec affinity. Cases must
//! match exactly the cases in abi/conformance/c/affinity-canary.c
//! — divergence is the failure mode per §Conformance Driver.

use std::io::Write;

// cpu_set_t from yurt's sched.h:
//   typedef struct { unsigned long __bits[1]; } cpu_set_t;
// On wasm32-wasip1, unsigned long is 4 bytes, so cpu_set_t is 4 bytes.
// CPU_SETSIZE = 8 * sizeof(unsigned long) = 32 (valid CPUs: 0..31)
// CPU_COUNT(set) = (int)CPU_ISSET(0, set) — returns 0 or 1
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct CpuSetT {
    bits: [u32; 1],
}

fn cpu_zero(s: &mut CpuSetT) {
    s.bits[0] = 0;
}

fn cpu_set(cpu: usize, s: &mut CpuSetT) {
    // CPU_SETSIZE = 32; out-of-range writes are no-ops (matching C macro)
    if cpu < 32 {
        s.bits[0] |= 1u32 << cpu;
    }
}

fn cpu_isset(cpu: usize, s: &CpuSetT) -> bool {
    if cpu < 32 {
        (s.bits[0] & (1u32 << cpu)) != 0
    } else {
        false
    }
}

// CPU_COUNT(set) = (int)CPU_ISSET(0, set) per header definition
fn cpu_count(s: &CpuSetT) -> i32 {
    cpu_isset(0, s) as i32
}

extern "C" {
    fn sched_getaffinity(pid: i32, cpusetsize: usize, mask: *mut CpuSetT) -> i32;
    fn sched_setaffinity(pid: i32, cpusetsize: usize, mask: *const CpuSetT) -> i32;
    fn sched_getcpu() -> i32;
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

fn case_get_reports_one_cpu() -> i32 {
    let mut mask = CpuSetT::default();
    cpu_zero(&mut mask);
    let rc = unsafe { sched_getaffinity(0, std::mem::size_of::<CpuSetT>(), &mut mask) };
    if rc != 0 {
        let errno = unsafe { *__errno_location() };
        emit("get_reports_one_cpu", 1, None, Some(errno));
        return 1;
    }
    if cpu_count(&mask) != 1 || !cpu_isset(0, &mask) {
        emit("get_reports_one_cpu", 1, None, None);
        return 1;
    }
    emit("get_reports_one_cpu", 0, Some("affinity:get=1"), None);
    0
}

fn case_set_cpu0_succeeds() -> i32 {
    let mut mask = CpuSetT::default();
    cpu_zero(&mut mask);
    cpu_set(0, &mut mask);
    let rc = unsafe { sched_setaffinity(0, std::mem::size_of::<CpuSetT>(), &mask) };
    if rc != 0 {
        let errno = unsafe { *__errno_location() };
        emit("set_cpu0_succeeds", 1, None, Some(errno));
        return 1;
    }
    emit("set_cpu0_succeeds", 0, Some("affinity:set0=ok"), None);
    0
}

fn case_set_cpu1_einval() -> i32 {
    let mut mask = CpuSetT::default();
    cpu_zero(&mut mask);
    cpu_set(1, &mut mask);
    unsafe { *__errno_location() = 0 };
    let rc = unsafe { sched_setaffinity(0, std::mem::size_of::<CpuSetT>(), &mask) };
    if rc == 0 {
        emit("set_cpu1_einval", 1, None, None);
        return 1;
    }
    let errno = unsafe { *__errno_location() };
    emit("set_cpu1_einval", 1, None, Some(errno));
    1
}

fn case_getcpu_zero() -> i32 {
    let cpu = unsafe { sched_getcpu() };
    if cpu < 0 {
        let errno = unsafe { *__errno_location() };
        emit("getcpu_zero", 1, None, Some(errno));
        return 1;
    }
    if cpu != 0 {
        emit("getcpu_zero", 1, None, None);
        return 1;
    }
    emit("getcpu_zero", 0, Some("affinity:cpu=0"), None);
    0
}

fn run_case(name: &str) -> i32 {
    match name {
        "get_reports_one_cpu" => case_get_reports_one_cpu(),
        "set_cpu0_succeeds" => case_set_cpu0_succeeds(),
        "set_cpu1_einval" => case_set_cpu1_einval(),
        "getcpu_zero" => case_getcpu_zero(),
        _ => {
            eprintln!("affinity-canary: unknown case {name}");
            2
        }
    }
}

fn list_cases() {
    println!("get_reports_one_cpu");
    println!("set_cpu0_succeeds");
    println!("set_cpu1_einval");
    println!("getcpu_zero");
}

fn smoke_mode() -> i32 {
    let mut mask = CpuSetT::default();
    cpu_zero(&mut mask);
    if unsafe { sched_getaffinity(0, std::mem::size_of::<CpuSetT>(), &mut mask) } != 0 {
        eprintln!("sched_getaffinity failed");
        return 1;
    }
    let get_count = cpu_count(&mask);
    cpu_zero(&mut mask);
    cpu_set(0, &mut mask);
    let set0_rc = unsafe { sched_setaffinity(0, std::mem::size_of::<CpuSetT>(), &mask) };
    if set0_rc != 0 {
        eprintln!("sched_setaffinity cpu0 failed");
        return 1;
    }
    cpu_zero(&mut mask);
    cpu_set(1, &mut mask);
    let set1_rc = unsafe { sched_setaffinity(0, std::mem::size_of::<CpuSetT>(), &mask) };
    if set1_rc == 0 {
        eprintln!("sched_setaffinity unexpectedly accepted cpu1");
        return 1;
    }
    let set1_errno = unsafe { *__errno_location() };
    // EINVAL = 22
    if set1_errno != 22 {
        eprintln!("unexpected errno: {set1_errno}");
        return 1;
    }
    println!("affinity:get={get_count},set0={set0_rc},set1=einval");
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
            eprintln!("usage: affinity-canary [--case <name> | --list-cases]");
            2
        }
    };
    std::process::exit(exit);
}
