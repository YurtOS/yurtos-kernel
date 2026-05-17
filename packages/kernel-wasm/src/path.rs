//! POSIX path resolution for process-relative syscall paths.
//!
//! Dispatch owns syscall wire decoding; VFS owns storage. This module
//! is the boundary between them: it turns caller-provided path bytes
//! into canonical absolute byte paths before VFS operations see them.

use crate::{abi, kernel::Kernel};

pub struct PathResolver<'kernel> {
    kernel: &'kernel mut Kernel,
    caller_pid: u32,
}

impl<'kernel> PathResolver<'kernel> {
    pub fn new(kernel: &'kernel mut Kernel, caller_pid: u32) -> Self {
        Self { kernel, caller_pid }
    }

    /// Resolve cwd, `/proc/self`, and lexical `.` / `..` components.
    ///
    /// This intentionally does not follow symlinks. It is the right
    /// operation for create target paths, link names, unlink, chmod,
    /// and VFS operations where the backend decides final semantics.
    pub fn normalize(&mut self, raw_path: &[u8]) -> Result<Vec<u8>, i64> {
        let rewritten = proc_self_rewrite(self.caller_pid, raw_path);
        let cwd = self.kernel.process(self.caller_pid).cwd.clone();
        normalize_lexical_path(&cwd, &rewritten)
    }

    /// Resolve a path to an existing VFS entry, following symlinks.
    ///
    /// Used for `realpath`, where POSIX requires a canonical existing
    /// pathname rather than just a normalized lexical target.
    pub fn realpath(&mut self, raw_path: &[u8]) -> Result<Vec<u8>, i32> {
        let rewritten = proc_self_rewrite(self.caller_pid, raw_path);
        let cwd = self.kernel.process(self.caller_pid).cwd.clone();
        resolve_realpath(self.kernel, &cwd, &rewritten)
    }
}

pub fn proc_target_pid(path: &[u8]) -> Option<u32> {
    let rest = path.strip_prefix(b"/proc/")?;
    let end = rest.iter().position(|b| *b == b'/').unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    std::str::from_utf8(&rest[..end]).ok()?.parse().ok()
}

fn proc_self_rewrite<'a>(caller_pid: u32, path: &'a [u8]) -> std::borrow::Cow<'a, [u8]> {
    if let Some(suffix) = path.strip_prefix(b"/proc/self") {
        if suffix.is_empty() || suffix.starts_with(b"/") {
            let prefix = format!("/proc/{caller_pid}");
            let mut buf = prefix.into_bytes();
            buf.extend_from_slice(suffix);
            return std::borrow::Cow::Owned(buf);
        }
    }
    std::borrow::Cow::Borrowed(path)
}

fn join_components(components: &[Vec<u8>]) -> Vec<u8> {
    if components.is_empty() {
        return b"/".to_vec();
    }
    let mut out = Vec::new();
    for component in components {
        out.push(b'/');
        out.extend_from_slice(component);
    }
    out
}

fn split_components(path: &[u8]) -> std::collections::VecDeque<Vec<u8>> {
    path.split(|b| *b == b'/')
        .filter(|part| !part.is_empty())
        .map(|part| part.to_vec())
        .collect()
}

fn absolute_from_cwd(cwd: &[u8], path: &[u8]) -> Vec<u8> {
    if path.starts_with(b"/") {
        return path.to_vec();
    }
    let mut out = if cwd.is_empty() {
        b"/".to_vec()
    } else {
        cwd.to_vec()
    };
    if !out.ends_with(b"/") {
        out.push(b'/');
    }
    out.extend_from_slice(path);
    out
}

fn normalize_lexical_path(cwd: &[u8], path: &[u8]) -> Result<Vec<u8>, i64> {
    if path.is_empty() || path.contains(&0) {
        return Err(-(abi::EINVAL as i64));
    }
    let mut components = Vec::new();
    for component in split_components(&absolute_from_cwd(cwd, path)) {
        if component == b"." {
            continue;
        }
        if component == b".." {
            components.pop();
            continue;
        }
        components.push(component);
    }
    Ok(join_components(&components))
}

fn append_rest(mut base: Vec<u8>, rest: &std::collections::VecDeque<Vec<u8>>) -> Vec<u8> {
    for component in rest {
        if !base.ends_with(b"/") {
            base.push(b'/');
        }
        base.extend_from_slice(component);
    }
    base
}

fn resolve_realpath(k: &mut Kernel, cwd: &[u8], path: &[u8]) -> Result<Vec<u8>, i32> {
    if path.is_empty() || path.contains(&0) {
        return Err(abi::EINVAL);
    }
    let mut pending = split_components(&absolute_from_cwd(cwd, path));
    let mut resolved: Vec<Vec<u8>> = Vec::new();
    let mut hops = 0u32;

    while let Some(component) = pending.pop_front() {
        if component == b"." {
            continue;
        }
        if component == b".." {
            resolved.pop();
            continue;
        }

        let mut candidate_components = resolved.clone();
        candidate_components.push(component.clone());
        let candidate = join_components(&candidate_components);

        if let Some(target) = k.vfs.readlink(&candidate) {
            hops += 1;
            if hops > 40 {
                return Err(abi::ELOOP);
            }
            let target_path = if target.starts_with(b"/") {
                target
            } else {
                let base = join_components(&resolved);
                append_rest(base, &std::collections::VecDeque::from([target]))
            };
            pending = split_components(&append_rest(target_path, &pending));
            resolved.clear();
            continue;
        }

        let ty = k.vfs.entry_type(&candidate);
        if ty == 0 {
            return Err(abi::ENOENT);
        }
        if !pending.is_empty() && ty != 3 {
            return Err(abi::ENOTDIR);
        }
        resolved.push(component);
    }

    let final_path = join_components(&resolved);
    if k.vfs.entry_type(&final_path) == 0 {
        return Err(abi::ENOENT);
    }
    Ok(final_path)
}
