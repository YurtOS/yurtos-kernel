//! Subset of the native-syscall ABI constants the kernel needs at the
//! dispatch layer. Authoritative source remains
//! `abi/contract/yurt_abi.toml` — these are hand-mirrored until the code
//! generator produces a Rust crate we can depend on directly.

pub const EPERM: i32 = 1;
pub const ENOENT: i32 = 2;
pub const ESRCH: i32 = 3;
// Part of the ABI errno set (kh_idb_get returns -E2BIG on a too-small
// output). The only in-crate consumer is the #[cfg(test)] kh idb
// emulation — real wasm/JS hosts return it themselves — so it is dead
// in the non-test lib build; keep it here with the rest of the mirror.
#[allow(dead_code)]
pub const E2BIG: i32 = 7;
pub const ECHILD: i32 = 10;
pub const EBADF: i32 = 9;
pub const EIO: i32 = 5;
pub const EAGAIN: i32 = 11;
pub const EBUSY: i32 = 16;
pub const EFAULT: i32 = 14;
pub const EXDEV: i32 = 18;
pub const EEXIST: i32 = 17;
pub const ENOTDIR: i32 = 20;
pub const EISDIR: i32 = 21;
pub const EINVAL: i32 = 22;
pub const ENOTTY: i32 = 25;
pub const ENOSYS: i32 = 38;
pub const EDEADLK: i32 = 35;
pub const ESPIPE: i32 = 29;
pub const EPIPE: i32 = 32;
pub const EFBIG: i32 = 27;
pub const ENOTSOCK: i32 = 88;
pub const EADDRINUSE: i32 = 98;
pub const ENOTCONN: i32 = 107;
pub const ECONNREFUSED: i32 = 111;
pub const EPROTOTYPE: i32 = 91;
pub const EOPNOTSUPP: i32 = 95;
pub const EAFNOSUPPORT: i32 = 97;
pub const EROFS: i32 = 30;
pub const ENOTEMPTY: i32 = 39;
pub const ELOOP: i32 = 40;
// Numerically-correct mirror completions for the errno set. These are
// the values libc/musl expects; several have no in-crate consumer yet
// (the M-series POSIX-correctness fixes — readlink ENOENT, RO-backend
// EACCES, fd-exhaustion EMFILE, getcwd ERANGE, long-path ENAMETOOLONG,
// non-blocking EWOULDBLOCK — will route through them). Kept here with
// the rest of the mirror, same as `E2BIG`, so call sites can name the
// intent the moment they land instead of re-deriving the number.
#[allow(dead_code)]
pub const EACCES: i32 = 13;
#[allow(dead_code)]
pub const ENFILE: i32 = 23;
pub const EMFILE: i32 = 24;
#[allow(dead_code)]
pub const ERANGE: i32 = 34;
#[allow(dead_code)]
pub const ENAMETOOLONG: i32 = 36;
/// Linux aliases `EWOULDBLOCK` to `EAGAIN` (both 11); defined in terms
/// of `EAGAIN` so the two cannot silently drift, while still letting
/// call sites name the non-blocking intent.
#[allow(dead_code)]
pub const EWOULDBLOCK: i32 = EAGAIN;
