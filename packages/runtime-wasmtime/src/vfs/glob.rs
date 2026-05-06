//! Glob pattern matching for the virtual filesystem.
//!
//! Supports:
//!   `*`       — any sequence of non-`/` characters
//!   `?`       — any single non-`/` character
//!   `[abc]`   — character class
//!   `[!abc]` / `[^abc]` — negated character class
//!   `**`      — any path segments, including `/`
//!   `**/`     — any path prefix including empty

/// Returns true if `path` matches `pattern`.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    match_impl(pattern.as_bytes(), path.as_bytes())
}

fn match_impl(pat: &[u8], s: &[u8]) -> bool {
    // Both exhausted → match
    if pat.is_empty() {
        return s.is_empty();
    }

    // `**` — matches any sequence of characters including `/`
    if pat.starts_with(b"**") {
        // consume the `**` and an optional following `/`
        let rest = if pat.get(2) == Some(&b'/') { &pat[3..] } else { &pat[2..] };
        // try matching `rest` against every suffix of `s`
        for i in 0..=s.len() {
            if match_impl(rest, &s[i..]) {
                return true;
            }
        }
        return false;
    }

    // String exhausted but pattern has non-`*` tokens remaining → no match
    if s.is_empty() {
        return pat.iter().all(|&c| c == b'*');
    }

    match pat[0] {
        b'?' => {
            // matches any single non-`/` character
            s[0] != b'/' && match_impl(&pat[1..], &s[1..])
        }
        b'*' => {
            // matches zero or more non-`/` characters: try all options
            match_impl(&pat[1..], s)                      // zero chars
                || (s[0] != b'/' && match_impl(pat, &s[1..])) // one more char
        }
        b'[' => match match_class(pat, s[0]) {
            Some((matched, consumed)) => matched && match_impl(&pat[consumed..], &s[1..]),
            None => false,
        },
        c => c == s[0] && match_impl(&pat[1..], &s[1..]),
    }
}

/// Parse a `[...]` character class at `pat[0]`.
/// Returns `Some((matched, bytes_consumed_from_pat))` or `None` on malformed class.
fn match_class(pat: &[u8], c: u8) -> Option<(bool, usize)> {
    debug_assert_eq!(pat[0], b'[');
    let negate = matches!(pat.get(1), Some(b'!') | Some(b'^'));
    let start = if negate { 2 } else { 1 };
    let mut i = start;
    let mut matched = false;

    while i < pat.len() && pat[i] != b']' {
        if i + 2 < pat.len() && pat[i + 1] == b'-' && pat[i + 2] != b']' {
            if c >= pat[i] && c <= pat[i + 2] {
                matched = true;
            }
            i += 3;
        } else {
            if c == pat[i] {
                matched = true;
            }
            i += 1;
        }
    }

    if i >= pat.len() {
        return None; // unclosed `[`
    }

    Some((if negate { !matched } else { matched }, i + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match() {
        assert!(glob_match("foo.rs", "foo.rs"));
        assert!(!glob_match("foo.rs", "bar.rs"));
    }

    #[test]
    fn star_matches_filename() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs")); // * does not cross /
    }

    #[test]
    fn double_star_crosses_dirs() {
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "a/b/c.rs"));
        assert!(!glob_match("**/*.rs", "a/b/c.txt"));
        // Absolute paths
        assert!(glob_match("/tmp/**/*.rs", "/tmp/a/b.rs"));
        assert!(glob_match("/tmp/*.rs", "/tmp/a.rs"));
    }

    #[test]
    fn double_star_empty_prefix() {
        // `**/*.rs` should also match a filename at the root of the pattern
        assert!(glob_match("**/*.rs", "main.rs"));
    }

    #[test]
    fn question_mark() {
        assert!(glob_match("foo?.rs", "foox.rs"));
        assert!(!glob_match("foo?.rs", "foo/x.rs")); // ? does not cross /
        assert!(!glob_match("foo?.rs", "foo.rs"));   // requires exactly one char
    }

    #[test]
    fn char_class() {
        assert!(glob_match("[abc].rs", "a.rs"));
        assert!(!glob_match("[abc].rs", "d.rs"));
        assert!(glob_match("[!abc].rs", "d.rs"));
        assert!(!glob_match("[!abc].rs", "a.rs"));
        assert!(glob_match("[a-z].rs", "m.rs"));
        assert!(!glob_match("[a-z].rs", "M.rs"));
    }

    #[test]
    fn trailing_star() {
        assert!(glob_match("/tmp/*", "/tmp/anything"));
        assert!(!glob_match("/tmp/*", "/tmp/a/b")); // * does not cross /
    }
}
