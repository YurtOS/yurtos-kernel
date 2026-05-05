use core::ffi::{c_int, c_void};

const AF_INET: c_int = 1;
const SOCK_STREAM: c_int = 6;
const F_GETFL: c_int = 3;
const F_SETFL: c_int = 4;
const O_NONBLOCK: c_int = 0x0004;
const SOL_SOCKET: c_int = 0;
const SO_TYPE: c_int = 3;

extern "C" {
    fn socket(domain: c_int, ty: c_int, protocol: c_int) -> c_int;
    fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    fn getsockopt(
        fd: c_int,
        level: c_int,
        optname: c_int,
        optval: *mut c_void,
        optlen: *mut u32,
    ) -> c_int;
    fn close(fd: c_int) -> c_int;
}

fn emit(case: &str, exit: i32) {
    println!("{{\"case\":\"{case}\",\"exit\":{exit}}}");
}

fn main() {
    let fd = unsafe { socket(AF_INET, SOCK_STREAM, 0) };
    if fd < 0 {
        emit("socket", 1);
        std::process::exit(1);
    }

    let flags = unsafe { fcntl(fd, F_GETFL) };
    if flags < 0 || flags & O_NONBLOCK != 0 {
        unsafe { close(fd) };
        emit("fcntl_getfl", 1);
        std::process::exit(1);
    }

    if unsafe { fcntl(fd, F_SETFL, flags | O_NONBLOCK) } != 0 {
        unsafe { close(fd) };
        emit("fcntl_setfl_nonblock", 1);
        std::process::exit(1);
    }

    let mut socket_type: c_int = 0;
    let mut len = core::mem::size_of::<c_int>() as u32;
    if unsafe {
        getsockopt(
            fd,
            SOL_SOCKET,
            SO_TYPE,
            (&mut socket_type as *mut c_int).cast(),
            &mut len,
        )
    } != 0
        || socket_type != SOCK_STREAM
    {
        unsafe { close(fd) };
        emit("getsockopt", 1);
        std::process::exit(1);
    }

    if unsafe { close(fd) } != 0 {
        emit("close", 1);
        std::process::exit(1);
    }

    emit("socket_surface", 0);
}
