use yurt_process::Command;

fn main() {
    let status = Command::new("/child-exit7.wasm")
        .status()
        .expect("spawn failed");
    println!("child exited {}", status.code().unwrap_or(-1));
    std::process::exit(0);
}
