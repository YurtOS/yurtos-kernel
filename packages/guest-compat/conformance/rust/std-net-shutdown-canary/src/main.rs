use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 9);
    let stream = TcpStream::connect(addr).expect("connect stream");
    stream.shutdown(Shutdown::Both).expect("shutdown stream");
    println!("shutdown=both");
}
