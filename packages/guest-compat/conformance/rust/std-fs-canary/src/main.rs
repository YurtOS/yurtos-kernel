use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

fn main() {
    let path = Path::new("yurt-std-fs-canary.txt");
    let _ = fs::remove_file(path);

    {
        let mut file = File::create(path).unwrap();
        file.write_all(b"yurt").unwrap();
    }

    let file = OpenOptions::new().read(true).write(true).open(path).unwrap();
    let permissions = fs::metadata(path).unwrap().permissions();
    fs::set_permissions(path, permissions.clone()).unwrap();
    file.set_permissions(permissions).unwrap();

    let canonical = fs::canonicalize(path).unwrap();
    println!("canonical={}", canonical.display());

    let mut text = String::new();
    File::open(path).unwrap().read_to_string(&mut text).unwrap();
    println!("contents={text}");

    fs::remove_file(path).unwrap();
}
