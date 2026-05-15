//! Subset of the native-syscall ABI constants the kernel needs at the
//! dispatch layer. Authoritative source remains
//! `abi/contract/yurt_abi.toml` — these are hand-mirrored until the code
//! generator produces a Rust crate we can depend on directly.

pub const EPERM: i32 = 1;
pub const ENOENT: i32 = 2;
pub const ESRCH: i32 = 3;
pub const ECHILD: i32 = 10;
pub const EBADF: i32 = 9;
pub const EIO: i32 = 5;
pub const EAGAIN: i32 = 11;
pub const EBUSY: i32 = 16;
pub const EFAULT: i32 = 14;
pub const EXDEV: i32 = 18;
pub const EEXIST: i32 = 17;
pub const ENOTDIR: i32 = 20;
pub const EINVAL: i32 = 22;
pub const ENOSYS: i32 = 38;
pub const EDEADLK: i32 = 35;
pub const EPIPE: i32 = 32;
pub const ENOTSOCK: i32 = 88;
pub const EADDRINUSE: i32 = 98;
pub const ENOTCONN: i32 = 107;
pub const ECONNREFUSED: i32 = 111;
pub const EPROTOTYPE: i32 = 91;
pub const EOPNOTSUPP: i32 = 95;
pub const EAFNOSUPPORT: i32 = 97;
