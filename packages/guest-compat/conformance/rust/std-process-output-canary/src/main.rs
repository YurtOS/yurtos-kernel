use std::process::Command;

fn main() {
    let output = Command::new("printf")
        .arg("hello-%s")
        .arg("rust")
        .output()
        .expect("run printf");

    println!(
        "status={:?} stdout={:?} stderr={:?}",
        output.status.code(),
        String::from_utf8(output.stdout).expect("stdout utf8"),
        String::from_utf8(output.stderr).expect("stderr utf8"),
    );

    assert_eq!(output.status.code(), Some(0));
}
