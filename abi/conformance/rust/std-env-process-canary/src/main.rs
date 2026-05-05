fn main() {
    println!("home={}", std::env::home_dir().unwrap().display());
    println!("exe={}", std::env::current_exe().unwrap().display());
    println!("pid={}", std::process::id());
}
