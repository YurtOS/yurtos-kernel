use std::io::Write;
use std::process::{Command, Stdio};

fn main() {
    let mut child = Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn cat");

    child
        .stdin
        .as_mut()
        .expect("stdin pipe")
        .write_all(b"spawn-stdin\n")
        .expect("write child stdin");
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait with output");
    let stdout = String::from_utf8(output.stdout).expect("stdout utf8");
    let stderr = String::from_utf8(output.stderr).expect("stderr utf8");

    println!(
        "status={:?} stdout={:?} stderr={:?}",
        output.status.code(),
        stdout,
        stderr,
    );

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout, "spawn-stdin\n");
    assert_eq!(stderr, "");
}
