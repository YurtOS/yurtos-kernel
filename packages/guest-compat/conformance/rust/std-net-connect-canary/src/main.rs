use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 9);
    let err = TcpStream::connect(addr).expect_err("default sandbox has no socket backend");
    println!("kind={:?}", err.kind());

    assert_eq!(err.kind(), ErrorKind::ConnectionRefused);
}
