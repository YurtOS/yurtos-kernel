use yurt_shell::ast::{Word, WordPart};

use crate::host::HostInterface;
use crate::state::{ShellFlag, ShellState};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Callback type for executing a command string and returning its stdout.
///
/// Used by command substitution (`$(...)`) to recursively execute inner
/// commands.  The callback receives the current `ShellState` and the raw
/// command string, and returns the captured stdout.
pub type ExecFn<'a> = &'a dyn Fn(&mut ShellState, &str) -> String;

/// Expand all parts of a `Word` into a single string.
///
/// `exec` is an optional callback used to evaluate `$(...)` command
/// substitutions.  Pass `None` when no executor is available (e.g. in
/// unit tests that don't need command substitution).
pub fn expand_word(state: &mut ShellState, word: &Word, exec: Option<ExecFn>) -> String {
    word.parts
        .iter()
        .map(|part| expand_word_part(state, part, exec))
        .collect()
}

/// Determine whether a word's expansion should be subject to word splitting.
///
/// A word needs splitting when it contains a substitution (Variable or
/// CommandSub) but is not quoted.
pub fn word_needs_splitting(word: &Word) -> bool {
    let has_substitution = word
        .parts
        .iter()
        .any(|p| matches!(p, WordPart::CommandSub(_) | WordPart::Variable(_)));
    let is_quoted = word
        .parts
        .iter()
        .any(|p| matches!(p, WordPart::QuotedLiteral(_)));
    has_substitution && !is_quoted
}

/// Expand a list of words, applying word splitting to unquoted substitutions.
///
/// `exec` is an optional callback for command substitution — see [`expand_word`].
pub fn expand_words_with_splitting(
    state: &mut ShellState,
    words: &[Word],
    exec: Option<ExecFn>,
) -> Vec<String> {
    let mut result = Vec::new();
    for w in words {
        let expanded = expand_word(state, w, exec);
        if word_needs_splitting(w) {
            let ifs = state.env.get("IFS").cloned();
            let split: Vec<String> = match &ifs {
                Some(ifs_val) if ifs_val.is_empty() => {
                    // Empty IFS: no splitting
                    vec![expanded.clone()]
                }
                Some(ifs_val) => {
                    // Split on IFS characters
                    let ifs_chars: Vec<char> = ifs_val.chars().collect();
                    let mut parts = Vec::new();
                    let mut current = String::new();
                    for ch in expanded.chars() {
                        if ifs_chars.contains(&ch) {
                            if !current.is_empty() {
                                parts.push(std::mem::take(&mut current));
                            }
                        } else {
                            current.push(ch);
                        }
                    }
                    if !current.is_empty() {
                        parts.push(current);
                    }
                    parts
                }
                None => {
                    // Default IFS: split on whitespace
                    expanded.split_whitespace().map(|s| s.to_string()).collect()
                }
            };
            for s in split {
                if !s.is_empty() {
                    result.push(s);
                }
            }
        } else {
            result.push(expanded);
        }
    }
    result
}

/// Parse a raw assignment value string into a `Word` with proper parts.
///
/// The lexer stores assignment values as raw strings (e.g. `$(echo hi)` is
/// kept literally). This function scans for `$VAR`, `${...}`, `$(cmd)`, and
/// `$((expr))` patterns, producing `WordPart` entries so that `expand_word`
/// properly evaluates substitutions.
pub fn parse_assignment_value(raw: &str) -> Word {
    let chars: Vec<char> = raw.chars().collect();
    let len = chars.len();
    let mut parts: Vec<WordPart> = Vec::new();
    let mut literal = String::new();
    let mut i = 0;

    while i < len {
        if chars[i] == '\\' && i + 1 < len {
            // Escaped character -- keep literally
            literal.push(chars[i + 1]);
            i += 2;
            continue;
        }

        if chars[i] == '$' && i + 1 < len {
            // Flush accumulated literal
            if !literal.is_empty() {
                parts.push(WordPart::Literal(std::mem::take(&mut literal)));
            }

            if chars[i + 1] == '(' {
                if i + 2 < len && chars[i + 2] == '(' {
                    // $((expr)) -- arithmetic expansion
                    let start = i + 3;
                    let mut depth = 1;
                    let mut j = start;
                    while j < len && depth > 0 {
                        if j + 1 < len && chars[j] == '(' && chars[j + 1] == '(' {
                            depth += 1;
                            j += 2;
                        } else if j + 1 < len && chars[j] == ')' && chars[j + 1] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                            j += 2;
                        } else {
                            j += 1;
                        }
                    }
                    let expr: String = chars[start..j].iter().collect();
                    parts.push(WordPart::ArithmeticExpansion(expr));
                    i = if j + 1 < len { j + 2 } else { j };
                } else {
                    // $(cmd) -- command substitution
                    let start = i + 2;
                    let mut depth = 1;
                    let mut j = start;
                    while j < len && depth > 0 {
                        if chars[j] == '(' {
                            depth += 1;
                        } else if chars[j] == ')' {
                            depth -= 1;
                        }
                        if depth > 0 {
                            j += 1;
                        }
                    }
                    let cmd: String = chars[start..j].iter().collect();
                    parts.push(WordPart::CommandSub(cmd));
                    i = j + 1;
                }
            } else if chars[i + 1] == '{' {
                // ${...} -- parameter expansion
                let start = i + 2;
                let mut depth = 1;
                let mut j = start;
                while j < len && depth > 0 {
                    if chars[j] == '{' {
                        depth += 1;
                    } else if chars[j] == '}' {
                        depth -= 1;
                    }
                    if depth > 0 {
                        j += 1;
                    }
                }
                let inner: String = chars[start..j].iter().collect();
                // Parse the parameter expansion into its components
                let part = parse_param_expansion_inner(&inner);
                parts.push(part);
                i = j + 1;
            } else {
                // $VAR -- simple variable
                let start = i + 1;
                let mut j = start;
                // Special single-char variables: $?, $#, $@, $*, $0-$9, $$, $!
                if j < len
                    && (chars[j] == '?'
                        || chars[j] == '#'
                        || chars[j] == '@'
                        || chars[j] == '*'
                        || chars[j] == '$'
                        || chars[j] == '!'
                        || chars[j].is_ascii_digit())
                {
                    j += 1;
                } else {
                    while j < len && (chars[j].is_alphanumeric() || chars[j] == '_') {
                        j += 1;
                    }
                }
                if j > start {
                    let name: String = chars[start..j].iter().collect();
                    parts.push(WordPart::Variable(name));
                } else {
                    // Bare $ not followed by valid variable char
                    literal.push('$');
                }
                i = j;
            }
        } else {
            literal.push(chars[i]);
            i += 1;
        }
    }

    if !literal.is_empty() {
        parts.push(WordPart::Literal(literal));
    }

    if parts.is_empty() {
        parts.push(WordPart::Literal(String::new()));
    }

    Word { parts }
}

/// Parse the inner content of `${...}` into a `WordPart`.
///
/// Handles: `${var}`, `${var:-default}`, `${var:=default}`, `${var:+alt}`,
/// `${var:?err}`, `${#var}`, `${var%pat}`, `${var%%pat}`, `${var#pat}`,
/// `${var##pat}`, `${var^^}`, `${var,,}`, `${var^}`, `${var/pat/repl}`,
/// `${var:off:len}`, etc.
fn parse_param_expansion_inner(inner: &str) -> WordPart {
    // ${#var} -- length
    if inner.starts_with('#') && inner.len() > 1 && !inner.contains(':') {
        return WordPart::ParamExpansion {
            var: inner[1..].to_string(),
            op: "#".to_string(),
            default: String::new(),
        };
    }

    // Find the operator position: look for :-, :=, :+, :?, %, %%, #, ##, ^^, ,,, ^, /, :
    // Try longer operators first
    let ops = [
        "%%", "##", "^^", ",,", ":-", ":=", ":+", ":?", "^", "/", "%", "#", ":",
    ];
    for op in ops {
        if let Some(pos) = inner.find(op) {
            if pos > 0 {
                let var = &inner[..pos];
                let default = &inner[pos + op.len()..];
                return WordPart::ParamExpansion {
                    var: var.to_string(),
                    op: op.to_string(),
                    default: default.to_string(),
                };
            }
        }
    }

    // Simple ${var}
    WordPart::Variable(inner.to_string())
}

// ---------------------------------------------------------------------------
// Brace expansion
// ---------------------------------------------------------------------------

/// Expand braces in a list of already-expanded words.
///
/// Supports comma lists (`{a,b,c}`), numeric ranges (`{1..5}`), alpha
/// ranges (`{a..e}`), and nested braces (`{a,{b,c}}`).  Expansion is
/// recursive so nested and suffixed patterns work correctly.
pub fn expand_braces(words: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    for word in words {
        result.extend(expand_brace(word));
    }
    result
}

/// Expand a single word's brace expressions.
fn expand_brace(word: &str) -> Vec<String> {
    let mut depth: i32 = 0;
    let mut start: Option<usize> = None;

    for (i, ch) in word.char_indices() {
        if ch == '{' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                if let Some(s) = start {
                    let prefix = &word[..s];
                    let inner = &word[s + 1..i];
                    let suffix = &word[i + 1..];

                    // Check for range pattern: {a..z} or {1..10}
                    if let Some((range_start, range_end)) = parse_range_pattern(inner) {
                        let items = expand_range(range_start, range_end);
                        if !items.is_empty() {
                            return items
                                .into_iter()
                                .flat_map(|item| expand_brace(&format!("{prefix}{item}{suffix}")))
                                .collect();
                        }
                    }

                    // Comma-separated list
                    if inner.contains(',') {
                        let items = split_brace_items(inner);
                        if items.len() > 1 {
                            return items
                                .into_iter()
                                .flat_map(|item| expand_brace(&format!("{prefix}{item}{suffix}")))
                                .collect();
                        }
                    }

                    // Not a valid brace expansion
                    return vec![word.to_string()];
                }
            }
        }
    }
    vec![word.to_string()]
}

/// Parse a range pattern like `1..5` or `a..e` from the inner part of braces.
/// Returns `Some((start, end))` if the pattern matches.
fn parse_range_pattern(inner: &str) -> Option<(&str, &str)> {
    let dot_pos = inner.find("..")?;
    let start = &inner[..dot_pos];
    let end = &inner[dot_pos + 2..];

    // Validate: both parts must be non-empty and consist of word chars
    // (alphanumeric or minus sign for negative numbers)
    if start.is_empty() || end.is_empty() {
        return None;
    }

    // Ensure the pattern is exactly start..end (no extra dots)
    if end.starts_with('.') {
        return None;
    }

    // Both sides must match -?\w+
    let valid_range_part = |s: &str| -> bool {
        let s = s.strip_prefix('-').unwrap_or(s);
        !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
    };

    if valid_range_part(start) && valid_range_part(end) {
        Some((start, end))
    } else {
        None
    }
}

/// Expand a range (numeric or alpha) into a list of items.
fn expand_range(start: &str, end: &str) -> Vec<String> {
    // Try numeric range
    if let (Ok(start_num), Ok(end_num)) = (start.parse::<i64>(), end.parse::<i64>()) {
        let step: i64 = if start_num <= end_num { 1 } else { -1 };
        let mut items = Vec::new();
        let mut i = start_num;
        loop {
            items.push(i.to_string());
            if i == end_num {
                break;
            }
            i += step;
        }
        return items;
    }

    // Try alpha range (single characters)
    if start.len() == 1 && end.len() == 1 {
        let s = start.as_bytes()[0];
        let e = end.as_bytes()[0];
        let step: i16 = if s <= e { 1 } else { -1 };
        let mut items = Vec::new();
        let mut i = s as i16;
        loop {
            items.push(String::from(i as u8 as char));
            if i == e as i16 {
                break;
            }
            i += step;
        }
        return items;
    }

    vec![]
}

/// Split the inner content of a brace expression on commas, respecting
/// nested brace depth.
fn split_brace_items(inner: &str) -> Vec<String> {
    let mut depth: i32 = 0;
    let mut current = String::new();
    let mut items = Vec::new();

    for ch in inner.chars() {
        if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
        }

        if ch == ',' && depth == 0 {
            items.push(current);
            current = String::new();
        } else {
            current.push(ch);
        }
    }
    items.push(current);
    items
}

// ---------------------------------------------------------------------------
// Sentinel restoration
// ---------------------------------------------------------------------------

/// Restore brace sentinels that were inserted by QuotedLiteral expansion.
///
/// During word expansion, `QuotedLiteral` replaces `{` with `\u{E000}` and
/// `}` with `\u{E001}` to prevent brace expansion.  After brace expansion
/// is complete, these sentinels must be restored (but glob sentinels are
/// kept intact for the glob expansion step).
pub fn restore_brace_sentinels(words: &[String]) -> Vec<String> {
    words
        .iter()
        .map(|w| w.replace('\u{E000}', "{").replace('\u{E001}', "}"))
        .collect()
}

/// Restore glob sentinels that were inserted by QuotedLiteral expansion.
///
/// Must be called AFTER glob expansion so that quoted glob characters
/// (`*`, `?`, `[`, `]`) are not expanded as globs.
pub fn restore_glob_sentinels(words: &[String]) -> Vec<String> {
    words
        .iter()
        .map(|w| {
            w.replace('\u{E002}', "*")
                .replace('\u{E003}', "?")
                .replace('\u{E004}', "[")
                .replace('\u{E005}', "]")
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Glob expansion (filesystem)
// ---------------------------------------------------------------------------

/// Expand glob patterns (`*`, `?`) in a word list using the host's glob
/// implementation.
///
/// For each word containing `*` or `?`, calls `host.glob(pattern)`.  If the
/// host returns matches they are used (sorted); otherwise the literal pattern
/// is preserved (POSIX behavior).
///
/// Relative patterns are resolved against `cwd` and results are returned
/// as relative paths (stripping the cwd prefix).
pub fn expand_globs(host: &dyn HostInterface, words: &[String], cwd: &str) -> Vec<String> {
    let mut result = Vec::new();
    for word in words {
        if word.contains('*') || word.contains('?') || word.contains('[') {
            // Resolve relative patterns against cwd
            let (pattern, is_relative) = if word.starts_with('/') {
                (word.clone(), false)
            } else {
                let abs = if cwd == "/" {
                    format!("/{word}")
                } else {
                    format!("{cwd}/{word}")
                };
                (abs, true)
            };
            match host.glob(&pattern) {
                Ok(mut matches) if !matches.is_empty() => {
                    matches.sort();
                    if is_relative {
                        // Strip cwd prefix to return relative paths
                        let prefix = if cwd.ends_with('/') {
                            cwd.to_string()
                        } else {
                            format!("{cwd}/")
                        };
                        result.extend(
                            matches
                                .into_iter()
                                .map(|m| m.strip_prefix(&prefix).unwrap_or(&m).to_string()),
                        );
                    } else {
                        result.extend(matches);
                    }
                }
                _ => result.push(word.clone()),
            }
        } else {
            result.push(word.clone());
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Word expansion internals
// ---------------------------------------------------------------------------

/// Expand a single `WordPart` into a string.
///
/// Takes `&mut ShellState` because the `:=` operator can mutate the
/// environment.
///
/// `exec` is an optional callback for command substitution — see [`expand_word`].
pub fn expand_word_part(state: &mut ShellState, part: &WordPart, exec: Option<ExecFn>) -> String {
    match part {
        WordPart::Literal(s) => expand_literal(s, state),

        WordPart::QuotedLiteral(s) => {
            // Protect special characters inside quoted literals so they survive
            // brace expansion and glob expansion.  Uses Private Use Area chars.
            s.replace('{', "\u{E000}")
                .replace('}', "\u{E001}")
                .replace('*', "\u{E002}")
                .replace('?', "\u{E003}")
                .replace('[', "\u{E004}")
                .replace(']', "\u{E005}")
        }

        WordPart::Variable(name) => expand_variable(state, name),

        WordPart::CommandSub(cmd_str) => {
            if state.substitution_depth >= crate::state::MAX_SUBSTITUTION_DEPTH {
                return String::new(); // prevent infinite recursion
            }
            if let Some(exec_fn) = exec {
                state.substitution_depth += 1;
                let result = exec_fn(state, cmd_str);
                state.substitution_depth -= 1;
                // Strip trailing newline (standard shell behavior)
                result.trim_end_matches('\n').to_string()
            } else {
                String::new() // no executor available
            }
        }

        WordPart::ProcessSub(_) => {
            // Handled by resolve_process_subs before expansion.
            String::new()
        }

        WordPart::OutputProcessSub(_) => {
            // Handled by resolve_process_subs before expansion.
            String::new()
        }

        WordPart::ParamExpansion { var, op, default } => expand_param(state, var, op, default),

        WordPart::ArithmeticExpansion(expr) => {
            // Pre-expand $(cmd) command substitutions inside the arithmetic expression
            let expanded_expr = expand_command_subs_in_string(state, expr, exec);
            crate::arithmetic::eval_arithmetic(state, &expanded_expr).to_string()
        }
    }
}

// ---------------------------------------------------------------------------
// Literal and tilde expansion
// ---------------------------------------------------------------------------

fn expand_literal(s: &str, state: &ShellState) -> String {
    if s == "~" {
        return state
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/home/user".to_string());
    }
    if let Some(rest) = s.strip_prefix("~/") {
        let home = state
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/home/user".to_string());
        return format!("{home}/{rest}");
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Variable expansion ($VAR, $?, $#, $@, $*, $0–$9, specials)
// ---------------------------------------------------------------------------

fn expand_variable(state: &mut ShellState, name: &str) -> String {
    // Special variables
    match name {
        "?" => return state.last_exit_code.to_string(),
        "!" => return state.last_bg_pid.to_string(),
        "@" | "*" => return state.positional_args.join(" "),
        "#" => return state.positional_args.len().to_string(),
        "RANDOM" => return random_u15(state).to_string(),
        "SECONDS" => return "0".to_string(), // placeholder — no start_time yet
        "LINENO" => return "1".to_string(),  // minimum value for shell conformance
        _ => {}
    }

    // Positional parameters ($0–$9 and beyond)
    if let Ok(idx) = name.parse::<usize>() {
        if idx == 0 {
            return "yurt-shell".to_string();
        }
        return state
            .positional_args
            .get(idx - 1)
            .cloned()
            .unwrap_or_default();
    }

    // Array access with slicing: arr[@]:offset:length  (encoded by parser)
    if let Some(caps) = parse_array_slice_access(name) {
        let (arr_name, subscript, slice_spec) = caps;
        if subscript == "@" || subscript == "*" {
            if let Some(arr) = state.arrays.get(&arr_name) {
                return apply_array_slice(arr, &slice_spec);
            }
        }
        return String::new();
    }

    // Array access: arr[n], arr[@], arr[*]
    if let Some((arr_name, index)) = parse_array_access(name) {
        // BASH_REMATCH special array — check dedicated field first, then
        // fall back to state.arrays (manual assignment: BASH_REMATCH=(a b))
        if arr_name == "BASH_REMATCH" {
            let source = if !state.bash_rematch.is_empty() {
                &state.bash_rematch
            } else if let Some(arr) = state.arrays.get("BASH_REMATCH") {
                arr
            } else {
                return String::new();
            };
            if index == "@" || index == "*" {
                return source.join(" ");
            }
            if let Ok(idx) = index.parse::<usize>() {
                return source.get(idx).cloned().unwrap_or_default();
            }
            return String::new();
        }
        // Check associative arrays first
        if let Some(assoc) = state.assoc_arrays.get(&arr_name) {
            if index == "@" || index == "*" {
                return assoc.values().cloned().collect::<Vec<_>>().join(" ");
            }
            return assoc.get(&index).cloned().unwrap_or_default();
        }
        // Then indexed arrays
        if let Some(arr) = state.arrays.get(&arr_name) {
            if index == "@" || index == "*" {
                return arr.join(" ");
            }
            if let Ok(mut idx) = index.parse::<isize>() {
                if idx < 0 {
                    idx += arr.len() as isize;
                }
                if idx >= 0 && (idx as usize) < arr.len() {
                    return arr[idx as usize].clone();
                }
            }
            return String::new();
        }
        return String::new();
    }

    // Regular variable lookup
    if let Some(val) = state.env.get(name) {
        return val.clone();
    }

    // Nounset / set -u: error on unbound non-numeric variables
    if state.flags.contains(&ShellFlag::Nounset) {
        // Numeric names are positional params and shouldn't error here
        if name.parse::<usize>().is_err() {
            // In the TypeScript version this throws. We return empty for now
            // since we don't have an error return path in expand_word_part.
            // A future refactor could return Result<String, ShellError>.
            return String::new();
        }
    }

    String::new()
}

/// Generate a pseudo-random number in [0, 32768) using xorshift on state's seed.
fn random_u15(state: &mut ShellState) -> u32 {
    // xorshift64 — simple, fast, and produces different values each call.
    let mut s = state.rng_seed;
    s ^= s << 13;
    s ^= s >> 7;
    s ^= s << 17;
    state.rng_seed = s;
    (s % 32768) as u32
}

// ---------------------------------------------------------------------------
// Parameter expansion  ${var op default}
// ---------------------------------------------------------------------------

fn expand_param(state: &mut ShellState, var: &str, op: &str, operand: &str) -> String {
    let val = state.env.get(var).cloned();

    match op {
        ":-" => match &val {
            Some(v) if !v.is_empty() => v.clone(),
            _ => operand.to_string(),
        },

        ":=" => match &val {
            Some(v) if !v.is_empty() => v.clone(),
            _ => {
                state.env.insert(var.to_string(), operand.to_string());
                operand.to_string()
            }
        },

        ":+" => match &val {
            Some(v) if !v.is_empty() => operand.to_string(),
            _ => String::new(),
        },

        ":?" => {
            match &val {
                Some(v) if !v.is_empty() => v.clone(),
                _ => {
                    let msg = if operand.is_empty() {
                        "parameter null or not set"
                    } else {
                        operand
                    };
                    // Signal an error to the executor via state.param_error
                    state.param_error = Some(format!("{var}: {msg}"));
                    String::new()
                }
            }
        }

        "#" => {
            // ${#VAR} — string length
            // When var is empty and operand is set, it's ${#operand}
            if var.is_empty() && !operand.is_empty() {
                // Array length: ${#arr[@]} or element length: ${#arr[N]}
                if let Some((arr_name, sub)) = parse_array_access(operand) {
                    if sub == "@" || sub == "*" {
                        if let Some(assoc) = state.assoc_arrays.get(&arr_name) {
                            return assoc.len().to_string();
                        }
                        if let Some(arr) = state.arrays.get(&arr_name) {
                            return arr.len().to_string();
                        }
                        return "0".to_string();
                    }
                    // ${#arr[N]} — length of element N
                    if let Ok(idx) = sub.parse::<i64>() {
                        if let Some(arr) = state.arrays.get(&arr_name) {
                            let real_idx = if idx < 0 {
                                (arr.len() as i64 + idx) as usize
                            } else {
                                idx as usize
                            };
                            if let Some(val) = arr.get(real_idx) {
                                return val.chars().count().to_string();
                            }
                        }
                        return "0".to_string();
                    }
                    // ${#assoc[key]}
                    if let Some(assoc) = state.assoc_arrays.get(&arr_name) {
                        if let Some(val) = assoc.get(&sub) {
                            return val.chars().count().to_string();
                        }
                        return "0".to_string();
                    }
                }
                // String length of variable value: ${#VAR}
                let v = state.env.get(operand)
                    .or_else(|| state.env.get(operand))
                    .cloned()
                    .unwrap_or_default();
                return v.chars().count().to_string();
            }
            // ${VAR#pattern} — trim shortest prefix
            match &val {
                None => String::new(),
                Some(v) => trim_prefix(v, operand, false),
            }
        }

        "##" => match &val {
            None => String::new(),
            Some(v) => trim_prefix(v, operand, true),
        },

        "%" => match &val {
            None => String::new(),
            Some(v) => trim_suffix(v, operand, false),
        },

        "%%" => match &val {
            None => String::new(),
            Some(v) => trim_suffix(v, operand, true),
        },

        "/" => match &val {
            None => String::new(),
            Some(v) => replace_pattern(v, operand, false),
        },

        "//" => match &val {
            None => String::new(),
            Some(v) => replace_pattern(v, operand, true),
        },

        "/#" => match &val {
            None => String::new(),
            Some(v) => replace_pattern_anchored(v, operand, true),
        },

        "/%" => match &val {
            None => String::new(),
            Some(v) => replace_pattern_anchored(v, operand, false),
        },

        "^^" => val.unwrap_or_default().to_uppercase(),

        ",," => val.unwrap_or_default().to_lowercase(),

        "^" => {
            let s = val.unwrap_or_default();
            let mut chars = s.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => {
                    let upper: String = c.to_uppercase().collect();
                    format!("{upper}{}", chars.as_str())
                }
            }
        }

        "," => {
            let s = val.unwrap_or_default();
            let mut chars = s.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => {
                    let lower: String = c.to_lowercase().collect();
                    format!("{lower}{}", chars.as_str())
                }
            }
        }

        ":" => {
            // Substring / array slicing: ${var:offset} or ${var:offset:length}
            // First check if var is an array reference like arr[@]
            if let Some((arr_name, sub)) = parse_array_access(var) {
                if sub == "@" || sub == "*" {
                    if let Some(arr) = state.arrays.get(&arr_name) {
                        return apply_array_slice(arr, operand);
                    }
                    return String::new();
                }
            }
            let s = val.unwrap_or_default();
            apply_substring(&s, operand)
        }

        // Indirect expansion: ${!var} — the value of var names another variable
        // or ${!arr[@]} — array indices
        "!" => {
            // Check if operand is an array subscript like arr[@] or arr[*]
            if let Some((arr_name, sub)) = parse_array_access(operand) {
                if sub == "@" || sub == "*" {
                    if let Some(arr) = state.arrays.get(&arr_name) {
                        let indices: Vec<String> = (0..arr.len())
                            .filter(|i| !arr[*i].is_empty() || *i == 0)
                            .map(|i| i.to_string())
                            .collect();
                        return indices.join(" ");
                    }
                    if let Some(assoc) = state.assoc_arrays.get(&arr_name) {
                        let mut keys: Vec<&String> = assoc.keys().collect();
                        keys.sort();
                        return keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(" ");
                    }
                    return String::new();
                }
            }
            // Simple indirect: ${!var} — operand holds the variable name
            let indirect_name = if operand.is_empty() {
                val.unwrap_or_default()
            } else {
                // Look up operand as a variable to get the indirect name
                state.env.get(operand).cloned().unwrap_or_default()
            };
            if indirect_name.is_empty() {
                String::new()
            } else {
                state.env.get(&indirect_name).cloned().unwrap_or_default()
            }
        }

        // Unknown op — just return the value
        _ => val.unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Substring helper
// ---------------------------------------------------------------------------

/// Collect char boundary positions for safe slicing.
/// Expand `$(cmd)` command substitutions in a raw string (e.g. inside arithmetic).
fn expand_command_subs_in_string(
    state: &mut ShellState,
    s: &str,
    exec: Option<&dyn Fn(&mut ShellState, &str) -> String>,
) -> String {
    let exec_fn = match exec {
        Some(f) => f,
        None => return s.to_string(),
    };
    let bytes = s.as_bytes();
    let mut result = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
            // Check it's not $(( which is arithmetic
            if i + 2 < bytes.len() && bytes[i + 2] == b'(' {
                result.push(bytes[i] as char);
                i += 1;
                continue;
            }
            // Find matching closing paren
            i += 2; // skip $(
            let start = i;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'(' {
                    depth += 1;
                } else if bytes[i] == b')' {
                    depth -= 1;
                }
                if depth > 0 {
                    i += 1;
                }
            }
            let cmd = &s[start..i];
            if i < bytes.len() {
                i += 1; // skip )
            }
            if state.substitution_depth < crate::state::MAX_SUBSTITUTION_DEPTH {
                state.substitution_depth += 1;
                let output = exec_fn(state, cmd);
                state.substitution_depth -= 1;
                result.push_str(output.trim_end_matches('\n'));
            }
        } else {
            result.push(bytes[i] as char);
            i += 1;
        }
    }
    result
}

fn char_boundaries(s: &str) -> Vec<usize> {
    s.char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(s.len()))
        .collect()
}

fn apply_substring(s: &str, operand: &str) -> String {
    let parts: Vec<&str> = operand.splitn(2, ':').collect();
    let char_count = s.chars().count() as isize;
    let mut offset = parts[0].parse::<isize>().unwrap_or(0);

    if offset < 0 {
        offset = (char_count + offset).max(0);
    }
    let offset = offset as usize;

    let boundaries = char_boundaries(s);

    if parts.len() > 1 {
        let length = parts[1].trim().parse::<isize>().unwrap_or(0);
        if length < 0 {
            let end_char = (char_count + length).max(0) as usize;
            if offset < boundaries.len() && end_char < boundaries.len() && offset <= end_char {
                return s[boundaries[offset]..boundaries[end_char]].to_string();
            }
            return String::new();
        }
        let length = length as usize;
        let end_char = (offset + length).min(boundaries.len() - 1);
        if offset < boundaries.len() {
            return s[boundaries[offset]..boundaries[end_char]].to_string();
        }
        return String::new();
    }

    if offset < boundaries.len() {
        s[boundaries[offset]..].to_string()
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Array slice helper
// ---------------------------------------------------------------------------

fn apply_array_slice(arr: &[String], operand: &str) -> String {
    let parts: Vec<&str> = operand.splitn(2, ':').collect();
    let mut offset = parts[0].trim().parse::<isize>().unwrap_or(0);

    if offset < 0 {
        offset = (arr.len() as isize + offset).max(0);
    }
    let offset = offset as usize;

    if parts.len() > 1 {
        let length = parts[1].trim().parse::<isize>().unwrap_or(0);
        if length < 0 {
            // Negative length: count from end
            let end = (arr.len() as isize + length).max(0) as usize;
            if offset <= end && offset <= arr.len() {
                return arr[offset..end].join(" ");
            }
            return String::new();
        }
        let end = (offset + length as usize).min(arr.len());
        if offset <= arr.len() {
            return arr[offset..end].join(" ");
        }
        return String::new();
    }

    if offset <= arr.len() {
        arr[offset..].join(" ")
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Array access parsing helpers
// ---------------------------------------------------------------------------

/// Parse `name[subscript]` → Some((name, subscript))
fn parse_array_access(s: &str) -> Option<(String, String)> {
    let open = s.find('[')?;
    if !s.ends_with(']') {
        return None;
    }
    let name = &s[..open];
    let index = &s[open + 1..s.len() - 1];
    if name.is_empty() {
        return None;
    }
    // Verify name is a valid identifier (word chars)
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some((name.to_string(), index.to_string()))
}

/// Parse `name[subscript]:slice_spec` → Some((name, subscript, slice_spec))
fn parse_array_slice_access(s: &str) -> Option<(String, String, String)> {
    // Look for pattern: word[something]:rest
    let open = s.find('[')?;
    let close = s.find(']')?;
    if close <= open {
        return None;
    }
    // After ']' there must be ':'
    let after_close = &s[close + 1..];
    if !after_close.starts_with(':') {
        return None;
    }
    let name = &s[..open];
    let subscript = &s[open + 1..close];
    let slice_spec = &s[close + 2..]; // skip ']:'

    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }

    Some((
        name.to_string(),
        subscript.to_string(),
        slice_spec.to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Glob matching (simple shell glob → match)
// ---------------------------------------------------------------------------

/// Match a string against a shell glob pattern.
/// Supports `*` (match any sequence), `?` (match one char), and character
/// classes `[abc]`.
pub fn glob_matches(pattern: &str, text: &str) -> bool {
    glob_match_inner(pattern.as_bytes(), text.as_bytes())
}

fn glob_match_inner(pat: &[u8], txt: &[u8]) -> bool {
    let mut pi = 0;
    let mut ti = 0;
    let mut star_pi = usize::MAX; // pattern index after last '*'
    let mut star_ti = usize::MAX; // text index at last '*'

    while ti < txt.len() {
        if pi < pat.len() && pat[pi] == b'?' {
            // '?' matches any single character
            pi += 1;
            ti += 1;
        } else if pi < pat.len() && pat[pi] == b'*' {
            // '*' — record position and try matching zero chars
            star_pi = pi + 1;
            star_ti = ti;
            pi += 1;
        } else if pi < pat.len() && pat[pi] == b'[' {
            // Character class
            if let Some((matched, end)) = match_char_class(&pat[pi..], txt[ti]) {
                if matched {
                    pi += end;
                    ti += 1;
                } else if star_pi != usize::MAX {
                    star_ti += 1;
                    pi = star_pi;
                    ti = star_ti;
                } else {
                    return false;
                }
            } else {
                // Malformed class — treat '[' as literal
                if pat[pi] == txt[ti] {
                    pi += 1;
                    ti += 1;
                } else if star_pi != usize::MAX {
                    star_ti += 1;
                    pi = star_pi;
                    ti = star_ti;
                } else {
                    return false;
                }
            }
        } else if pi < pat.len() && pat[pi] == txt[ti] {
            pi += 1;
            ti += 1;
        } else if star_pi != usize::MAX {
            // Backtrack: consume one more char via the last '*'
            star_ti += 1;
            pi = star_pi;
            ti = star_ti;
        } else {
            return false;
        }
    }

    // Skip trailing '*' in pattern
    while pi < pat.len() && pat[pi] == b'*' {
        pi += 1;
    }

    pi == pat.len()
}

/// Try to match a character class at the start of `pat` against `ch`.
/// Returns Some((matched, bytes_consumed)) or None if the class is malformed.
fn match_char_class(pat: &[u8], ch: u8) -> Option<(bool, usize)> {
    if pat.is_empty() || pat[0] != b'[' {
        return None;
    }
    let mut i = 1;
    let mut matched = false;
    let negate = i < pat.len() && (pat[i] == b'!' || pat[i] == b'^');
    if negate {
        i += 1;
    }
    while i < pat.len() && pat[i] != b']' {
        if i + 2 < pat.len() && pat[i + 1] == b'-' && pat[i + 2] != b']' {
            // Range: a-z
            let lo = pat[i];
            let hi = pat[i + 2];
            if ch >= lo && ch <= hi {
                matched = true;
            }
            i += 3;
        } else {
            if pat[i] == ch {
                matched = true;
            }
            i += 1;
        }
    }
    if i >= pat.len() {
        return None; // No closing ']'
    }
    // i is now at ']'
    if negate {
        matched = !matched;
    }
    Some((matched, i + 1))
}

// ---------------------------------------------------------------------------
// Trim prefix / suffix / replace helpers
// ---------------------------------------------------------------------------

/// Remove shortest (greedy=false) or longest (greedy=true) prefix matching
/// the glob pattern. Uses char boundaries for UTF-8 safety.
fn trim_prefix(val: &str, pattern: &str, greedy: bool) -> String {
    let boundaries = char_boundaries(val);
    if greedy {
        // Try longest prefix first
        for &i in boundaries.iter().rev() {
            if glob_matches(pattern, &val[..i]) {
                return val[i..].to_string();
            }
        }
    } else {
        // Try shortest prefix first
        for &i in &boundaries {
            if glob_matches(pattern, &val[..i]) {
                return val[i..].to_string();
            }
        }
    }
    val.to_string()
}

/// Remove shortest (greedy=false) or longest (greedy=true) suffix matching
/// the glob pattern. Uses char boundaries for UTF-8 safety.
fn trim_suffix(val: &str, pattern: &str, greedy: bool) -> String {
    let boundaries = char_boundaries(val);
    if greedy {
        // Try longest suffix first (start from beginning)
        for &i in &boundaries {
            if glob_matches(pattern, &val[i..]) {
                return val[..i].to_string();
            }
        }
    } else {
        // Try shortest suffix first (start from end)
        for &i in boundaries.iter().rev() {
            if glob_matches(pattern, &val[i..]) {
                return val[..i].to_string();
            }
        }
    }
    val.to_string()
}

/// Replace the first (all=false) or all (all=true) occurrences of a glob
/// pattern in `val`. Uses char boundaries for UTF-8 safety.
fn replace_pattern(val: &str, operand: &str, all: bool) -> String {
    let slash_idx = operand.find('/');
    let pattern = match slash_idx {
        Some(idx) => &operand[..idx],
        None => operand,
    };
    let replacement = match slash_idx {
        Some(idx) => &operand[idx + 1..],
        None => "",
    };

    let boundaries = char_boundaries(val);

    if all {
        let mut result = String::new();
        let mut bi = 0; // index into boundaries
        while bi < boundaries.len() - 1 {
            let i = boundaries[bi];
            let mut matched = false;
            // Try longest match first
            for &j in boundaries[bi + 1..].iter().rev() {
                if glob_matches(pattern, &val[i..j]) {
                    result.push_str(replacement);
                    // Advance bi to the boundary at j
                    bi = boundaries.iter().position(|&b| b == j).unwrap();
                    matched = true;
                    break;
                }
            }
            if !matched {
                // Advance one character
                result.push_str(&val[boundaries[bi]..boundaries[bi + 1]]);
                bi += 1;
            }
        }
        result
    } else {
        // Replace first occurrence
        for (bi, &i) in boundaries.iter().enumerate() {
            if bi >= boundaries.len() - 1 {
                break;
            }
            for &j in boundaries[bi + 1..].iter().rev() {
                if glob_matches(pattern, &val[i..j]) {
                    return format!("{}{}{}", &val[..i], replacement, &val[j..]);
                }
            }
        }
        val.to_string()
    }
}

/// Anchored pattern replacement: `${var/#pat/rep}` (prefix) or `${var/%pat/rep}` (suffix).
fn replace_pattern_anchored(val: &str, operand: &str, prefix: bool) -> String {
    let slash_idx = operand.find('/');
    let pattern = match slash_idx {
        Some(idx) => &operand[..idx],
        None => operand,
    };
    let replacement = match slash_idx {
        Some(idx) => &operand[idx + 1..],
        None => "",
    };

    let boundaries = char_boundaries(val);

    if prefix {
        // Try longest prefix match first
        for &j in boundaries.iter().rev() {
            if glob_matches(pattern, &val[..j]) {
                return format!("{}{}", replacement, &val[j..]);
            }
        }
    } else {
        // Try longest suffix match first
        for &i in boundaries.iter() {
            if glob_matches(pattern, &val[i..]) {
                return format!("{}{}", &val[..i], replacement);
            }
        }
    }
    val.to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a state with some variables set for testing.
    fn test_state() -> ShellState {
        let mut state = ShellState::new_default();
        state.env.insert("FOO".into(), "hello".into());
        state.env.insert("BAR".into(), "world".into());
        state.env.insert("EMPTY".into(), String::new());
        state
            .env
            .insert("PATH_VAR".into(), "/usr/local/bin:/usr/bin:/bin".into());
        state.env.insert("GREETING".into(), "Hello, World!".into());
        state.env.insert("MIXED".into(), "hElLo WoRlD".into());
        state.positional_args = vec!["arg1".into(), "arg2".into(), "arg3".into()];
        state.last_exit_code = 42;
        state
    }

    // ---- Simple variable lookup ----

    #[test]
    fn simple_variable_lookup() {
        let mut state = test_state();
        let part = WordPart::Variable("FOO".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "hello");
    }

    #[test]
    fn variable_lookup_missing() {
        let mut state = test_state();
        let part = WordPart::Variable("NONEXISTENT".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    #[test]
    fn variable_lookup_empty() {
        let mut state = test_state();
        let part = WordPart::Variable("EMPTY".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    // ---- Special variables ----

    #[test]
    fn special_var_exit_code() {
        let mut state = test_state();
        let part = WordPart::Variable("?".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "42");
    }

    #[test]
    fn special_var_arg_count() {
        let mut state = test_state();
        let part = WordPart::Variable("#".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "3");
    }

    #[test]
    fn special_var_all_args_at() {
        let mut state = test_state();
        let part = WordPart::Variable("@".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "arg1 arg2 arg3");
    }

    #[test]
    fn special_var_all_args_star() {
        let mut state = test_state();
        let part = WordPart::Variable("*".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "arg1 arg2 arg3");
    }

    #[test]
    fn special_var_random() {
        let mut state = test_state();
        let part = WordPart::Variable("RANDOM".into());
        let val: u32 = expand_word_part(&mut state, &part, None).parse().unwrap();
        assert!(val < 32768);
    }

    #[test]
    fn positional_param_1() {
        let mut state = test_state();
        let part = WordPart::Variable("1".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "arg1");
    }

    #[test]
    fn positional_param_3() {
        let mut state = test_state();
        let part = WordPart::Variable("3".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "arg3");
    }

    #[test]
    fn positional_param_out_of_range() {
        let mut state = test_state();
        let part = WordPart::Variable("9".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    #[test]
    fn positional_param_zero() {
        let mut state = test_state();
        let part = WordPart::Variable("0".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "yurt-shell");
    }

    // ---- Parameter expansion: default value (:-, :=, :+, :?) ----

    #[test]
    fn param_default_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":-".into(),
            default: "fallback".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "hello");
    }

    #[test]
    fn param_default_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: ":-".into(),
            default: "fallback".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "fallback");
    }

    #[test]
    fn param_default_when_empty() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "EMPTY".into(),
            op: ":-".into(),
            default: "fallback".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "fallback");
    }

    #[test]
    fn param_assign_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NEWVAR".into(),
            op: ":=".into(),
            default: "assigned".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "assigned");
        // Verify the variable was actually set
        assert_eq!(state.env.get("NEWVAR").unwrap(), "assigned");
    }

    #[test]
    fn param_assign_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":=".into(),
            default: "other".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "hello");
        // Original value preserved
        assert_eq!(state.env.get("FOO").unwrap(), "hello");
    }

    #[test]
    fn param_alternate_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":+".into(),
            default: "alternate".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "alternate");
    }

    #[test]
    fn param_alternate_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: ":+".into(),
            default: "alternate".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    #[test]
    fn param_error_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":?".into(),
            default: "errmsg".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "hello");
    }

    #[test]
    fn param_error_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: ":?".into(),
            default: "custom error".into(),
        };
        let result = expand_word_part(&mut state, &part, None);
        assert_eq!(result, "");
        // Error message should be stored in state.param_error
        let err = state
            .param_error
            .as_ref()
            .expect("param_error should be set");
        assert!(err.contains("NOVAR"));
        assert!(err.contains("custom error"));
    }

    // ---- String length (#) ----

    #[test]
    fn string_length() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "FOO".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "5"); // "hello".len()
    }

    #[test]
    fn string_length_missing() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "NOVAR".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "0");
    }

    // ---- Prefix removal (#, ##) ----

    #[test]
    fn trim_shortest_prefix() {
        let mut state = test_state();
        // ${PATH_VAR#/*/} — remove shortest prefix matching /*/
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "#".into(),
            default: "/*/".into(),
        };
        let result = expand_word_part(&mut state, &part, None);
        // /usr/local/bin:/usr/bin:/bin with shortest prefix /*/  → match /usr/
        assert_eq!(result, "local/bin:/usr/bin:/bin");
    }

    #[test]
    fn trim_longest_prefix() {
        let mut state = test_state();
        // ${PATH_VAR##/*/} — remove longest prefix matching /*/
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "##".into(),
            default: "/*/".into(),
        };
        let result = expand_word_part(&mut state, &part, None);
        // Longest prefix matching /*/ from /usr/local/bin:/usr/bin:/bin
        // is /usr/local/bin:/usr/bin:/
        assert_eq!(result, "bin");
    }

    // ---- Suffix removal (%, %%) ----

    #[test]
    fn trim_shortest_suffix() {
        let mut state = test_state();
        // ${PATH_VAR%:*} — remove shortest suffix matching :*
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "%".into(),
            default: ":*".into(),
        };
        let result = expand_word_part(&mut state, &part, None);
        assert_eq!(result, "/usr/local/bin:/usr/bin");
    }

    #[test]
    fn trim_longest_suffix() {
        let mut state = test_state();
        // ${PATH_VAR%%:*} — remove longest suffix matching :*
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "%%".into(),
            default: ":*".into(),
        };
        let result = expand_word_part(&mut state, &part, None);
        assert_eq!(result, "/usr/local/bin");
    }

    // ---- Pattern replacement (/, //) ----

    #[test]
    fn replace_first() {
        let mut state = test_state();
        // ${FOO/l/L} — replace first 'l' with 'L'
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "/".into(),
            default: "l/L".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "heLlo");
    }

    #[test]
    fn replace_all() {
        let mut state = test_state();
        // ${FOO//l/L} — replace all 'l' with 'L'
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "//".into(),
            default: "l/L".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "heLLo");
    }

    #[test]
    fn replace_with_empty() {
        let mut state = test_state();
        // ${FOO//l/} — delete all 'l'
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "//".into(),
            default: "l/".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "heo");
    }

    // ---- Case conversion (^^, ,,, ^, ,) ----

    #[test]
    fn case_all_upper() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "^^".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "HELLO");
    }

    #[test]
    fn case_all_lower() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "MIXED".into(),
            op: ",,".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "hello world");
    }

    #[test]
    fn case_first_upper() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "^".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "Hello");
    }

    #[test]
    fn case_first_lower() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "GREETING".into(),
            op: ",".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "hello, World!");
    }

    // ---- Substring (:offset:length) ----

    #[test]
    fn substring_offset() {
        let mut state = test_state();
        // ${FOO:2} → "llo"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "2".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "llo");
    }

    #[test]
    fn substring_offset_length() {
        let mut state = test_state();
        // ${FOO:1:3} → "ell"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "1:3".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "ell");
    }

    #[test]
    fn substring_negative_offset() {
        let mut state = test_state();
        // ${FOO:-2} would conflict with :- default, but ${FOO: -2} parses as
        // offset=-2 (last 2 chars).
        // In our AST this arrives as op=":" operand="-2"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "-2".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "lo");
    }

    #[test]
    fn substring_negative_length() {
        let mut state = test_state();
        // ${FOO:1:-1} → "ell" (offset=1, end=len-1=4, so "ello"[..4-1]? no)
        // Actually: offset=1, length=-1 means end=5+(-1)=4, so s[1..4]="ell"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "1:-1".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "ell");
    }

    // ---- Array access ----

    #[test]
    fn array_element_access() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::Variable("arr[1]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "b");
    }

    #[test]
    fn array_all_elements() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::Variable("arr[@]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "a b c");
    }

    #[test]
    fn array_star_elements() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["x".into(), "y".into()]);
        let part = WordPart::Variable("arr[*]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "x y");
    }

    #[test]
    fn array_negative_index() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::Variable("arr[-1]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "c");
    }

    #[test]
    fn array_length() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "arr[@]".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "3");
    }

    #[test]
    fn array_slice() {
        let mut state = test_state();
        state.arrays.insert(
            "arr".into(),
            vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
        );
        // ${arr[@]:1:3} → "b c d"
        let part = WordPart::ParamExpansion {
            var: "arr[@]".into(),
            op: ":".into(),
            default: "1:3".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "b c d");
    }

    #[test]
    fn array_slice_via_variable_syntax() {
        let mut state = test_state();
        state.arrays.insert(
            "arr".into(),
            vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
        );
        // arr[@]:2:2 encoded in Variable name (parser format for $arr[@]:offset:length)
        let part = WordPart::Variable("arr[@]:2:2".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "c d");
    }

    #[test]
    fn assoc_array_access() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("key1".into(), "val1".into());
        assoc.insert("key2".into(), "val2".into());
        state.assoc_arrays.insert("map".into(), assoc);

        let part = WordPart::Variable("map[key1]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "val1");
    }

    #[test]
    fn assoc_array_missing_key() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("key1".into(), "val1".into());
        state.assoc_arrays.insert("map".into(), assoc);

        let part = WordPart::Variable("map[missing]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    // ---- Tilde expansion ----

    #[test]
    fn tilde_alone() {
        let mut state = test_state();
        let part = WordPart::Literal("~".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "/home/user");
    }

    #[test]
    fn tilde_slash() {
        let mut state = test_state();
        let part = WordPart::Literal("~/documents".into());
        assert_eq!(
            expand_word_part(&mut state, &part, None),
            "/home/user/documents"
        );
    }

    #[test]
    fn tilde_custom_home() {
        let mut state = test_state();
        state.env.insert("HOME".into(), "/custom/home".into());
        let part = WordPart::Literal("~/bin".into());
        assert_eq!(
            expand_word_part(&mut state, &part, None),
            "/custom/home/bin"
        );
    }

    #[test]
    fn no_tilde_in_middle() {
        let mut state = test_state();
        let part = WordPart::Literal("foo~bar".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "foo~bar");
    }

    // ---- Word splitting ----

    #[test]
    fn word_splitting_on_variable() {
        let mut state = test_state();
        state.env.insert("WORDS".into(), "one  two   three".into());
        let words = vec![Word {
            parts: vec![WordPart::Variable("WORDS".into())],
        }];
        let result = expand_words_with_splitting(&mut state, &words, None);
        assert_eq!(result, vec!["one", "two", "three"]);
    }

    #[test]
    fn no_splitting_on_quoted() {
        let mut state = test_state();
        state.env.insert("WORDS".into(), "one  two   three".into());
        // A word with both Variable and QuotedLiteral should not split
        let words = vec![Word {
            parts: vec![
                WordPart::QuotedLiteral(String::new()),
                WordPart::Variable("WORDS".into()),
            ],
        }];
        let result = expand_words_with_splitting(&mut state, &words, None);
        assert_eq!(result, vec!["one  two   three"]);
    }

    #[test]
    fn splitting_preserves_literal_words() {
        let mut state = test_state();
        let words = vec![
            Word {
                parts: vec![WordPart::Literal("hello".into())],
            },
            Word {
                parts: vec![WordPart::Literal("world".into())],
            },
        ];
        let result = expand_words_with_splitting(&mut state, &words, None);
        assert_eq!(result, vec!["hello", "world"]);
    }

    // ---- Word expansion ----

    #[test]
    fn expand_word_concatenates_parts() {
        let mut state = test_state();
        let word = Word {
            parts: vec![
                WordPart::Literal("prefix_".into()),
                WordPart::Variable("FOO".into()),
                WordPart::Literal("_suffix".into()),
            ],
        };
        assert_eq!(expand_word(&mut state, &word, None), "prefix_hello_suffix");
    }

    // ---- Nounset (set -u) ----

    #[test]
    fn nounset_unbound_returns_empty() {
        let mut state = test_state();
        state.flags.insert(ShellFlag::Nounset);
        let part = WordPart::Variable("UNBOUND".into());
        // Currently returns empty; future: should propagate error
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    #[test]
    fn nounset_bound_returns_value() {
        let mut state = test_state();
        state.flags.insert(ShellFlag::Nounset);
        let part = WordPart::Variable("FOO".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "hello");
    }

    // ---- Quoted literal brace protection ----

    #[test]
    fn quoted_literal_brace_protection() {
        let mut state = test_state();
        let part = WordPart::QuotedLiteral("a{b}c".into());
        assert_eq!(
            expand_word_part(&mut state, &part, None),
            "a\u{E000}b\u{E001}c"
        );
    }

    // ---- CommandSub / ArithmeticExpansion / ProcessSub ----

    #[test]
    fn command_sub_without_exec_returns_empty() {
        let mut state = test_state();
        let part = WordPart::CommandSub("echo hi".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    #[test]
    fn arithmetic_expansion_evaluates() {
        let mut state = test_state();
        let part = WordPart::ArithmeticExpansion("1+1".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "2");
    }

    #[test]
    fn process_sub_returns_empty() {
        let mut state = test_state();
        let part = WordPart::ProcessSub("echo hi".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    // ---- Glob matching (internal) ----

    #[test]
    fn glob_star() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*", ""));
        assert!(glob_matches("he*lo", "hello"));
        assert!(glob_matches("he*lo", "helo"));
        assert!(glob_matches("he*lo", "heXXXlo"));
        assert!(!glob_matches("he*lo", "hexyz"));
    }

    #[test]
    fn glob_question() {
        assert!(glob_matches("h?llo", "hello"));
        assert!(!glob_matches("h?llo", "hllo"));
        assert!(!glob_matches("h?llo", "heello"));
    }

    #[test]
    fn glob_char_class() {
        assert!(glob_matches("[abc]", "a"));
        assert!(glob_matches("[abc]", "b"));
        assert!(!glob_matches("[abc]", "d"));
        assert!(glob_matches("[a-z]", "m"));
        assert!(!glob_matches("[a-z]", "M"));
    }

    #[test]
    fn glob_negated_class() {
        assert!(!glob_matches("[!abc]", "a"));
        assert!(glob_matches("[!abc]", "d"));
    }

    // ---- Param expansion on unset var ----

    #[test]
    fn param_prefix_on_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: "#".into(),
            default: "*".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    #[test]
    fn param_suffix_on_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: "%".into(),
            default: "*".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "");
    }

    // ---- Replace with glob pattern ----

    #[test]
    fn replace_with_glob_pattern() {
        let mut state = test_state();
        state.env.insert("FILE".into(), "photo.jpg".into());
        // ${FILE/*.jpg/.png} — replace .jpg extension
        let part = WordPart::ParamExpansion {
            var: "FILE".into(),
            op: "/".into(),
            default: "*.jpg/.png".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), ".png");
    }

    // ---- Assoc array all values ----

    #[test]
    fn assoc_array_all_values() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("a".into(), "1".into());
        state.assoc_arrays.insert("m".into(), assoc);

        let part = WordPart::Variable("m[@]".into());
        assert_eq!(expand_word_part(&mut state, &part, None), "1");
    }

    // ---- Assoc array length ----

    #[test]
    fn assoc_array_length() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("x".into(), "1".into());
        assoc.insert("y".into(), "2".into());
        state.assoc_arrays.insert("m".into(), assoc);

        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "m[@]".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part, None), "2");
    }

    // ---- word_needs_splitting logic ----

    #[test]
    fn word_needs_splitting_with_variable() {
        let word = Word {
            parts: vec![WordPart::Variable("X".into())],
        };
        assert!(word_needs_splitting(&word));
    }

    #[test]
    fn word_needs_splitting_literal_only() {
        let word = Word {
            parts: vec![WordPart::Literal("hello world".into())],
        };
        assert!(!word_needs_splitting(&word));
    }

    #[test]
    fn word_needs_splitting_quoted_variable() {
        let word = Word {
            parts: vec![
                WordPart::QuotedLiteral(String::new()),
                WordPart::Variable("X".into()),
            ],
        };
        assert!(!word_needs_splitting(&word));
    }

    // ---- Brace expansion: comma lists ----

    #[test]
    fn brace_comma_simple() {
        let input = vec!["{a,b,c}".to_string()];
        assert_eq!(expand_braces(&input), vec!["a", "b", "c"]);
    }

    #[test]
    fn brace_comma_with_prefix_suffix() {
        let input = vec!["pre{a,b}suf".to_string()];
        assert_eq!(expand_braces(&input), vec!["preasuf", "prebsuf"]);
    }

    #[test]
    fn brace_comma_nested() {
        let input = vec!["{a,{b,c}}".to_string()];
        assert_eq!(expand_braces(&input), vec!["a", "b", "c"]);
    }

    #[test]
    fn brace_comma_nested_complex() {
        let input = vec!["x{a,b{c,d}}y".to_string()];
        assert_eq!(expand_braces(&input), vec!["xay", "xbcy", "xbdy"]);
    }

    #[test]
    fn brace_single_item_no_expansion() {
        // {foo} with no comma and no range should not expand
        let input = vec!["{foo}".to_string()];
        assert_eq!(expand_braces(&input), vec!["{foo}"]);
    }

    // ---- Brace expansion: numeric ranges ----

    #[test]
    fn brace_range_numeric_ascending() {
        let input = vec!["{1..5}".to_string()];
        assert_eq!(expand_braces(&input), vec!["1", "2", "3", "4", "5"]);
    }

    #[test]
    fn brace_range_numeric_descending() {
        let input = vec!["{5..1}".to_string()];
        assert_eq!(expand_braces(&input), vec!["5", "4", "3", "2", "1"]);
    }

    #[test]
    fn brace_range_numeric_negative() {
        let input = vec!["{-2..3}".to_string()];
        assert_eq!(expand_braces(&input), vec!["-2", "-1", "0", "1", "2", "3"]);
    }

    // ---- Brace expansion: alpha ranges ----

    #[test]
    fn brace_range_alpha_ascending() {
        let input = vec!["{a..e}".to_string()];
        assert_eq!(expand_braces(&input), vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn brace_range_alpha_descending() {
        let input = vec!["{e..a}".to_string()];
        assert_eq!(expand_braces(&input), vec!["e", "d", "c", "b", "a"]);
    }

    // ---- Brace expansion: range with prefix/suffix ----

    #[test]
    fn brace_range_with_prefix_suffix() {
        let input = vec!["file{1..3}.txt".to_string()];
        assert_eq!(
            expand_braces(&input),
            vec!["file1.txt", "file2.txt", "file3.txt"]
        );
    }

    // ---- Brace expansion: multiple words ----

    #[test]
    fn brace_expansion_multiple_words() {
        let input = vec!["hello".to_string(), "{a,b}".to_string()];
        assert_eq!(expand_braces(&input), vec!["hello", "a", "b"]);
    }

    // ---- Sentinel restoration ----

    #[test]
    fn sentinel_restoration_replaces_pua_chars() {
        let input = vec!["a\u{E000}b\u{E001}c".to_string(), "normal".to_string()];
        assert_eq!(restore_brace_sentinels(&input), vec!["a{b}c", "normal"]);
    }

    #[test]
    fn sentinel_preservation_quoted_braces_not_expanded() {
        // Simulate: echo "{a,b}" where braces are quoted
        // After word expansion, QuotedLiteral produces sentinels
        let mut state = test_state();
        let word = Word {
            parts: vec![WordPart::QuotedLiteral("{a,b}".into())],
        };
        let expanded = expand_word(&mut state, &word, None);
        // Should contain sentinel chars, not literal braces
        assert_eq!(expanded, "\u{E000}a,b\u{E001}");

        // Brace expansion should NOT expand sentinel-protected braces
        let braced = expand_braces(&[expanded]);
        assert_eq!(braced, vec!["\u{E000}a,b\u{E001}"]);

        // After sentinel restoration, original braces return
        let restored = restore_brace_sentinels(&braced);
        assert_eq!(restored, vec!["{a,b}"]);
    }

    // ---- Glob expansion ----

    #[test]
    fn glob_expansion_with_matches() {
        use crate::test_support::mock::MockHost;

        // expand_globs resolves relative patterns against cwd, so register the absolute pattern.
        let host = MockHost::new().with_glob_result(
            "/home/user/*.txt",
            vec![
                "/home/user/b.txt".to_string(),
                "/home/user/a.txt".to_string(),
            ],
        );
        let input = vec!["*.txt".to_string()];
        let result = expand_globs(&host, &input, "/home/user");
        // Should be sorted and stripped back to relative paths
        assert_eq!(result, vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn glob_expansion_no_matches_keeps_literal() {
        use crate::test_support::mock::MockHost;

        let host = MockHost::new();
        let input = vec!["*.xyz".to_string()];
        let result = expand_globs(&host, &input, "/home/user");
        assert_eq!(result, vec!["*.xyz"]);
    }

    #[test]
    fn glob_expansion_question_mark() {
        use crate::test_support::mock::MockHost;

        let host = MockHost::new().with_glob_result(
            "/home/user/file?.txt",
            vec![
                "/home/user/file1.txt".to_string(),
                "/home/user/file2.txt".to_string(),
            ],
        );
        let input = vec!["file?.txt".to_string()];
        let result = expand_globs(&host, &input, "/home/user");
        assert_eq!(result, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn glob_expansion_no_glob_chars_passthrough() {
        use crate::test_support::mock::MockHost;

        let host = MockHost::new();
        let input = vec!["plain.txt".to_string()];
        let result = expand_globs(&host, &input, "/home/user");
        assert_eq!(result, vec!["plain.txt"]);
    }

    #[test]
    fn glob_expansion_mixed_words() {
        use crate::test_support::mock::MockHost;

        let host = MockHost::new().with_glob_result(
            "/home/user/*.rs",
            vec![
                "/home/user/main.rs".to_string(),
                "/home/user/lib.rs".to_string(),
            ],
        );
        let input = vec!["echo".to_string(), "*.rs".to_string(), "done".to_string()];
        let result = expand_globs(&host, &input, "/home/user");
        assert_eq!(result, vec!["echo", "lib.rs", "main.rs", "done"]);
    }
}
