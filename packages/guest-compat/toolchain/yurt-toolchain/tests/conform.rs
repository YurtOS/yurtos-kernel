use std::process::Command;

#[test]
fn yurt_conf_runs_end_to_end_when_wasi_sdk_is_available() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skip — WASI_SDK_PATH not set");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_yurt-conf");
    let out = Command::new(bin)
        .arg("--skip-behavioral") // deno may not be on PATH in test runners
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "yurt-conf failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("yurt-conf: OK"), "missing OK: {stdout}");
}
