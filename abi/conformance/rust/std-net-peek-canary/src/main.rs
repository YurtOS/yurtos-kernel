use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 443);
    let mut stream = TcpStream::connect(addr).expect("connect stream");

    let mut peeked = [0_u8; 3];
    let n = stream.peek(&mut peeked).expect("peek stream");
    assert_eq!(n, 3);
    assert_eq!(&peeked, b"abc");

    let mut read = [0_u8; 3];
    stream.read_exact(&mut read).expect("read stream");
    assert_eq!(&read, b"abc");

    println!("peek=ok");
}
