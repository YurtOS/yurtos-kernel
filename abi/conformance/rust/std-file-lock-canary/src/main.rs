use std::fs::{File, OpenOptions};

fn main() {
    let path = "/tmp/std-file-lock-canary.txt";
    File::create(path).expect("create lock file");

    let shared_a = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open shared a");
    let shared_b = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open shared b");
    shared_a.try_lock_shared().expect("first shared lock");
    shared_b.try_lock_shared().expect("second shared lock");
    shared_a.unlock().expect("unlock first shared");
    shared_b.unlock().expect("unlock second shared");

    let exclusive = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open exclusive");
    let contender = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .expect("open contender");
    exclusive.try_lock().expect("exclusive lock");
    let blocked = contender.try_lock().is_err();
    println!("exclusive-blocks={blocked}");
    assert!(blocked);

    exclusive.unlock().expect("exclusive unlock");
    contender.try_lock().expect("contender lock after unlock");
    contender.unlock().expect("contender unlock");
}
