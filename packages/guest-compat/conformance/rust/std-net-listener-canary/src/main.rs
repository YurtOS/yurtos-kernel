use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};

fn main() {
    let port = 18082;
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let listener = TcpListener::bind(addr).expect("bind loopback listener");
    let mut client = TcpStream::connect(addr).expect("connect loopback listener");
    client.write_all(b"ping").expect("write ping");

    let (mut stream, peer) = listener.accept().expect("accept client");
    assert_eq!(peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    let mut buf = [0_u8; 4];
    stream.read_exact(&mut buf).expect("read ping");
    assert_eq!(&buf, b"ping");
    stream.write_all(b"pong").expect("write pong");

    let mut reply = [0_u8; 4];
    client.read_exact(&mut reply).expect("read pong");
    assert_eq!(&reply, b"pong");
    println!("std-net-listener=ok");
}
