use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 9);
    let stream = TcpStream::connect(addr).expect("connect stream");
    let peer = stream.peer_addr().expect("peer addr");

    println!("peer={peer}");
    assert_eq!(peer, SocketAddr::V4(addr));
}
