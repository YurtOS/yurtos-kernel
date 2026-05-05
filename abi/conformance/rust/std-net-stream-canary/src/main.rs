use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 9);
    let mut stream = TcpStream::connect(addr).expect("connect stream");
    stream.write_all(b"ping").expect("write stream");

    let mut buf = [0u8; 4];
    stream.read_exact(&mut buf).expect("read stream");

    println!("reply={}", std::str::from_utf8(&buf).unwrap());
}
