use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 443);
    let stream = TcpStream::connect(addr).expect("connect stream");

    stream.set_nodelay(true).expect("enable TCP_NODELAY");
    assert!(stream.nodelay().expect("read TCP_NODELAY"), "TCP_NODELAY is enabled");

    stream.set_nodelay(false).expect("disable TCP_NODELAY");
    assert!(!stream.nodelay().expect("read TCP_NODELAY"), "TCP_NODELAY is disabled");

    println!("nodelay=ok");
}
