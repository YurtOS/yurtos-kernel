//! Inode types for the in-memory virtual filesystem.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Timestamp in milliseconds since the Unix epoch.
pub type TimeMs = u64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InodeMeta {
    pub permissions: u32,
    pub mtime: TimeMs,
    pub ctime: TimeMs,
    pub atime: TimeMs,
}

impl InodeMeta {
    pub fn new(permissions: u32) -> Self {
        let now = now_ms();
        Self {
            permissions,
            mtime: now,
            ctime: now,
            atime: now,
        }
    }
}

/// An inode in the virtual filesystem.
///
/// File content is wrapped in `Arc<Vec<u8>>` for copy-on-write semantics:
/// snapshot/fork clones share the same Arc; a write replaces the Arc rather
/// than mutating the vec, so the other clone still sees the old bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Inode {
    File {
        meta: InodeMeta,
        /// Shared by reference between clones; replaced (not mutated) on write.
        content: Arc<Vec<u8>>,
    },
    Dir {
        meta: InodeMeta,
        /// Alphabetically-ordered for deterministic readdir output.
        children: std::collections::BTreeMap<String, Inode>,
    },
    Symlink {
        meta: InodeMeta,
        target: String,
    },
}

impl Inode {
    pub fn new_file(permissions: u32, content: Vec<u8>) -> Self {
        Self::File {
            meta: InodeMeta::new(permissions),
            content: Arc::new(content),
        }
    }

    pub fn new_dir(permissions: u32) -> Self {
        Self::Dir {
            meta: InodeMeta::new(permissions),
            children: std::collections::BTreeMap::new(),
        }
    }

    pub fn new_symlink(target: String) -> Self {
        Self::Symlink {
            meta: InodeMeta::new(0o777),
            target,
        }
    }

    pub fn meta(&self) -> &InodeMeta {
        match self {
            Self::File { meta, .. } | Self::Dir { meta, .. } | Self::Symlink { meta, .. } => meta,
        }
    }

    pub fn meta_mut(&mut self) -> &mut InodeMeta {
        match self {
            Self::File { meta, .. } | Self::Dir { meta, .. } | Self::Symlink { meta, .. } => meta,
        }
    }

    pub fn is_dir(&self) -> bool {
        matches!(self, Self::Dir { .. })
    }

    pub fn is_file(&self) -> bool {
        matches!(self, Self::File { .. })
    }

    pub fn is_symlink(&self) -> bool {
        matches!(self, Self::Symlink { .. })
    }

    pub fn byte_len(&self) -> usize {
        match self {
            Self::File { content, .. } => content.len(),
            _ => 0,
        }
    }
}

/// Result of a stat call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatResult {
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: usize,
    pub permissions: u32,
    pub mtime: TimeMs,
    pub ctime: TimeMs,
    pub atime: TimeMs,
}

/// A single directory entry (matches TypeScript `DirEntry`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Current time in milliseconds since the Unix epoch.
pub fn now_ms() -> TimeMs {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
