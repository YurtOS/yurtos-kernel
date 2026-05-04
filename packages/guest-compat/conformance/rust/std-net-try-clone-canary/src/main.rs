use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};

fn main() {
    let addr = SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 9);
    let mut stream = TcpStream::connect(addr).expect("connect stream");
    let mut clone = stream.try_clone().expect("clone stream");

    stream.write_all(b"one").expect("write original");
    clone.write_all(b"two").expect("write clone");

    println!("try_clone=ok");
}
