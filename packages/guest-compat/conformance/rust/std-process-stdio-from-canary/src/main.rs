use std::process::{Command, Stdio};

fn main() {
    let mut producer = Command::new("printf")
        .arg("from-child-stdout")
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn producer");

    let producer_stdout = producer.stdout.take().expect("producer stdout");
    assert_eq!(producer.wait().expect("wait producer").code(), Some(0));

    let output = Command::new("cat")
        .stdin(producer_stdout)
        .stdout(Stdio::piped())
        .output()
        .expect("run consumer");

    let stdout = String::from_utf8(output.stdout).expect("stdout utf8");
    println!("status={:?} stdout={:?}", output.status.code(), stdout);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(stdout, "from-child-stdout");
}
