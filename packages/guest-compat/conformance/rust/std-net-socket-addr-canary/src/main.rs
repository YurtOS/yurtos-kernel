use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 443);
    let stream = TcpStream::connect(addr).expect("connect stream");
    let local = stream.local_addr().expect("local addr");

    println!("local={local}");
    assert!(matches!(local, SocketAddr::V4(v4) if *v4.ip() == Ipv4Addr::new(10, 0, 2, 15) && v4.port() >= 49152));
}
