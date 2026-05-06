//! Path normalization for the virtual filesystem.
//!
//! All paths are absolute and POSIX-style.  Component sequences like `..` and
//! `.` are resolved statically (no symlink resolution — that happens in VFS
//! traversal).

/// Normalize an absolute path into a clean component sequence.
///
/// Returns `None` if the path is relative (does not start with `/`).
///
/// Examples:
///   `/home/user/../tmp/./foo` → `["home", "tmp", "foo"]`
///   `/`                       → `[]`
pub fn parse_path(path: &str) -> Option<Vec<&str>> {
    if !path.starts_with('/') {
        return None;
    }
    let mut parts = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    Some(parts)
}

/// Rebuild a canonical absolute path string from a component slice.
pub fn join_path(parts: &[&str]) -> String {
    if parts.is_empty() {
        return "/".to_owned();
    }
    let mut s = String::new();
    for p in parts {
        s.push('/');
        s.push_str(p);
    }
    s
}

/// Split a path into (parent_parts, filename).
///
/// Returns `None` for the root path `/`.
pub fn split_path(path: &str) -> Option<(Vec<&str>, &str)> {
    let parts = parse_path(path)?;
    if parts.is_empty() {
        return None; // root has no parent
    }
    let name = *parts.last().unwrap();
    let parent = parts[..parts.len() - 1].to_vec();
    Some((parent, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_dots() {
        assert_eq!(parse_path("/home/user/../tmp/./foo"), Some(vec!["home", "tmp", "foo"]));
    }

    #[test]
    fn root_is_empty() {
        assert_eq!(parse_path("/"), Some(vec![]));
    }

    #[test]
    fn relative_fails() {
        assert_eq!(parse_path("home/user"), None);
    }

    #[test]
    fn join_roundtrip() {
        let parts = vec!["home", "user"];
        assert_eq!(join_path(&parts), "/home/user");
        assert_eq!(join_path(&[]), "/");
    }
}
