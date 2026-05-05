use crate::ffi::{OsStr, OsString};
use crate::os::wasi::prelude::*;
use crate::path::PathBuf;
use crate::{env, io};

const DEFAULT_HOME: &str = "/home/yurt";
const DEFAULT_EXE: &str = "/bin/program";
const PATH_SEPARATOR: u8 = b':';

pub fn temp_dir() -> PathBuf {
    PathBuf::from("/tmp")
}

pub fn home_dir() -> Option<PathBuf> {
    Some(PathBuf::from(DEFAULT_HOME))
}

pub fn current_exe() -> io::Result<PathBuf> {
    Ok(env::args_os()
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_EXE)))
}

pub fn getpid() -> u32 {
    1
}

pub fn split_paths(unparsed: &OsStr) -> crate::vec::Vec<PathBuf> {
    unparsed
        .as_bytes()
        .split(|b| *b == PATH_SEPARATOR)
        .map(|part| PathBuf::from(OsStr::from_bytes(part)))
        .collect()
}

pub fn join_paths<I, T>(paths: I) -> Option<OsString>
where
    I: Iterator<Item = T>,
    T: AsRef<OsStr>,
{
    let mut joined = crate::vec::Vec::new();

    for (i, path) in paths.enumerate() {
        let path = path.as_ref().as_bytes();
        if path.contains(&PATH_SEPARATOR) {
            return None;
        }
        if i > 0 {
            joined.push(PATH_SEPARATOR);
        }
        joined.extend_from_slice(path);
    }

    Some(OsString::from_vec(joined))
}
