use std::ffi::OsString;
use std::path::PathBuf;

fn main() {
    let split: Vec<PathBuf> = std::env::split_paths(&OsString::from("/bin:/usr/bin")).collect();
    println!("split={}:{}", split[0].display(), split[1].display());

    let joined = std::env::join_paths([PathBuf::from("/bin"), PathBuf::from("/usr/bin")]).unwrap();
    println!("joined={}", joined.to_string_lossy());

    println!(
        "invalid={}",
        std::env::join_paths([PathBuf::from("/bin:/bad")]).is_err()
    );
}
