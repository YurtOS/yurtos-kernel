//! Subset of the native-syscall ABI constants the kernel needs at the
//! dispatch layer. Authoritative source remains
//! `abi/contract/yurt_abi.toml` — these are hand-mirrored until the code
//! generator produces a Rust crate we can depend on directly.

pub const EPERM: i32 = 1;
pub const EBADF: i32 = 9;
pub const EINVAL: i32 = 22;
pub const ENOSYS: i32 = 38;
