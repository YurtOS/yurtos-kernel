use std::io::Read;
use std::process::{Command, Stdio};

fn main() {
    let mut child = Command::new("printf")
        .arg("child-stdout")
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn printf");

    let mut stdout = child.stdout.take().expect("child stdout");
    let status = child.wait().expect("wait child");

    let mut text = String::new();
    stdout.read_to_string(&mut text).expect("read child stdout");

    println!("status={:?} stdout={:?}", status.code(), text);

    assert_eq!(status.code(), Some(0));
    assert_eq!(text, "child-stdout");
}
