//! VFS error type — mirrors the TypeScript `Errno` type.

#[derive(Debug, thiserror::Error)]
pub enum VfsError {
    #[error("ENOENT: {0}")]
    NotFound(String),
    #[error("EEXIST: {0}")]
    Exists(String),
    #[error("ENOTDIR: {0}")]
    NotDir(String),
    #[error("EISDIR: {0}")]
    IsDir(String),
    #[error("ENOTEMPTY: {0}")]
    NotEmpty(String),
    #[error("ENOSPC")]
    NoSpace,
    #[error("EROFS")]
    ReadOnly,
    #[error("EACCES")]
    PermissionDenied,
    #[error("ELOOP: symlink depth exceeded")]
    SymlinkLoop,
    #[error("EINVAL: {0}")]
    Invalid(String),
}

pub type VfsResult<T> = Result<T, VfsError>;
