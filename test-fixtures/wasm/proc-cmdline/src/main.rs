use std::fs;
use std::io::Write;

fn main() {
    // Round-trip: read our own cmdline through /proc/self.
    let bytes = fs::read("/proc/self/cmdline").expect("read /proc/self/cmdline");
    std::io::stdout().write_all(&bytes).unwrap();
}
