use std::process::Command;

fn main() {
    let ok = Command::new("true").status().expect("spawn true");
    println!("true success={} code={:?}", ok.success(), ok.code());
    assert!(ok.success());
    assert_eq!(ok.code(), Some(0));

    let bad = Command::new("false").status().expect("spawn false");
    println!("false success={} code={:?}", bad.success(), bad.code());
    assert!(!bad.success());
    assert_eq!(bad.code(), Some(1));
}
