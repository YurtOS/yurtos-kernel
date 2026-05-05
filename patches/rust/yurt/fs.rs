use crate::env;
use crate::fs::TryLockError;
use crate::io;
use crate::os::raw::c_int;
use crate::path::{Path, PathBuf};

unsafe extern "C" {
    fn flock(fd: c_int, operation: c_int) -> c_int;
}

const LOCK_SH: c_int = 1;
const LOCK_EX: c_int = 2;
const LOCK_NB: c_int = 4;
const LOCK_UN: c_int = 8;

pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    Ok(env::current_dir()?.join(path))
}

pub fn lock(fd: c_int) -> io::Result<()> {
    cvt_flock(fd, LOCK_EX)
}

pub fn lock_shared(fd: c_int) -> io::Result<()> {
    cvt_flock(fd, LOCK_SH)
}

pub fn try_lock(fd: c_int) -> Result<(), TryLockError> {
    cvt_try_flock(fd, LOCK_EX | LOCK_NB)
}

pub fn try_lock_shared(fd: c_int) -> Result<(), TryLockError> {
    cvt_try_flock(fd, LOCK_SH | LOCK_NB)
}

pub fn unlock(fd: c_int) -> io::Result<()> {
    cvt_flock(fd, LOCK_UN)
}

fn cvt_flock(fd: c_int, operation: c_int) -> io::Result<()> {
    let rc = unsafe { flock(fd, operation) };
    if rc == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

fn cvt_try_flock(fd: c_int, operation: c_int) -> Result<(), TryLockError> {
    match cvt_flock(fd, operation) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => Err(TryLockError::WouldBlock),
        Err(err) => Err(TryLockError::Error(err)),
    }
}
