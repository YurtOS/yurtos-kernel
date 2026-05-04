use std::io::{self, Read, Write};

fn main() {
    let mut buffer = Vec::new();
    io::stdin().read_to_end(&mut buffer).unwrap();
    io::stdout().write_all(&buffer).unwrap();
}
