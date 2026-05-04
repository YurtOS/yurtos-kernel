use std::io::{Read, Write};
use std::net::TcpStream;

fn main() {
    let mut stream = TcpStream::connect(("example.test", 443)).expect("connect by hostname");
    stream.write_all(b"ping").expect("write request");

    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).expect("read reply");

    println!("reply={}", std::str::from_utf8(&reply).unwrap());
    assert_eq!(&reply, b"pong");
}
