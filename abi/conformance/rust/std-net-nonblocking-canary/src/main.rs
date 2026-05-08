use std::io::{ErrorKind, Read};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 443);
    let mut stream = TcpStream::connect(addr).expect("connect stream");
    stream.set_nonblocking(true).expect("enable nonblocking");

    let mut buf = [0_u8; 3];
    let err = stream
        .read(&mut buf)
        .expect_err("nonblocking read should not block");
    assert_eq!(err.kind(), ErrorKind::WouldBlock);

    println!("nonblocking=ok");
}
