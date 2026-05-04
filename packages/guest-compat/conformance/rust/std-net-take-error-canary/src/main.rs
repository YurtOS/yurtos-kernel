use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 443);
    let stream = TcpStream::connect(addr).expect("connect stream");
    let pending = stream.take_error().expect("take socket error");

    assert!(pending.is_none(), "newly connected stream has pending error");
    println!("take_error=none");
}
