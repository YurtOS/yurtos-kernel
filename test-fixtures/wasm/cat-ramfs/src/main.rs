use std::fs;
use std::io::Write;

fn main() {
    let bytes = fs::read("/etc/motd").expect("open /etc/motd");
    std::io::stdout().write_all(&bytes).unwrap();
}
