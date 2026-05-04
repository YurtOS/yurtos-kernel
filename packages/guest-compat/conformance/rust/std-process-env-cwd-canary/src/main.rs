use std::fs;
use std::process::Command;

fn main() {
    let env_output = Command::new("env")
        .env("YURT_STD_PROCESS_CANARY", "ok")
        .output()
        .expect("run env");
    let env_stdout = String::from_utf8(env_output.stdout).expect("env stdout utf8");
    println!("env-status={:?}", env_output.status.code());
    assert!(env_stdout.contains("YURT_STD_PROCESS_CANARY=ok"));

    fs::create_dir_all("/tmp/std-process-cwd").expect("create cwd dir");
    fs::write("/tmp/std-process-cwd/marker.txt", b"cwd-ok").expect("write cwd marker");

    let cwd_output = Command::new("ls")
        .current_dir("/tmp/std-process-cwd")
        .output()
        .expect("run ls with cwd");
    let cwd_stdout = String::from_utf8(cwd_output.stdout).expect("ls stdout utf8");
    let cwd_stderr = String::from_utf8(cwd_output.stderr).expect("ls stderr utf8");
    println!(
        "cwd-status={:?} cwd-stdout={:?} cwd-stderr={:?}",
        cwd_output.status.code(),
        cwd_stdout,
        cwd_stderr,
    );
    assert!(cwd_stdout.contains("marker.txt"));
}
