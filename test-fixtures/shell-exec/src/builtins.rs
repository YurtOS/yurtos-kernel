//! Shell builtin commands.
//!
//! Each builtin is checked *before* `host.spawn()` so that commands like
//! `echo`, `cd`, `export`, etc. are handled in-process without a round-trip
//! to the host.

use std::collections::HashMap;

use crate::arithmetic::eval_arithmetic;
use crate::control::RunResult;
use crate::host::HostInterface;
use crate::state::{ShellFlag, ShellState};
use crate::{shell_eprint, shell_eprintln, shell_print, shell_println};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Result of a builtin execution.
pub enum BuiltinResult {
    /// Normal command result — just the exit code. Output flows through fds.
    Result(i32),
    /// The `exit` builtin was invoked with the given code.
    Exit(i32),
    /// The `return` builtin was invoked with the given code.
    Return(i32),
}

/// Callback that parses + executes a shell command string, returning a
/// `RunResult`.  Used by `eval` and `source` builtins.
pub type RunFn<'a> = &'a dyn Fn(&mut ShellState, &str) -> RunResult;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Try to handle `cmd_name` as a shell builtin.
///
/// Returns `Some(BuiltinResult)` if it is a builtin, `None` if the executor
/// should fall through to function lookup / `host.spawn()`.
pub fn try_builtin(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd_name: &str,
    args: &[String],
    stdin_data: &str,
    run: Option<RunFn>,
) -> Option<BuiltinResult> {
    // POSIX-style fd mapping: dup2(stdout_fd, 1) so that builtins'
    // shell_print!() writes to the correct target (pipe or terminal).
    //
    // When stdout_fd != 1 (pipeline, redirect, or command substitution pipe),
    // save fd 1, dup2(stdout_fd, 1), run builtin, then restore.
    let do_dup2 = state.stdout_fd != 1;
    let saved_fd1 = if do_dup2 { host.dup(1).ok() } else { None };
    if do_dup2 {
        let _ = host.dup2(state.stdout_fd, 1);
    }

    let result = match cmd_name {
        "echo" => Some(builtin_echo(state, args)),
        "printf" => builtin_printf(state, args),
        "true" | ":" => Some(BuiltinResult::Result(0)),
        "false" => Some(BuiltinResult::Result(1)),
        "pwd" => Some(builtin_pwd(state)),
        "cd" => Some(builtin_cd(state, host, args)),
        "exit" => Some(builtin_exit(state, args)),
        "export" => Some(builtin_export(state, args)),
        "unset" => Some(builtin_unset(state, args)),
        "set" => Some(builtin_set(state, args)),
        "local" => Some(builtin_local(state, args)),
        "declare" | "typeset" => Some(builtin_declare(state, args)),
        "test" => Some(builtin_test(state, host, args)),
        "[" => Some(builtin_bracket_test(state, host, args)),
        "read" => Some(builtin_read(state, host, args)),
        "shift" => Some(builtin_shift(state, args)),
        "type" => Some(builtin_type(state, host, args)),
        "command" => builtin_command(host, args),
        "let" => Some(builtin_let(state, args)),
        "which" => Some(builtin_which(host, args)),
        "source" | "." => Some(builtin_source(state, host, args, run)),
        "eval" => Some(builtin_eval(state, args, run)),
        "return" => Some(builtin_return(state, args)),
        "history" => Some(builtin_history(state, args)),
        "trap" => Some(builtin_trap(state, args)),
        "getopts" => Some(builtin_getopts(state, args)),
        "mapfile" | "readarray" => Some(builtin_mapfile(state, host, args)),
        "chmod" => Some(builtin_chmod(state, host, args)),
        "date" => Some(builtin_date(host, args)),
        "exec" => Some(builtin_exec_cmd(state, host, args, stdin_data, run)),
        "readonly" => Some(builtin_readonly(state, args)),
        "pushd" => Some(builtin_pushd(state, host, args)),
        "popd" => Some(builtin_popd(state)),
        "dirs" => Some(builtin_dirs(state)),
        "sleep" => Some(builtin_sleep(host, args)),
        "wait" => Some(builtin_wait(state, host, args)),
        "jobs" => Some(builtin_jobs(state, host)),
        "ps" => Some(builtin_ps(host)),
        "kill" => Some(builtin_kill(state, host, args)),
        "alias" => Some(builtin_alias(state, args)),
        "unalias" => Some(builtin_unalias(state, args)),
        "nice" => Some(builtin_nice(state, host, args)),
        _ => None,
    };

    // Restore fd 1
    if let Some(sfd) = saved_fd1 {
        let _ = host.dup2(sfd, 1);
        let _ = host.close_fd(sfd);
    }

    result
}

/// Returns true if `cmd_name` is the name of a builtin command.
pub fn is_builtin(cmd_name: &str) -> bool {
    matches!(
        cmd_name,
        "echo"
            | "true"
            | ":"
            | "false"
            | "pwd"
            | "cd"
            | "exit"
            | "export"
            | "unset"
            | "set"
            | "local"
            | "declare"
            | "typeset"
            | "test"
            | "["
            | "read"
            | "shift"
            | "type"
            | "command"
            | "let"
            | "which"
            | "source"
            | "."
            | "eval"
            | "return"
            | "history"
            | "trap"
            | "getopts"
            | "mapfile"
            | "readarray"
            | "chmod"
            | "date"
            | "exec"
            | "readonly"
            | "pushd"
            | "popd"
            | "dirs"
            | "sleep"
            | "wait"
            | "jobs"
            | "ps"
            | "kill"
            | "alias"
            | "unalias"
            | "nice"
    )
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/// Normalize a path by resolving `.` and `..` segments.
pub fn normalize_path(path: &str) -> String {
    let is_absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();

    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if !parts.is_empty() {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }

    if is_absolute {
        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

// ---------------------------------------------------------------------------
// Individual builtins
// ---------------------------------------------------------------------------

// -- echo -----------------------------------------------------------------

fn builtin_echo(_state: &ShellState, args: &[String]) -> BuiltinResult {
    let mut newline = true;
    let mut interpret_escapes = false;
    let mut arg_start = 0;

    // Parse flags: only consecutive leading args matching /^-[neE]+$/
    for (i, arg) in args.iter().enumerate() {
        if arg.starts_with('-') && arg.len() > 1 && arg[1..].chars().all(|c| "neE".contains(c)) {
            for ch in arg[1..].chars() {
                match ch {
                    'n' => newline = false,
                    'e' => interpret_escapes = true,
                    'E' => interpret_escapes = false,
                    _ => {}
                }
            }
            arg_start = i + 1;
        } else {
            break;
        }
    }

    let body = args[arg_start..].join(" ");
    let output = if interpret_escapes {
        interpret_echo_escapes(&body)
    } else {
        (body, false)
    };

    let mut text = output.0;
    // \c in -e mode suppresses trailing newline and stops output
    if !output.1 && newline {
        text.push('\n');
    }

    shell_print!("{}", text);
    BuiltinResult::Result(0)
}

/// Interpret echo escape sequences. Returns (output, stop) where stop=true
/// means `\c` was encountered.
fn interpret_echo_escapes(s: &str) -> (String, bool) {
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                '\\' => out.push('\\'),
                'a' => out.push('\x07'),
                'b' => out.push('\x08'),
                'f' => out.push('\x0C'),
                'v' => out.push('\x0B'),
                'c' => return (out, true),
                '0' => {
                    // Octal: \0NNN (up to 3 octal digits)
                    let mut val = 0u32;
                    let mut count = 0;
                    while count < 3
                        && i + 1 < chars.len()
                        && chars[i + 1] >= '0'
                        && chars[i + 1] <= '7'
                    {
                        i += 1;
                        val = val * 8 + (chars[i] as u32 - '0' as u32);
                        count += 1;
                    }
                    if let Some(c) = char::from_u32(val) {
                        out.push(c);
                    }
                }
                'x' => {
                    // Hex: \xHH (up to 2 hex digits)
                    let mut val = 0u32;
                    let mut count = 0;
                    while count < 2 && i + 1 < chars.len() && chars[i + 1].is_ascii_hexdigit() {
                        i += 1;
                        val = val * 16 + chars[i].to_digit(16).unwrap();
                        count += 1;
                    }
                    if count > 0 {
                        if let Some(c) = char::from_u32(val) {
                            out.push(c);
                        }
                    } else {
                        out.push('\\');
                        out.push('x');
                    }
                }
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
        } else {
            out.push(chars[i]);
        }
        i += 1;
    }
    (out, false)
}

// -- printf ---------------------------------------------------------------

fn builtin_printf(state: &mut ShellState, args: &[String]) -> Option<BuiltinResult> {
    if args.is_empty() {
        shell_eprint!("{}", "printf: usage: printf [-v var] format [arguments]\n");
        return Some(BuiltinResult::Result(1));
    }

    let mut arg_idx = 0;
    let mut var_name: Option<String> = None;

    // Check for -v VAR
    if args.len() >= 2 && args[0] == "-v" {
        var_name = Some(args[1].clone());
        arg_idx = 2;
    }

    if arg_idx >= args.len() {
        if var_name.is_some() {
            shell_eprint!("{}", "printf: usage: printf [-v var] format [arguments]\n");
            return Some(BuiltinResult::Result(1));
        }
        // No -v and no format: fall through to spawn (shouldn't normally happen)
        return None;
    }

    let format = &args[arg_idx];
    arg_idx += 1;
    let fmt_args = &args[arg_idx..];

    let output = format_printf(format, fmt_args);

    if let Some(name) = var_name {
        // -v mode: store into variable, no stdout output
        state.env.insert(name, output);
        Some(BuiltinResult::Result(0))
    } else {
        // Normal mode: write to stdout fd
        shell_print!("{}", output);
        Some(BuiltinResult::Result(0))
    }
}

fn format_printf(format: &str, args: &[String]) -> String {
    let mut out = String::new();
    let chars: Vec<char> = format.chars().collect();
    let mut i = 0;
    let mut arg_idx = 0;

    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                'r' => out.push('\r'),
                '0' => {
                    // Octal escape: \0, \0N, \0NN, \0NNN
                    let mut octal = String::new();
                    while i + 1 < chars.len() && octal.len() < 3 && chars[i + 1].is_digit(8) {
                        i += 1;
                        octal.push(chars[i]);
                    }
                    let val = if octal.is_empty() {
                        0u32
                    } else {
                        u32::from_str_radix(&octal, 8).unwrap_or(0)
                    };
                    if let Some(ch) = char::from_u32(val) {
                        out.push(ch);
                    }
                }
                _ => {
                    out.push('\\');
                    out.push(chars[i]);
                }
            }
        } else if chars[i] == '%' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                '%' => out.push('%'),
                's' => {
                    if arg_idx < args.len() {
                        out.push_str(&args[arg_idx]);
                        arg_idx += 1;
                    }
                }
                'd' => {
                    let val = if arg_idx < args.len() {
                        let s = &args[arg_idx];
                        arg_idx += 1;
                        s.parse::<i64>().unwrap_or(0)
                    } else {
                        0
                    };
                    out.push_str(&val.to_string());
                }
                'f' => {
                    let val = if arg_idx < args.len() {
                        let s = &args[arg_idx];
                        arg_idx += 1;
                        s.parse::<f64>().unwrap_or(0.0)
                    } else {
                        0.0
                    };
                    out.push_str(&format!("{:.6}", val));
                }
                'x' => {
                    let val = if arg_idx < args.len() {
                        let s = &args[arg_idx];
                        arg_idx += 1;
                        s.parse::<i64>().unwrap_or(0)
                    } else {
                        0
                    };
                    out.push_str(&format!("{:x}", val));
                }
                'o' => {
                    let val = if arg_idx < args.len() {
                        let s = &args[arg_idx];
                        arg_idx += 1;
                        s.parse::<i64>().unwrap_or(0)
                    } else {
                        0
                    };
                    out.push_str(&format!("{:o}", val));
                }
                'c' => {
                    if arg_idx < args.len() {
                        let s = &args[arg_idx];
                        arg_idx += 1;
                        if let Some(c) = s.chars().next() {
                            out.push(c);
                        }
                    }
                }
                other => {
                    out.push('%');
                    out.push(other);
                }
            }
        } else {
            out.push(chars[i]);
        }
        i += 1;
    }
    out
}

// -- pwd ------------------------------------------------------------------

fn builtin_pwd(state: &ShellState) -> BuiltinResult {
    let cwd = state
        .env
        .get("PWD")
        .map(|s| s.as_str())
        .unwrap_or(&state.cwd);
    shell_println!("{}", cwd);
    BuiltinResult::Result(0)
}

// -- cd -------------------------------------------------------------------

fn builtin_cd(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    let target = if args.is_empty() {
        state
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/home/user".to_string())
    } else if args[0] == "-" {
        match state.env.get("OLDPWD").cloned() {
            Some(old) => old,
            None => {
                shell_eprint!("{}", "cd: OLDPWD not set\n");
                return BuiltinResult::Result(1);
            }
        }
    } else {
        args[0].clone()
    };

    // Resolve relative path
    let resolved = if target.starts_with('/') {
        target.clone()
    } else {
        format!("{}/{}", state.cwd, target)
    };
    let normalized = normalize_path(&resolved);

    // Check that the target is a directory
    match host.stat(&normalized) {
        Ok(info) => {
            if !info.exists || !info.is_dir {
                shell_eprint!("cd: {}: Not a directory\n", args.first().unwrap_or(&target));
                return BuiltinResult::Result(1);
            }
        }
        Err(_) => {
            shell_eprint!(
                "cd: {}: No such file or directory\n",
                args.first().unwrap_or(&target)
            );
            return BuiltinResult::Result(1);
        }
    }

    // Update OLDPWD, PWD, and state.cwd
    let old_cwd = state.cwd.clone();
    state.env.insert("OLDPWD".to_string(), old_cwd);
    state.cwd = normalized.clone();
    state.env.insert("PWD".to_string(), normalized);

    BuiltinResult::Result(0)
}

// -- exit -----------------------------------------------------------------

fn builtin_exit(state: &ShellState, args: &[String]) -> BuiltinResult {
    let code = if args.is_empty() {
        state.last_exit_code
    } else {
        args[0].parse::<i32>().unwrap_or(2)
    };
    BuiltinResult::Exit(code)
}

// -- export ---------------------------------------------------------------

fn builtin_export(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() || (args.len() == 1 && args[0] == "-p") {
        // Print all env vars sorted
        let mut vars: Vec<(&String, &String)> = state.env.iter().collect();
        vars.sort_by_key(|(k, _)| (*k).clone());
        let mut output = String::new();
        for (k, v) in vars {
            output.push_str(&format!("declare -x {}=\"{}\"\n", k, v));
        }
        shell_print!("{}", output);
        return BuiltinResult::Result(0);
    }

    // Check for -n flag (unexport)
    let mut unexport = false;
    let mut real_args: Vec<&str> = Vec::new();
    for arg in args {
        if arg == "-p" {
            continue;
        } else if arg == "-n" {
            unexport = true;
        } else {
            real_args.push(arg);
        }
    }

    for arg in &real_args {
        if unexport {
            // Remove from env (unexport) — variable value is lost to subshells
            state.env.remove(*arg);
        } else if let Some(eq_pos) = arg.find('=') {
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];
            state.env.insert(name.to_string(), value.to_string());
        } else {
            // export NAME without value: promote from variables to env
            if state.env.contains_key(*arg) {
                // Already exported, nothing to do
            } else {
                state.env.entry(arg.to_string()).or_default();
            }
        }
    }

    BuiltinResult::Result(0)
}

// -- unset ----------------------------------------------------------------

fn builtin_unset(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    for arg in args {
        // Check for array element: arr[idx]
        if let Some(bracket_pos) = arg.find('[') {
            if arg.ends_with(']') {
                let name = &arg[..bracket_pos];
                let idx_str = &arg[bracket_pos + 1..arg.len() - 1];

                // Try indexed array
                if let Ok(idx) = idx_str.parse::<usize>() {
                    if let Some(arr) = state.arrays.get_mut(name) {
                        if idx < arr.len() {
                            arr[idx] = String::new();
                        }
                        continue;
                    }
                }

                // Try associative array
                if let Some(map) = state.assoc_arrays.get_mut(name) {
                    map.remove(idx_str);
                    continue;
                }
            }
        }

        state.env.remove(arg);
        state.arrays.remove(arg);
        state.assoc_arrays.remove(arg);
    }

    BuiltinResult::Result(0)
}

// -- set ------------------------------------------------------------------

fn builtin_set(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        return BuiltinResult::Result(0);
    }

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];

        if arg == "--" {
            // Set positional parameters
            state.positional_args = args[i + 1..].to_vec();
            return BuiltinResult::Result(0);
        } else if arg.starts_with('-') || arg.starts_with('+') {
            let add = arg.starts_with('-');
            let flag_chars = &arg[1..];

            if flag_chars == "o" {
                // -o / +o option
                i += 1;
                if i < args.len() {
                    let opt = &args[i];
                    match opt.as_str() {
                        "pipefail" => {
                            if add {
                                state.flags.insert(ShellFlag::Pipefail);
                            } else {
                                state.flags.remove(&ShellFlag::Pipefail);
                            }
                        }
                        "errexit" => {
                            if add {
                                state.flags.insert(ShellFlag::Errexit);
                            } else {
                                state.flags.remove(&ShellFlag::Errexit);
                            }
                        }
                        "nounset" => {
                            if add {
                                state.flags.insert(ShellFlag::Nounset);
                            } else {
                                state.flags.remove(&ShellFlag::Nounset);
                            }
                        }
                        _ => {}
                    }
                }
            } else {
                for ch in flag_chars.chars() {
                    match ch {
                        'e' => {
                            if add {
                                state.flags.insert(ShellFlag::Errexit);
                            } else {
                                state.flags.remove(&ShellFlag::Errexit);
                            }
                        }
                        'u' => {
                            if add {
                                state.flags.insert(ShellFlag::Nounset);
                            } else {
                                state.flags.remove(&ShellFlag::Nounset);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        i += 1;
    }

    BuiltinResult::Result(0)
}

// -- local ----------------------------------------------------------------

fn builtin_local(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if state.local_var_stack.is_empty() {
        shell_eprint!("{}", "local: can only be used in a function\n");
        return BuiltinResult::Result(1);
    }

    for arg in args {
        if let Some(eq_pos) = arg.find('=') {
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];

            // Save previous value in the current local frame
            let prev = state.env.get(name).cloned();
            if let Some(frame) = state.local_var_stack.last_mut() {
                frame.entry(name.to_string()).or_insert(prev);
            }

            state.env.insert(name.to_string(), value.to_string());
        } else {
            // local VAR (no value): save previous and set to empty
            let prev = state.env.get(arg).cloned();
            if let Some(frame) = state.local_var_stack.last_mut() {
                frame.entry(arg.clone()).or_insert(prev);
            }
            state.env.entry(arg.clone()).or_default();
        }
    }

    BuiltinResult::Result(0)
}

// -- declare / typeset ----------------------------------------------------

fn builtin_declare(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    let mut is_assoc = false;
    let mut is_array = false;
    let mut is_export = false;
    let mut is_print = false;
    let mut assignments: Vec<&String> = Vec::new();

    for arg in args {
        match arg.as_str() {
            "-A" => is_assoc = true,
            "-a" => is_array = true,
            "-x" => is_export = true,
            "-p" => is_print = true,
            _ => assignments.push(arg),
        }
    }

    if is_print {
        let mut output = String::new();
        let mut stderr = String::new();
        let mut exit_code = 0;
        for arg in &assignments {
            if let Some(val) = state.env.get(*arg) {
                output.push_str(&format!("declare -- {}=\"{}\"\n", arg, val));
            } else if let Some(arr) = state.arrays.get(*arg) {
                let items: Vec<String> = arr
                    .iter()
                    .enumerate()
                    .map(|(idx, v)| format!("[{}]=\"{}\"", idx, v))
                    .collect();
                output.push_str(&format!("declare -a {}=({})\n", arg, items.join(" ")));
            } else if let Some(map) = state.assoc_arrays.get(*arg) {
                let mut items: Vec<String> = map
                    .iter()
                    .map(|(k, v)| format!("[{}]=\"{}\"", k, v))
                    .collect();
                items.sort();
                output.push_str(&format!("declare -A {}=({})\n", arg, items.join(" ")));
            } else {
                stderr.push_str(&format!("declare: {}: not found\n", arg));
                exit_code = 1;
            }
        }
        if assignments.is_empty() {
            // Print all variables
            let mut vars: Vec<(&String, &String)> = state.env.iter().collect();
            vars.sort_by_key(|(k, _)| (*k).clone());
            for (k, v) in vars {
                output.push_str(&format!("declare -- {}=\"{}\"\n", k, v));
            }
        }
        shell_print!("{}", output);
        if !stderr.is_empty() {
            shell_eprint!("{}", stderr);
        }
        return BuiltinResult::Result(exit_code);
    }

    for arg in assignments {
        if let Some(eq_pos) = arg.find('=') {
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];

            if is_assoc {
                // declare -A map=([key1]=val1 [key2]=val2)
                let map = parse_assoc_array_literal(value);
                state.assoc_arrays.insert(name.to_string(), map);
            } else if is_array {
                // declare -a arr=(elem1 elem2)
                let arr = parse_array_literal(value);
                state.arrays.insert(name.to_string(), arr);
            } else {
                // Capture previous value BEFORE insert for local frame
                let prev_value = state.env.get(name).cloned();
                state.env.insert(name.to_string(), value.to_string());
                if is_export {
                    // already in env, which is our "exported" set
                }
                // Save to local frame if in function
                if let Some(frame) = state.local_var_stack.last_mut() {
                    frame.entry(name.to_string()).or_insert(prev_value);
                }
            }

            // Save to local frame for arrays
            if is_assoc || is_array {
                if let Some(frame) = state.local_var_stack.last_mut() {
                    frame.entry(name.to_string()).or_insert(None);
                }
            }
        } else {
            // declare VAR without value
            if is_assoc {
                state.assoc_arrays.entry(arg.clone()).or_default();
            } else if is_array {
                // Convert existing scalar to array[0] if not already an array
                if !state.arrays.contains_key(arg) {
                    if let Some(val) = state.env.remove(arg) {
                        state.arrays.insert(arg.clone(), vec![val]);
                    } else {
                        state.arrays.entry(arg.clone()).or_default();
                    }
                }
            } else {
                state.env.entry(arg.clone()).or_default();
            }
        }
    }

    BuiltinResult::Result(0)
}

/// Parse `([key1]=val1 [key2]=val2)` into a HashMap.
fn parse_assoc_array_literal(value: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let inner = value.trim();
    let inner = if inner.starts_with('(') && inner.ends_with(')') {
        &inner[1..inner.len() - 1]
    } else {
        inner
    };

    // Parse [key]=value pairs
    let mut i = 0;
    let chars: Vec<char> = inner.chars().collect();
    while i < chars.len() {
        // Skip whitespace
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        if chars[i] == '[' {
            i += 1;
            let key_start = i;
            while i < chars.len() && chars[i] != ']' {
                i += 1;
            }
            let key: String = chars[key_start..i].iter().collect();
            i += 1; // skip ]
            if i < chars.len() && chars[i] == '=' {
                i += 1;
                let val = read_value(&chars, &mut i);
                map.insert(key, val);
            }
        } else {
            i += 1;
        }
    }
    map
}

/// Parse `(elem1 elem2 ...)` into a Vec.
fn parse_array_literal(value: &str) -> Vec<String> {
    let inner = value.trim();
    let inner = if inner.starts_with('(') && inner.ends_with(')') {
        &inner[1..inner.len() - 1]
    } else {
        inner
    };
    inner.split_whitespace().map(|s| s.to_string()).collect()
}

/// Read a value from characters, handling quotes.
fn read_value(chars: &[char], i: &mut usize) -> String {
    if *i < chars.len() && chars[*i] == '"' {
        *i += 1;
        let start = *i;
        while *i < chars.len() && chars[*i] != '"' {
            *i += 1;
        }
        let val: String = chars[start..*i].iter().collect();
        if *i < chars.len() {
            *i += 1; // skip closing quote
        }
        val
    } else {
        let start = *i;
        while *i < chars.len() && !chars[*i].is_whitespace() && chars[*i] != ')' {
            *i += 1;
        }
        chars[start..*i].iter().collect()
    }
}

// -- test / [ -------------------------------------------------------------

fn builtin_test(state: &ShellState, host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    let result = eval_test_expr(state, host, args);
    let code = if result { 0 } else { 1 };
    BuiltinResult::Result(code)
}

fn builtin_bracket_test(
    state: &ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    // Remove trailing ]
    let test_args = if !args.is_empty() && args.last().map(|s| s.as_str()) == Some("]") {
        &args[..args.len() - 1]
    } else {
        args
    };
    builtin_test(state, host, test_args)
}

fn eval_test_expr(state: &ShellState, host: &dyn HostInterface, args: &[String]) -> bool {
    if args.is_empty() {
        return false;
    }

    // Handle negation
    if args[0] == "!" {
        return !eval_test_expr(state, host, &args[1..]);
    }

    // Look for -o (OR) at the top level
    for (i, arg) in args.iter().enumerate() {
        if arg == "-o" && i > 0 && i < args.len() - 1 {
            let left = eval_test_expr(state, host, &args[..i]);
            let right = eval_test_expr(state, host, &args[i + 1..]);
            return left || right;
        }
    }
    // Look for -a (AND) at the top level
    for (i, arg) in args.iter().enumerate() {
        if arg == "-a" && i > 0 && i < args.len() - 1 {
            let left = eval_test_expr(state, host, &args[..i]);
            let right = eval_test_expr(state, host, &args[i + 1..]);
            return left && right;
        }
    }

    // Single argument: true if non-empty
    if args.len() == 1 {
        return !args[0].is_empty();
    }

    // Two arguments: unary test
    if args.len() == 2 {
        let op = &args[0];
        let val = &args[1];
        return match op.as_str() {
            "-z" => val.is_empty(),
            "-n" => !val.is_empty(),
            "-f" => {
                let path = state.resolve_path(val);
                host.stat(&path)
                    .map(|s| s.exists && s.is_file)
                    .unwrap_or(false)
            }
            "-d" => {
                let path = state.resolve_path(val);
                host.stat(&path)
                    .map(|s| s.exists && s.is_dir)
                    .unwrap_or(false)
            }
            "-e" => {
                let path = state.resolve_path(val);
                host.stat(&path).map(|s| s.exists).unwrap_or(false)
            }
            "-s" => {
                let path = state.resolve_path(val);
                host.stat(&path)
                    .map(|s| s.exists && s.size > 0)
                    .unwrap_or(false)
            }
            "-r" | "-w" | "-x" => {
                // In our sandbox, just check existence
                let path = state.resolve_path(val);
                host.stat(&path).map(|s| s.exists).unwrap_or(false)
            }
            _ => !val.is_empty(), // single arg: true if non-empty
        };
    }

    // Three arguments: binary test
    if args.len() == 3 {
        let left = &args[0];
        let op = &args[1];
        let right = &args[2];

        return match op.as_str() {
            "=" | "==" => left == right,
            "!=" => left != right,
            "-eq" => left.parse::<i64>().unwrap_or(0) == right.parse::<i64>().unwrap_or(0),
            "-ne" => left.parse::<i64>().unwrap_or(0) != right.parse::<i64>().unwrap_or(0),
            "-lt" => left.parse::<i64>().unwrap_or(0) < right.parse::<i64>().unwrap_or(0),
            "-le" => left.parse::<i64>().unwrap_or(0) <= right.parse::<i64>().unwrap_or(0),
            "-gt" => left.parse::<i64>().unwrap_or(0) > right.parse::<i64>().unwrap_or(0),
            "-ge" => left.parse::<i64>().unwrap_or(0) >= right.parse::<i64>().unwrap_or(0),
            _ => false,
        };
    }

    false
}

// -- read -----------------------------------------------------------------

fn builtin_read(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    let mut raw = false;
    let mut delimiter = '\n';
    let mut nchars: Option<usize> = None;
    let mut array_mode = false;
    let mut array_name = String::new();
    let mut var_names: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-r" => raw = true,
            "-p" => {
                // -p prompt: skip the prompt string (no tty output)
                i += 1; // skip the prompt string
            }
            "-d" => {
                i += 1;
                if i < args.len() && !args[i].is_empty() {
                    delimiter = args[i].chars().next().unwrap_or('\n');
                }
            }
            "-n" => {
                i += 1;
                if i < args.len() {
                    nchars = args[i].parse().ok();
                }
            }
            "-a" => {
                i += 1;
                if i < args.len() {
                    array_mode = true;
                    array_name = args[i].clone();
                }
            }
            other => {
                var_names.push(other.to_string());
            }
        }
        i += 1;
    }

    // Stdin comes from fd 0. Input redirects and pipelines dup2 their
    // data onto fd 0 before we get here. pipeline_stdin holds leftover
    // data from a previous read in the same compound command.
    let use_pipeline = if state.pipeline_stdin.is_some() {
        true
    } else {
        // On WASM: read line-by-line from stdin via WASI fd_read (JSPI-wrapped),
        // so the WASM stack suspends until upstream pipe data arrives.
        // On native: use host.read_fd(0) which drains the pipe synchronously.
        let _ = &host; // used only on non-wasm32
        #[cfg(target_arch = "wasm32")]
        {
            use std::io::BufRead;
            let stdin = std::io::stdin();
            let mut reader = stdin.lock();
            let mut buf = Vec::new();
            match reader.read_until(delimiter as u8, &mut buf) {
                Ok(0) => false,
                Ok(_) => {
                    if buf.last() == Some(&(delimiter as u8)) {
                        buf.pop();
                    }
                    if delimiter == '\n' && buf.last() == Some(&b'\r') {
                        buf.pop();
                    }
                    state.pipeline_stdin = Some(String::from_utf8_lossy(&buf).to_string());
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            match host.read_fd(0) {
                Ok(data) if !data.is_empty() => {
                    state.pipeline_stdin = Some(String::from_utf8_lossy(&data).to_string());
                    true
                }
                _ => false,
            }
        }
    };
    let effective_stdin = if use_pipeline {
        state.pipeline_stdin.clone().unwrap_or_default()
    } else {
        String::new()
    };

    // Read input
    let input = if let Some(n) = nchars {
        let byte_end = effective_stdin
            .char_indices()
            .nth(n)
            .map(|(i, _)| i)
            .unwrap_or(effective_stdin.len());
        &effective_stdin[..byte_end]
    } else {
        // Read up to delimiter
        match effective_stdin.find(delimiter) {
            Some(pos) => &effective_stdin[..pos],
            None => &effective_stdin,
        }
    };

    // Advance pipeline_stdin past consumed data
    if use_pipeline {
        let consumed = input.len();
        let remaining = &effective_stdin[consumed..];
        // Skip the delimiter too
        let remaining = if remaining.starts_with(delimiter) {
            &remaining[delimiter.len_utf8()..]
        } else {
            remaining
        };
        if remaining.is_empty() {
            state.pipeline_stdin = None;
        } else {
            state.pipeline_stdin = Some(remaining.to_string());
        }
    }

    let input = if !raw {
        // Process backslash continuations (simplistic)
        input.replace("\\\n", "")
    } else {
        input.to_string()
    };

    if array_mode {
        let parts: Vec<String> = input.split_whitespace().map(|s| s.to_string()).collect();
        state.arrays.insert(array_name, parts);
    } else if var_names.is_empty() {
        state.env.insert("REPLY".to_string(), input.to_string());
    } else if var_names.len() == 1 {
        state
            .env
            .insert(var_names[0].clone(), input.trim().to_string());
    } else {
        let parts: Vec<&str> = input.splitn(var_names.len(), char::is_whitespace).collect();
        for (j, name) in var_names.iter().enumerate() {
            let val = parts.get(j).unwrap_or(&"").to_string();
            state.env.insert(name.clone(), val);
        }
    }

    // Exit code: 0 unless input was empty (EOF)
    let code = if effective_stdin.is_empty() { 1 } else { 0 };
    BuiltinResult::Result(code)
}

// -- shift ----------------------------------------------------------------

fn builtin_shift(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    let n = if args.is_empty() {
        1usize
    } else {
        args[0].parse::<usize>().unwrap_or(1)
    };

    if n > state.positional_args.len() {
        shell_eprint!("{}", "shift: shift count out of range\n");
        return BuiltinResult::Result(1);
    }

    state.positional_args = state.positional_args[n..].to_vec();
    BuiltinResult::Result(0)
}

// -- type -----------------------------------------------------------------

fn builtin_type(state: &ShellState, host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    let mut output = String::new();
    let mut code = 0;
    let mut type_only = false;

    let mut real_args: Vec<&str> = Vec::new();
    for arg in args {
        if arg == "-t" {
            type_only = true;
        } else if arg == "-a" || arg == "-p" || arg == "-f" {
            // Ignore other flags for now
        } else {
            real_args.push(arg);
        }
    }

    for arg in &real_args {
        if is_builtin(arg) {
            if type_only {
                output.push_str("builtin\n");
            } else {
                output.push_str(&format!("{} is a shell builtin\n", arg));
            }
        } else if state.functions.contains_key(*arg) {
            if type_only {
                output.push_str("function\n");
            } else {
                output.push_str(&format!("{} is a function\n", arg));
            }
        } else if crate::virtual_commands::is_virtual_command(arg) || host.has_tool(arg) {
            if type_only {
                output.push_str("file\n");
            } else {
                output.push_str(&format!("{} is /usr/bin/{}\n", arg, arg));
            }
        } else {
            if !type_only {
                output.push_str(&format!("{}: not found\n", arg));
            }
            code = 1;
        }
    }

    shell_print!("{}", output);
    BuiltinResult::Result(code)
}

// -- command ---------------------------------------------------------------

fn builtin_command(host: &dyn HostInterface, args: &[String]) -> Option<BuiltinResult> {
    if args.is_empty() {
        return Some(BuiltinResult::Result(0));
    }

    if args[0] == "-v" {
        // Check if command exists
        if args.len() < 2 {
            return Some(BuiltinResult::Result(1));
        }
        let name = &args[1];
        if is_builtin(name) {
            let out = format!("{}\n", name);
            shell_print!("{}", out);
            return Some(BuiltinResult::Result(0));
        }
        if crate::virtual_commands::is_virtual_command(name) || host.has_tool(name) {
            let out = format!("/usr/bin/{}\n", name);
            shell_print!("{}", out);
            return Some(BuiltinResult::Result(0));
        }
        return Some(BuiltinResult::Result(1));
    }

    // Without -v, return None to fall through to spawn (bypassing functions)
    None
}

// -- let ------------------------------------------------------------------

fn builtin_let(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    let mut last_val = 0i64;
    for arg in args {
        last_val = eval_arithmetic(state, arg);
    }
    // Exit code: 0 if last result is non-zero, 1 if zero
    let code = if last_val != 0 { 0 } else { 1 };
    BuiltinResult::Result(code)
}

// -- which ----------------------------------------------------------------

fn builtin_which(host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        return BuiltinResult::Result(0);
    }

    let mut output = String::new();
    let mut code = 0;

    for arg in args {
        if is_builtin(arg) || crate::virtual_commands::is_virtual_command(arg) {
            output.push_str(&format!("/bin/{}\n", arg));
        } else {
            // Search PATH-like directories for executables
            let mut found = false;
            for dir in &["/bin", "/usr/bin"] {
                let path = format!("{}/{}", dir, arg);
                if let Ok(info) = host.stat(&path) {
                    if info.exists && info.is_file {
                        output.push_str(&format!("{}\n", path));
                        found = true;
                        break;
                    }
                }
            }
            // Fallback: check the tool registry (for WASM tools not yet on VFS)
            if !found && host.has_tool(arg) {
                output.push_str(&format!("/bin/{}\n", arg));
                found = true;
            }
            if !found {
                code = 1;
            }
        }
    }

    shell_print!("{}", output);
    BuiltinResult::Result(code)
}

// -- source / . -----------------------------------------------------------

fn builtin_source(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
    run: Option<RunFn>,
) -> BuiltinResult {
    if args.is_empty() {
        shell_eprint!("{}", "source: filename argument required\n");
        return BuiltinResult::Result(1);
    }

    let path = state.resolve_path(&args[0]);
    let content = match host.read_file_str(&path) {
        Ok(c) => c,
        Err(e) => {
            shell_eprint!("source: {}: {}\n", args[0], e);
            return BuiltinResult::Result(1);
        }
    };

    // Strip shebang line
    let script = if content.starts_with("#!") {
        match content.find('\n') {
            Some(pos) => &content[pos + 1..],
            None => "",
        }
    } else {
        &content
    };

    if let Some(run_fn) = run {
        // Set BASH_SOURCE
        let prev_bash_source = state.env.get("BASH_SOURCE").cloned();
        state.env.insert("BASH_SOURCE".to_string(), args[0].clone());

        let result = run_fn(state, script);

        // Restore BASH_SOURCE
        if let Some(prev) = prev_bash_source {
            state.env.insert("BASH_SOURCE".to_string(), prev);
        } else {
            state.env.remove("BASH_SOURCE");
        }

        BuiltinResult::Result(result.exit_code)
    } else {
        shell_eprint!("{}", "source: no runner available\n");
        BuiltinResult::Result(1)
    }
}

// -- eval -----------------------------------------------------------------

fn builtin_eval(state: &mut ShellState, args: &[String], run: Option<RunFn>) -> BuiltinResult {
    if args.is_empty() {
        return BuiltinResult::Result(0);
    }

    let cmd_str = args.join(" ");

    if let Some(run_fn) = run {
        let result = run_fn(state, &cmd_str);
        BuiltinResult::Result(result.exit_code)
    } else {
        shell_eprint!("{}", "eval: no runner available\n");
        BuiltinResult::Result(1)
    }
}

// -- return ---------------------------------------------------------------

fn builtin_return(state: &ShellState, args: &[String]) -> BuiltinResult {
    let code = if args.is_empty() {
        state.last_exit_code
    } else {
        args[0].parse::<i32>().unwrap_or(0)
    };
    BuiltinResult::Return(code)
}

// -- history --------------------------------------------------------------

fn builtin_history(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    let subcmd = args.first().map(|s| s.as_str()).unwrap_or("list");

    match subcmd {
        "clear" => {
            state.history.clear();
            BuiltinResult::Result(0)
        }
        "list" | "" => {
            let mut output = String::new();
            for (i, entry) in state.history.iter().enumerate() {
                output.push_str(&format!("  {}  {}\n", i + 1, entry));
            }
            shell_print!("{}", output);
            BuiltinResult::Result(0)
        }
        other => {
            shell_eprint!("history: unknown subcommand: {other}\n");
            BuiltinResult::Result(1)
        }
    }
}

// -- trap -----------------------------------------------------------------

fn builtin_trap(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        // Print all traps
        let mut output = String::new();
        let mut traps: Vec<(&String, &String)> = state.traps.iter().collect();
        traps.sort_by_key(|(k, _)| (*k).clone());
        for (signal, action) in traps {
            output.push_str(&format!("trap -- '{}' {}\n", action, signal));
        }
        shell_print!("{}", output);
        return BuiltinResult::Result(0);
    }

    // trap -p [SIGNAL...] — print traps
    if args[0] == "-p" {
        let mut output = String::new();
        if args.len() > 1 {
            for signal in &args[1..] {
                if let Some(action) = state.traps.get(signal) {
                    output.push_str(&format!("trap -- '{}' {}\n", action, signal));
                }
            }
        } else {
            let mut traps: Vec<(&String, &String)> = state.traps.iter().collect();
            traps.sort_by_key(|(k, _)| (*k).clone());
            for (signal, action) in traps {
                output.push_str(&format!("trap -- '{}' {}\n", action, signal));
            }
        }
        shell_print!("{}", output);
        return BuiltinResult::Result(0);
    }

    if args.len() < 2 {
        shell_eprint!("{}", "trap: usage: trap action signal...\n");
        return BuiltinResult::Result(1);
    }

    let action = &args[0];
    for signal in &args[1..] {
        if action == "-" || action.is_empty() {
            // trap - SIGNAL or trap '' SIGNAL — clear the trap
            state.traps.remove(signal);
        } else {
            state.traps.insert(signal.clone(), action.clone());
        }
    }

    BuiltinResult::Result(0)
}

// -- getopts --------------------------------------------------------------

fn builtin_getopts(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.len() < 2 {
        shell_eprint!("{}", "getopts: usage: getopts optstring name [args]\n");
        return BuiltinResult::Result(1);
    }

    let optstring = &args[0];
    let var_name = &args[1];
    let opt_args: Vec<&str> = if args.len() > 2 {
        args[2..].iter().map(|s| s.as_str()).collect()
    } else {
        state.positional_args.iter().map(|s| s.as_str()).collect()
    };

    let optind: usize = state
        .env
        .get("OPTIND")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let idx = optind - 1; // Convert 1-based to 0-based

    if idx >= opt_args.len() {
        state.env.insert(var_name.clone(), "?".to_string());
        return BuiltinResult::Result(1);
    }

    let current = opt_args[idx];
    if !current.starts_with('-') || current == "-" || current == "--" {
        state.env.insert(var_name.clone(), "?".to_string());
        return BuiltinResult::Result(1);
    }

    // Get the option character (skip the leading -)
    let opt_char = current.chars().nth(1).unwrap_or('?');

    if optstring.contains(opt_char) {
        state.env.insert(var_name.clone(), opt_char.to_string());

        // Check if this option takes an argument (char after opt_char is ':')
        let needs_arg = optstring
            .chars()
            .skip_while(|&c| c != opt_char)
            .nth(1)
            .map(|c| c == ':')
            .unwrap_or(false);

        if needs_arg {
            // Argument is either rest of current word or next word
            // Get byte offset past the option char (skip '-' and opt_char)
            let arg_start = current
                .char_indices()
                .nth(2)
                .map(|(i, _)| i)
                .unwrap_or(current.len());
            if arg_start < current.len() {
                state
                    .env
                    .insert("OPTARG".to_string(), current[arg_start..].to_string());
                state
                    .env
                    .insert("OPTIND".to_string(), (optind + 1).to_string());
            } else if idx + 1 < opt_args.len() {
                state
                    .env
                    .insert("OPTARG".to_string(), opt_args[idx + 1].to_string());
                state
                    .env
                    .insert("OPTIND".to_string(), (optind + 2).to_string());
            } else {
                state.env.insert(var_name.clone(), "?".to_string());
                state
                    .env
                    .insert("OPTIND".to_string(), (optind + 1).to_string());
                shell_eprint!("getopts: option requires an argument -- {}\n", opt_char);
                return BuiltinResult::Result(1);
            }
        } else {
            state
                .env
                .insert("OPTIND".to_string(), (optind + 1).to_string());
        }

        BuiltinResult::Result(0)
    } else {
        // Unknown option
        state.env.insert(var_name.clone(), "?".to_string());
        state
            .env
            .insert("OPTIND".to_string(), (optind + 1).to_string());
        BuiltinResult::Result(0)
    }
}

// -- mapfile / readarray --------------------------------------------------

fn builtin_mapfile(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    let mut strip_newline = false;
    let mut max_lines: Option<usize> = None;
    let mut array_name = "MAPFILE".to_string();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" => strip_newline = true,
            "-n" => {
                i += 1;
                if i < args.len() {
                    max_lines = args[i].parse().ok();
                }
            }
            other => {
                if !other.starts_with('-') {
                    array_name = other.to_string();
                }
            }
        }
        i += 1;
    }

    // Read stdin from fd 0.
    let stdin_data = match host.read_fd(0) {
        Ok(data) if !data.is_empty() => String::from_utf8_lossy(&data).to_string(),
        _ => String::new(),
    };
    let lines: Vec<String> = stdin_data
        .split('\n')
        .enumerate()
        .take_while(|(idx, _)| max_lines.is_none_or(|max| *idx < max))
        .map(|(_, line)| {
            if strip_newline {
                line.to_string()
            } else {
                format!("{}\n", line)
            }
        })
        .collect();

    // Remove trailing empty entry that comes from final newline
    let lines = if strip_newline {
        let mut l = lines;
        if l.last().map(|s| s.is_empty()).unwrap_or(false) {
            l.pop();
        }
        l
    } else {
        lines
    };

    state.arrays.insert(array_name, lines);

    BuiltinResult::Result(0)
}

// -- chmod ----------------------------------------------------------------

fn builtin_chmod(state: &ShellState, host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        shell_eprint!("{}", "chmod: missing operand\n");
        return BuiltinResult::Result(1);
    }
    if args.len() < 2 {
        shell_eprint!("chmod: missing operand after '{}'\n", args[0]);
        return BuiltinResult::Result(1);
    }

    let mode_str = &args[0];

    let mut stderr = String::new();
    let mut code = 0;

    for file in &args[1..] {
        let path = state.resolve_path(file);

        // Get current file mode for symbolic changes
        let current_mode = host.stat(&path).map(|s| s.mode).unwrap_or(0o644);

        let new_mode = if let Ok(m) = u32::from_str_radix(mode_str, 8) {
            m
        } else if let Some(m) = parse_symbolic_mode(mode_str, current_mode) {
            m
        } else {
            stderr.push_str(&format!("chmod: invalid mode: '{}'\n", mode_str));
            code = 1;
            continue;
        };

        if let Err(e) = host.chmod(&path, new_mode) {
            stderr.push_str(&format!("chmod: cannot access '{}': {}\n", file, e));
            code = 1;
        }
    }

    if !stderr.is_empty() {
        shell_eprint!("{}", stderr);
    }
    BuiltinResult::Result(code)
}

/// Parse symbolic mode string like "+x", "u+x", "go-w", "a+r"
fn parse_symbolic_mode(s: &str, current: u32) -> Option<u32> {
    let mut mode = current;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;

    // Parse who: u, g, o, a (default: a)
    let mut who_u = false;
    let mut who_g = false;
    let mut who_o = false;
    while i < chars.len() && "ugoa".contains(chars[i]) {
        match chars[i] {
            'u' => who_u = true,
            'g' => who_g = true,
            'o' => who_o = true,
            'a' => {
                who_u = true;
                who_g = true;
                who_o = true;
            }
            _ => {}
        }
        i += 1;
    }
    // Default to all if no who specified
    if !who_u && !who_g && !who_o {
        who_u = true;
        who_g = true;
        who_o = true;
    }

    if i >= chars.len() {
        return None;
    }

    // Parse operator: +, -, =
    let op = chars[i];
    if op != '+' && op != '-' && op != '=' {
        return None;
    }
    i += 1;

    // Parse permissions: r, w, x
    let mut bits: u32 = 0;
    while i < chars.len() {
        match chars[i] {
            'r' => bits |= 4,
            'w' => bits |= 2,
            'x' => bits |= 1,
            _ => return None,
        }
        i += 1;
    }

    // Apply to appropriate positions
    let mut mask: u32 = 0;
    if who_u {
        mask |= bits << 6;
    }
    if who_g {
        mask |= bits << 3;
    }
    if who_o {
        mask |= bits;
    }

    match op {
        '+' => mode |= mask,
        '-' => mode &= !mask,
        '=' => {
            let clear = if who_u { 0o700 } else { 0 }
                | if who_g { 0o070 } else { 0 }
                | if who_o { 0o007 } else { 0 };
            mode = (mode & !clear) | mask;
        }
        _ => {}
    }

    Some(mode)
}

// -- date -----------------------------------------------------------------

fn builtin_date(host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    let ts_secs = host.time() as u64;

    let output = if !args.is_empty() && args[0].starts_with('+') {
        let format = &args[0][1..];
        apply_date_format(format, ts_secs)
    } else {
        format_timestamp(ts_secs)
    };
    shell_println!("{}", output);
    BuiltinResult::Result(0)
}

fn format_timestamp(ts: u64) -> String {
    let (year, month, day, hour, min, sec) = unix_to_utc(ts);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, min, sec
    )
}

fn apply_date_format(format: &str, ts: u64) -> String {
    let (year, month, day, hour, min, sec) = unix_to_utc(ts);

    let mut out = String::new();
    let chars: Vec<char> = format.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == '%' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                'Y' => out.push_str(&format!("{:04}", year)),
                'm' => out.push_str(&format!("{:02}", month)),
                'd' => out.push_str(&format!("{:02}", day)),
                'H' => out.push_str(&format!("{:02}", hour)),
                'M' => out.push_str(&format!("{:02}", min)),
                'S' => out.push_str(&format!("{:02}", sec)),
                's' => out.push_str(&ts.to_string()),
                'F' => out.push_str(&format!("{:04}-{:02}-{:02}", year, month, day)),
                'T' => out.push_str(&format!("{:02}:{:02}:{:02}", hour, min, sec)),
                '%' => out.push('%'),
                other => {
                    out.push('%');
                    out.push(other);
                }
            }
        } else {
            out.push(chars[i]);
        }
        i += 1;
    }
    out
}

/// Convert Unix timestamp (seconds) to UTC (year, month, day, hour, min, sec).
fn unix_to_utc(ts: u64) -> (u64, u64, u64, u64, u64, u64) {
    let secs_per_day = 86400u64;
    let mut days = ts / secs_per_day;
    let day_secs = ts % secs_per_day;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;
    let sec = day_secs % 60;

    // Days since epoch (1970-01-01)
    let mut year = 1970u64;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    let month_days = if is_leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1u64;
    for md in &month_days {
        if days < *md as u64 {
            break;
        }
        days -= *md as u64;
        month += 1;
    }
    let day = days + 1;

    (year, month, day, hour, min, sec)
}

fn is_leap(y: u64) -> bool {
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
}

// -- exec -----------------------------------------------------------------

fn builtin_exec_cmd(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
    stdin_data: &str,
    run: Option<RunFn>,
) -> BuiltinResult {
    if args.is_empty() {
        return BuiltinResult::Result(0);
    }
    // Re-dispatch: build a command string from args and run it
    let cmd_str = args
        .iter()
        .map(|a| {
            if a.contains(' ') || a.contains('"') || a.contains('\'') {
                format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    // Try as builtin first
    if let Some(result) = try_builtin(state, host, &args[0], &args[1..], stdin_data, run) {
        return result;
    }
    // Fall through to external command via run callback
    if let Some(run_fn) = run {
        let r = run_fn(state, &cmd_str);
        state.last_exit_code = r.exit_code;
        return BuiltinResult::Result(r.exit_code);
    }
    shell_eprint!("{}: command not found\n", args[0]);
    BuiltinResult::Result(127)
}

// -- pushd/popd/dirs -------------------------------------------------------

fn builtin_pushd(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    let dir = if args.is_empty() {
        // pushd with no args swaps top two
        if let Some(top) = state.dir_stack.last().cloned() {
            let prev = state.cwd.clone();
            state.cwd = top;
            state.env.insert("PWD".to_string(), state.cwd.clone());
            state.env.insert("OLDPWD".to_string(), prev.clone());
            *state.dir_stack.last_mut().unwrap() = prev;
            let stack = format_dir_stack(state);
            let out = format!("{stack}\n");
            shell_print!("{}", out);
            return BuiltinResult::Result(0);
        } else {
            shell_eprint!("{}", "pushd: no other directory\n");
            return BuiltinResult::Result(1);
        }
    } else {
        state.resolve_path(&args[0])
    };

    // Verify the directory exists
    if let Ok(stat) = host.stat(&dir) {
        if stat.is_dir {
            state.dir_stack.push(state.cwd.clone());
            state.env.insert("OLDPWD".to_string(), state.cwd.clone());
            state.cwd = dir;
            state.env.insert("PWD".to_string(), state.cwd.clone());
            let stack = format_dir_stack(state);
            let out = format!("{stack}\n");
            shell_print!("{}", out);
            BuiltinResult::Result(0)
        } else {
            shell_eprint!("pushd: {}: Not a directory\n", args[0]);
            BuiltinResult::Result(1)
        }
    } else {
        shell_eprint!("pushd: {}: No such file or directory\n", args[0]);
        BuiltinResult::Result(1)
    }
}

fn builtin_popd(state: &mut ShellState) -> BuiltinResult {
    if let Some(prev) = state.dir_stack.pop() {
        state.env.insert("OLDPWD".to_string(), state.cwd.clone());
        state.cwd = prev;
        state.env.insert("PWD".to_string(), state.cwd.clone());
        let stack = format_dir_stack(state);
        let out = format!("{stack}\n");
        shell_print!("{}", out);
        BuiltinResult::Result(0)
    } else {
        shell_eprint!("{}", "popd: directory stack empty\n");
        BuiltinResult::Result(1)
    }
}

fn builtin_dirs(state: &mut ShellState) -> BuiltinResult {
    let stack = format_dir_stack(state);
    shell_println!("{}", stack);
    BuiltinResult::Result(0)
}

fn format_dir_stack(state: &ShellState) -> String {
    let mut dirs = vec![state.cwd.clone()];
    for d in state.dir_stack.iter().rev() {
        dirs.push(d.clone());
    }
    dirs.join(" ")
}

// -- readonly --------------------------------------------------------------

fn builtin_readonly(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() || (args.len() == 1 && args[0] == "-p") {
        // Print all readonly variables
        let mut lines: Vec<String> = state
            .readonly_vars
            .iter()
            .map(|name| {
                let val = state.env.get(name).cloned().unwrap_or_default();
                format!("declare -r {name}=\"{val}\"")
            })
            .collect();
        lines.sort();
        let stdout = if lines.is_empty() {
            String::new()
        } else {
            lines.join("\n") + "\n"
        };
        shell_print!("{}", stdout);
        return BuiltinResult::Result(0);
    }

    for arg in args {
        if arg == "-p" {
            continue;
        }
        if let Some(eq_pos) = arg.find('=') {
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];
            if state.readonly_vars.contains(name) {
                shell_eprint!("readonly: {name}: readonly variable\n");
                return BuiltinResult::Result(1);
            }
            state.env.insert(name.to_string(), value.to_string());
            state.readonly_vars.insert(name.to_string());
        } else {
            // Mark existing var as readonly
            state.readonly_vars.insert(arg.to_string());
        }
    }

    BuiltinResult::Result(0)
}

// ---------------------------------------------------------------------------
// Background-job builtins: sleep, wait, jobs, ps
// ---------------------------------------------------------------------------

fn builtin_sleep(_host: &dyn HostInterface, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        shell_eprintln!("sleep: missing operand");
        return BuiltinResult::Result(1);
    }
    let secs: f64 = args[0].parse().unwrap_or(0.0);
    let ms = (secs * 1000.0) as u64;
    if ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    BuiltinResult::Result(0)
}

fn builtin_wait(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    if args.is_empty() {
        // Wait for all background jobs
        for job in &mut state.jobs {
            if job.done.is_none() {
                match host.waitpid(job.pid) {
                    Ok(result) => {
                        job.done = Some(result.exit_code);
                    }
                    Err(_) => {
                        job.done = Some(-1);
                    }
                }
            }
        }
        let last_code = state.jobs.last().and_then(|j| j.done).unwrap_or(0);
        state.last_exit_code = last_code;
    } else {
        // Wait for specific PIDs
        let mut last_code = 0;
        for arg in args {
            if let Ok(pid) = arg.parse::<i32>() {
                if let Some(job) = state.jobs.iter_mut().find(|j| j.pid == pid) {
                    if job.done.is_none() {
                        match host.waitpid(pid) {
                            Ok(result) => {
                                job.done = Some(result.exit_code);
                                last_code = result.exit_code;
                            }
                            Err(_) => {
                                job.done = Some(-1);
                                last_code = -1;
                            }
                        }
                    } else {
                        last_code = job.done.unwrap_or(0);
                    }
                } else {
                    match host.waitpid(pid) {
                        Ok(result) => {
                            last_code = result.exit_code;
                        }
                        Err(_) => {
                            last_code = 127;
                        }
                    }
                }
            }
        }
        state.last_exit_code = last_code;
    }
    BuiltinResult::Result(state.last_exit_code)
}

fn builtin_jobs(state: &mut ShellState, host: &dyn HostInterface) -> BuiltinResult {
    // Reap finished jobs first
    for job in &mut state.jobs {
        if job.done.is_none() {
            if let Ok(code) = host.waitpid_nohang(job.pid) {
                if code >= 0 {
                    job.done = Some(code);
                }
            }
        }
    }
    for job in &state.jobs {
        let status = match job.done {
            Some(code) => format!("Done({})", code),
            None => "Running".to_string(),
        };
        shell_println!("[{}] {} {}", job.id, status, job.command);
    }
    // Remove completed jobs after display
    state.jobs.retain(|j| j.done.is_none());
    BuiltinResult::Result(0)
}

fn builtin_ps(host: &dyn HostInterface) -> BuiltinResult {
    match host.list_processes() {
        Ok(json) => {
            if let Ok(procs) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
                shell_println!("{:<8} {:<10} {}", "PID", "STATE", "COMMAND");
                for p in &procs {
                    let pid = p["pid"].as_i64().unwrap_or(0);
                    let st = p["state"].as_str().unwrap_or("unknown");
                    let cmd = p["command"].as_str().unwrap_or("");
                    shell_println!("{:<8} {:<10} {}", pid, st, cmd);
                }
            }
            BuiltinResult::Result(0)
        }
        Err(e) => {
            shell_eprintln!("ps: {}", e);
            BuiltinResult::Result(1)
        }
    }
}

// -- kill -----------------------------------------------------------------

/// Map a signal name to its conventional number.
fn signal_number(name: &str) -> Option<i32> {
    let name = name.strip_prefix("SIG").unwrap_or(name);
    match name {
        "HUP" => Some(1),
        "INT" => Some(2),
        "QUIT" => Some(3),
        "KILL" => Some(9),
        "USR1" => Some(10),
        "USR2" => Some(12),
        "TERM" => Some(15),
        "STOP" => Some(17),
        "CONT" => Some(19),
        _ => None,
    }
}

/// All signal names we advertise, in numeric order.
const SIGNAL_NAMES: &[&str] = &[
    "HUP", "INT", "QUIT", "KILL", "USR1", "USR2", "TERM", "STOP", "CONT",
];

fn builtin_kill(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    // Parse options: kill [-s SIGNAL | -SIGNAL] PID... | kill -l
    let mut signal = 15_i32; // default: TERM
    let mut pids: Vec<String> = Vec::new();
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        if arg == "-l" {
            // List signals
            let mut out = String::new();
            for (idx, name) in SIGNAL_NAMES.iter().enumerate() {
                if idx > 0 {
                    out.push(' ');
                }
                out.push_str(name);
            }
            out.push('\n');
            shell_print!("{}", out);
            return BuiltinResult::Result(0);
        } else if arg == "-s" {
            i += 1;
            if i >= args.len() {
                shell_eprintln!("kill: -s requires a signal name");
                return BuiltinResult::Result(1);
            }
            let name = args[i].to_uppercase();
            match signal_number(&name) {
                Some(n) => signal = n,
                None => {
                    // Try numeric
                    if let Ok(n) = name.parse::<i32>() {
                        signal = n;
                    } else {
                        shell_eprintln!("kill: unknown signal: {}", args[i]);
                        return BuiltinResult::Result(1);
                    }
                }
            }
        } else if let Some(signame) = arg.strip_prefix('-') {
            // -SIGNAL (e.g. -TERM, -9, -KILL)
            if pids.is_empty() {
                let signame_upper = signame.to_uppercase();
                if let Some(n) = signal_number(&signame_upper) {
                    signal = n;
                } else if let Ok(n) = signame.parse::<i32>() {
                    signal = n;
                } else {
                    shell_eprintln!("kill: unknown signal: {}", signame);
                    return BuiltinResult::Result(1);
                }
            } else {
                // Negative number as PID? Not valid.
                shell_eprintln!("kill: invalid pid: {}", arg);
                return BuiltinResult::Result(1);
            }
        } else {
            pids.push(arg.clone());
        }
        i += 1;
    }

    if pids.is_empty() {
        shell_eprintln!("kill: usage: kill [-s signal | -signal] pid ...");
        return BuiltinResult::Result(1);
    }

    let exit_code = 128 + signal;
    let mut errors = 0;

    for pid_str in &pids {
        if let Some(job_spec) = pid_str.strip_prefix('%') {
            // Job reference: %N
            if let Ok(job_id) = job_spec.parse::<usize>() {
                if let Some(job) = state.jobs.iter_mut().find(|j| j.id == job_id) {
                    if job.done.is_some() {
                        shell_eprintln!("kill: %{}: job has already terminated", job_id);
                        errors += 1;
                    } else {
                        job.done = Some(exit_code);
                        // Also reap via waitpid_nohang so the kernel knows
                        let _ = host.waitpid_nohang(job.pid);
                    }
                } else {
                    shell_eprintln!("kill: %{}: no such job", job_id);
                    errors += 1;
                }
            } else {
                shell_eprintln!("kill: %{}: invalid job spec", job_spec);
                errors += 1;
            }
        } else if let Ok(pid) = pid_str.parse::<i32>() {
            // Direct PID
            // Check if it's in our job table first
            if let Some(job) = state.jobs.iter_mut().find(|j| j.pid == pid) {
                if job.done.is_some() {
                    shell_eprintln!("kill: ({}): process already terminated", pid);
                    errors += 1;
                } else {
                    job.done = Some(exit_code);
                    let _ = host.waitpid_nohang(pid);
                }
            } else {
                // Not in job table — try waitpid_nohang to see if it exists
                match host.waitpid_nohang(pid) {
                    Ok(code) if code >= 0 => {
                        // Already exited
                        shell_eprintln!("kill: ({}): process already terminated", pid);
                        errors += 1;
                    }
                    Ok(_) => {
                        // Still running but not in our job table; nothing more
                        // we can do without a host kill syscall.
                    }
                    Err(_) => {
                        shell_eprintln!("kill: ({}): no such process", pid);
                        errors += 1;
                    }
                }
            }
        } else {
            shell_eprintln!("kill: {}: invalid pid", pid_str);
            errors += 1;
        }
    }

    BuiltinResult::Result(if errors > 0 { 1 } else { 0 })
}

// -- alias / unalias ------------------------------------------------------

fn builtin_alias(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        // List all aliases sorted
        let mut aliases: Vec<(&String, &String)> = state.aliases.iter().collect();
        aliases.sort_by_key(|(k, _)| (*k).clone());
        let mut output = String::new();
        for (name, value) in aliases {
            output.push_str(&format!("alias {}='{}'\n", name, value));
        }
        shell_print!("{}", output);
        return BuiltinResult::Result(0);
    }

    let mut code = 0;
    for arg in args {
        if let Some(eq_pos) = arg.find('=') {
            // Define alias: name=value
            let name = &arg[..eq_pos];
            let value = &arg[eq_pos + 1..];
            state.aliases.insert(name.to_string(), value.to_string());
        } else {
            // Print single alias
            if let Some(value) = state.aliases.get(arg) {
                shell_print!("alias {}='{}'\n", arg, value);
            } else {
                shell_eprint!("alias: {}: not found\n", arg);
                code = 1;
            }
        }
    }
    BuiltinResult::Result(code)
}

fn builtin_unalias(state: &mut ShellState, args: &[String]) -> BuiltinResult {
    if args.is_empty() {
        shell_eprint!("unalias: usage: unalias [-a] name [name ...]\n");
        return BuiltinResult::Result(2);
    }

    let mut code = 0;
    for arg in args {
        if arg == "-a" {
            state.aliases.clear();
        } else if state.aliases.remove(arg).is_none() {
            shell_eprint!("unalias: {}: not found\n", arg);
            code = 1;
        }
    }
    BuiltinResult::Result(code)
}

// -- nice -----------------------------------------------------------------

/// `nice [-n N] command [args...]`
///
/// Runs a command with a modified scheduling priority.  With no arguments,
/// prints the current niceness (always 0 since priority is set at sandbox
/// creation time by the host).  With a command, spawns it via the host ABI
/// with the requested epoch quantum so the child runs at the right priority.
fn builtin_nice(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
) -> BuiltinResult {
    let args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    // Parse -n N / -nN / --adjustment=N
    let mut nice: u8 = 0;
    let mut i = 0;
    while i < args.len() {
        if (args[i] == "-n" || args[i] == "--adjustment") && i + 1 < args.len() {
            nice = args[i + 1].parse::<i32>().unwrap_or(0).clamp(0, 19) as u8;
            i += 2;
        } else if let Some(val) = args[i].strip_prefix("-n") {
            if !val.is_empty() {
                nice = val.parse::<i32>().unwrap_or(0).clamp(0, 19) as u8;
                i += 1;
            } else {
                break;
            }
        } else if let Some(val) = args[i].strip_prefix("--adjustment=") {
            nice = val.parse::<i32>().unwrap_or(0).clamp(0, 19) as u8;
            i += 1;
        } else {
            break;
        }
    }

    if i >= args.len() {
        shell_println!("0");
        return BuiltinResult::Result(0);
    }

    let prog = args[i];
    let spawn_args: Vec<&str> = args[i + 1..].to_vec();
    let env_pairs: Vec<(&str, &str)> = state
        .env
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    match host.spawn(
        prog,
        None,
        &spawn_args,
        &env_pairs,
        &state.cwd,
        "",
        state.stdin_fd,
        state.stdout_fd,
        2,
        nice,
    ) {
        Ok(pid) => match host.waitpid(pid) {
            Ok(result) => BuiltinResult::Result(result.exit_code),
            Err(_) => BuiltinResult::Result(1),
        },
        Err(e) => {
            shell_eprintln!("nice: {prog}: {e}");
            BuiltinResult::Result(127)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::mock::MockHost;

    fn make_args(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    /// Run a builtin and return just the exit code.
    fn run_builtin(
        state: &mut ShellState,
        host: &dyn HostInterface,
        cmd: &str,
        args: &[&str],
    ) -> i32 {
        let _lock = crate::test_support::mock::FD_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let a = make_args(args);
        match try_builtin(state, host, cmd, &a, "", None).expect("expected builtin") {
            BuiltinResult::Result(c) | BuiltinResult::Exit(c) | BuiltinResult::Return(c) => c,
        }
    }

    fn run_builtin_stdin(
        state: &mut ShellState,
        host: &dyn HostInterface,
        cmd: &str,
        args: &[&str],
        stdin: &str,
    ) -> i32 {
        let _lock = crate::test_support::mock::FD_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let a = make_args(args);

        // Write stdin data to a pipe and dup2 onto fd 0, matching
        // production flow where input redirects go through fd 0.
        let saved_fd0 = if !stdin.is_empty() {
            let (r, w) = host.pipe().expect("pipe failed");
            unsafe {
                libc::write(
                    w as libc::c_int,
                    stdin.as_ptr() as *const libc::c_void,
                    stdin.len(),
                );
            }
            host.close_fd(w).ok();
            let saved = host.dup(0).ok();
            host.dup2(r, 0).ok();
            host.close_fd(r).ok();
            saved
        } else {
            None
        };

        let result = match try_builtin(state, host, cmd, &a, "", None).expect("expected builtin") {
            BuiltinResult::Result(c) | BuiltinResult::Exit(c) | BuiltinResult::Return(c) => c,
        };

        // Restore fd 0.
        if let Some(fd) = saved_fd0 {
            host.dup2(fd, 0).ok();
            host.close_fd(fd).ok();
        }
        result
    }

    /// Capture stdout via real OS pipes. Uses dup2 to redirect fd 1
    /// to a pipe, runs the builtin, then reads the pipe.
    fn run_capture(
        state: &mut ShellState,
        host: &MockHost,
        cmd: &str,
        args: &[&str],
    ) -> (i32, String, String) {
        run_capture_stdin(state, host, cmd, args, "")
    }

    fn run_capture_stdin(
        state: &mut ShellState,
        host: &MockHost,
        cmd: &str,
        args: &[&str],
        stdin: &str,
    ) -> (i32, String, String) {
        use std::io::Write;
        let _lock = crate::test_support::mock::FD_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let (out_r, out_w) = host.pipe().unwrap();
        let saved_stdout = state.stdout_fd;
        state.stdout_fd = out_w;

        let a = make_args(args);
        let result = try_builtin(state, host, cmd, &a, stdin, None);

        std::io::stdout().flush().ok();

        state.stdout_fd = saved_stdout;
        host.close_fd(out_w).unwrap();

        let stdout = String::from_utf8_lossy(&host.read_fd(out_r).unwrap()).to_string();
        host.close_fd(out_r).unwrap();

        let exit_code = match result {
            Some(BuiltinResult::Result(c))
            | Some(BuiltinResult::Exit(c))
            | Some(BuiltinResult::Return(c)) => c,
            None => 127,
        };
        (exit_code, stdout, String::new())
    }

    // -- echo tests -------------------------------------------------------

    #[test]
    fn echo_basic_fd_capture() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "echo", &["hello", "world"]);
        assert_eq!(stdout, "hello world\n");
        assert_eq!(code, 0);
    }

    #[test]
    fn echo_basic() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "echo", &["hello", "world"]);
        assert_eq!(stdout, "hello world\n");
        assert_eq!(code, 0);
    }

    #[test]
    fn echo_no_newline() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-n", "hi"]);
        assert_eq!(stdout, "hi");
    }

    #[test]
    fn echo_escape_n() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-e", "a\\nb"]);
        assert_eq!(stdout, "a\nb\n");
    }

    #[test]
    fn echo_escape_t() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-e", "a\\tb"]);
        assert_eq!(stdout, "a\tb\n");
    }

    #[test]
    fn echo_combined_flags_ne() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-ne", "a\\nb"]);
        assert_eq!(stdout, "a\nb");
    }

    #[test]
    fn echo_escape_backslash_c() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-e", "abc\\cdef"]);
        assert_eq!(stdout, "abc");
    }

    #[test]
    fn echo_escape_octal() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-e", "\\0101"]);
        assert_eq!(stdout, "A\n"); // 0101 octal = 65 = 'A'
    }

    #[test]
    fn echo_escape_hex() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &["-e", "\\x41"]);
        assert_eq!(stdout, "A\n"); // 0x41 = 65 = 'A'
    }

    #[test]
    fn echo_no_args() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "echo", &[]);
        assert_eq!(stdout, "\n");
    }

    // -- true / false tests -----------------------------------------------

    #[test]
    fn true_builtin() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "true", &[]);
        assert_eq!(code, 0);
    }

    #[test]
    fn false_builtin() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "false", &[]);
        assert_eq!(code, 1);
    }

    // -- pwd tests --------------------------------------------------------

    #[test]
    fn pwd_prints_cwd() {
        let mut state = ShellState::new_default();
        state.cwd = "/tmp/mydir".to_string();
        state.env.insert("PWD".into(), "/tmp/mydir".into());
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "pwd", &[]);
        assert_eq!(stdout, "/tmp/mydir\n");
    }

    // -- cd tests ---------------------------------------------------------

    #[test]
    fn cd_basic() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_dir("/tmp");
        let code = run_builtin(&mut state, &host, "cd", &["/tmp"]);
        assert_eq!(code, 0);
        assert_eq!(state.cwd, "/tmp");
    }

    #[test]
    fn cd_no_args_goes_home() {
        let mut state = ShellState::new_default();
        state.cwd = "/tmp".to_string();
        let host = MockHost::new().with_dir("/home/user");
        let code = run_builtin(&mut state, &host, "cd", &[]);
        assert_eq!(code, 0);
        assert_eq!(state.cwd, "/home/user");
    }

    #[test]
    fn cd_dash_returns_to_oldpwd() {
        let mut state = ShellState::new_default();
        state.cwd = "/tmp".to_string();
        state
            .env
            .insert("OLDPWD".to_string(), "/home/user".to_string());
        let host = MockHost::new().with_dir("/home/user");
        let code = run_builtin(&mut state, &host, "cd", &["-"]);
        assert_eq!(code, 0);
        assert_eq!(state.cwd, "/home/user");
        assert_eq!(state.env.get("OLDPWD").unwrap(), "/tmp");
    }

    #[test]
    fn cd_normalize_dotdot() {
        let mut state = ShellState::new_default();
        state.cwd = "/home/user/projects".to_string();
        let host = MockHost::new().with_dir("/home/user");
        let code = run_builtin(&mut state, &host, "cd", &[".."]);
        assert_eq!(code, 0);
        assert_eq!(state.cwd, "/home/user");
    }

    #[test]
    fn cd_nonexistent() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "cd", &["/nonexistent"]);
        assert_eq!(code, 1);
    }

    // -- exit tests -------------------------------------------------------

    #[test]
    fn exit_with_code() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let a = make_args(&["42"]);
        let result = try_builtin(&mut state, &host, "exit", &a, "", None).unwrap();
        match result {
            BuiltinResult::Exit(code) => assert_eq!(code, 42),
            _ => panic!("expected Exit"),
        }
    }

    #[test]
    fn exit_uses_last_exit_code() {
        let mut state = ShellState::new_default();
        state.last_exit_code = 7;
        let host = MockHost::new();
        let a: Vec<String> = vec![];
        let result = try_builtin(&mut state, &host, "exit", &a, "", None).unwrap();
        match result {
            BuiltinResult::Exit(code) => assert_eq!(code, 7),
            _ => panic!("expected Exit"),
        }
    }

    // -- export tests -----------------------------------------------------

    #[test]
    fn export_set_var() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "export", &["FOO=bar"]);
        assert_eq!(code, 0);
        assert_eq!(state.env.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn export_print_vars() {
        let mut state = ShellState::new_default();
        state.env.clear();
        state.env.insert("A".to_string(), "1".to_string());
        state.env.insert("B".to_string(), "2".to_string());
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "export", &["-p"]);
        assert!(stdout.contains("declare -x A=\"1\""));
        assert!(stdout.contains("declare -x B=\"2\""));
    }

    // -- unset tests ------------------------------------------------------

    #[test]
    fn unset_removes_var() {
        let mut state = ShellState::new_default();
        state.env.insert("FOO".to_string(), "bar".to_string());
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "unset", &["FOO"]);
        assert_eq!(code, 0);
        assert!(!state.env.contains_key("FOO"));
    }

    #[test]
    fn unset_array_element() {
        let mut state = ShellState::new_default();
        state
            .arrays
            .insert("arr".to_string(), vec!["a".into(), "b".into(), "c".into()]);
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "unset", &["arr[1]"]);
        assert_eq!(code, 0);
        assert_eq!(state.arrays["arr"][1], "");
    }

    // -- set tests --------------------------------------------------------

    #[test]
    fn set_errexit_flag() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin(&mut state, &host, "set", &["-e"]);
        assert!(state.flags.contains(&ShellFlag::Errexit));
        run_builtin(&mut state, &host, "set", &["+e"]);
        assert!(!state.flags.contains(&ShellFlag::Errexit));
    }

    #[test]
    fn set_nounset_flag() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin(&mut state, &host, "set", &["-u"]);
        assert!(state.flags.contains(&ShellFlag::Nounset));
    }

    #[test]
    fn set_pipefail() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin(&mut state, &host, "set", &["-o", "pipefail"]);
        assert!(state.flags.contains(&ShellFlag::Pipefail));
        run_builtin(&mut state, &host, "set", &["+o", "pipefail"]);
        assert!(!state.flags.contains(&ShellFlag::Pipefail));
    }

    #[test]
    fn set_positional_params() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin(&mut state, &host, "set", &["--", "a", "b", "c"]);
        assert_eq!(state.positional_args, vec!["a", "b", "c"]);
    }

    // -- local tests ------------------------------------------------------

    #[test]
    fn local_in_function_scope() {
        let mut state = ShellState::new_default();
        state.env.insert("X".to_string(), "global".to_string());
        // Simulate being inside a function
        state.local_var_stack.push(HashMap::new());
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "local", &["X=local_val"]);
        assert_eq!(code, 0);
        assert_eq!(state.env.get("X").unwrap(), "local_val");
        // The local frame should have saved the old value
        let frame = state.local_var_stack.last().unwrap();
        assert_eq!(frame.get("X"), Some(&Some("global".to_string())));
    }

    #[test]
    fn local_outside_function_fails() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "local", &["X=val"]);
        assert_eq!(code, 1);
    }

    // -- declare tests ----------------------------------------------------

    #[test]
    fn declare_array() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "declare", &["-a", "arr=(one two three)"]);
        assert_eq!(code, 0);
        assert_eq!(
            state.arrays.get("arr").unwrap(),
            &vec!["one".to_string(), "two".to_string(), "three".to_string()]
        );
    }

    #[test]
    fn declare_assoc_array() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(
            &mut state,
            &host,
            "declare",
            &["-A", "map=([foo]=bar [baz]=qux)"],
        );
        assert_eq!(code, 0);
        let m = state.assoc_arrays.get("map").unwrap();
        assert_eq!(m.get("foo").unwrap(), "bar");
        assert_eq!(m.get("baz").unwrap(), "qux");
    }

    #[test]
    fn declare_print() {
        let mut state = ShellState::new_default();
        state.env.clear();
        state.env.insert("X".to_string(), "42".to_string());
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "declare", &["-p", "X"]);
        assert!(stdout.contains("declare -- X=\"42\""));
    }

    // -- test / [ tests ---------------------------------------------------

    #[test]
    fn test_z_empty() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "test", &["-z", ""]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_z_nonempty() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "test", &["-z", "hello"]);
        assert_eq!(code, 1);
    }

    #[test]
    fn test_n_nonempty() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "test", &["-n", "hello"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_f_file_exists() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_file("/tmp/file.txt", b"data");
        let code = run_builtin(&mut state, &host, "test", &["-f", "/tmp/file.txt"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_f_file_not_exists() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "test", &["-f", "/tmp/nope"]);
        assert_eq!(code, 1);
    }

    #[test]
    fn test_d_directory() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_dir("/tmp/dir");
        let code = run_builtin(&mut state, &host, "test", &["-d", "/tmp/dir"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_e_exists() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_file("/tmp/x", b"");
        let code = run_builtin(&mut state, &host, "test", &["-e", "/tmp/x"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_string_equality() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "test", &["abc", "=", "abc"]);
        assert_eq!(code, 0);

        let code = run_builtin(&mut state, &host, "test", &["abc", "!=", "def"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_numeric_comparisons() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();

        let code = run_builtin(&mut state, &host, "test", &["5", "-eq", "5"]);
        assert_eq!(code, 0);

        let code = run_builtin(&mut state, &host, "test", &["3", "-lt", "5"]);
        assert_eq!(code, 0);

        let code = run_builtin(&mut state, &host, "test", &["5", "-gt", "3"]);
        assert_eq!(code, 0);

        let code = run_builtin(&mut state, &host, "test", &["5", "-ge", "5"]);
        assert_eq!(code, 0);

        let code = run_builtin(&mut state, &host, "test", &["5", "-le", "5"]);
        assert_eq!(code, 0);

        let code = run_builtin(&mut state, &host, "test", &["5", "-ne", "3"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn test_negation() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "test", &["!", "-z", "hello"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn bracket_test_with_closing() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "[", &["abc", "=", "abc", "]"]);
        assert_eq!(code, 0);
    }

    // -- read tests -------------------------------------------------------

    #[test]
    fn read_basic() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin_stdin(&mut state, &host, "read", &["VAR"], "hello world\n");
        assert_eq!(code, 0);
        assert_eq!(state.env.get("VAR").unwrap(), "hello world");
    }

    #[test]
    fn read_default_reply() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin_stdin(&mut state, &host, "read", &[], "test data\n");
        assert_eq!(state.env.get("REPLY").unwrap(), "test data");
    }

    #[test]
    fn read_raw_mode() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin_stdin(&mut state, &host, "read", &["-r", "VAR"], "hello\\nworld\n");
        assert_eq!(state.env.get("VAR").unwrap(), "hello\\nworld");
    }

    #[test]
    fn read_array_mode() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin_stdin(&mut state, &host, "read", &["-a", "arr"], "one two three\n");
        assert_eq!(
            state.arrays.get("arr").unwrap(),
            &vec!["one".to_string(), "two".to_string(), "three".to_string()]
        );
    }

    #[test]
    fn read_custom_delimiter() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin_stdin(
            &mut state,
            &host,
            "read",
            &["-d", ",", "VAR"],
            "hello,world",
        );
        assert_eq!(state.env.get("VAR").unwrap(), "hello");
    }

    // -- shift tests ------------------------------------------------------

    #[test]
    fn shift_positional_params() {
        let mut state = ShellState::new_default();
        state.positional_args = vec!["a".into(), "b".into(), "c".into()];
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "shift", &[]);
        assert_eq!(code, 0);
        assert_eq!(state.positional_args, vec!["b", "c"]);
    }

    #[test]
    fn shift_by_n() {
        let mut state = ShellState::new_default();
        state.positional_args = vec!["a".into(), "b".into(), "c".into()];
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "shift", &["2"]);
        assert_eq!(code, 0);
        assert_eq!(state.positional_args, vec!["c"]);
    }

    #[test]
    fn shift_out_of_range() {
        let mut state = ShellState::new_default();
        state.positional_args = vec!["a".into()];
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "shift", &["5"]);
        assert_eq!(code, 1);
    }

    // -- type tests -------------------------------------------------------

    #[test]
    fn type_builtin_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "type", &["echo"]);
        assert_eq!(code, 0);
        assert!(stdout.contains("shell builtin"));
    }

    #[test]
    fn type_function_found() {
        let mut state = ShellState::new_default();
        state.functions.insert(
            "myfunc".to_string(),
            yurt_shell::ast::Command::Simple {
                words: vec![],
                redirects: vec![],
                assignments: vec![],
            },
        );
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "type", &["myfunc"]);
        assert_eq!(code, 0);
        assert!(stdout.contains("function"));
    }

    #[test]
    fn type_tool_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_tool("git");
        let (code, stdout, _) = run_capture(&mut state, &host, "type", &["git"]);
        assert_eq!(code, 0);
        assert!(stdout.contains("/bin/git"));
    }

    #[test]
    fn type_not_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        // TODO: check stderr once stderr capture is implemented
        let code = run_builtin(&mut state, &host, "type", &["nonexistent"]);
        assert_eq!(code, 1);
    }

    // -- let tests --------------------------------------------------------

    #[test]
    fn let_arithmetic() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "let", &["x=5+3"]);
        assert_eq!(code, 0); // 8 != 0 -> exit code 0
        assert_eq!(state.env.get("x").unwrap(), "8");
    }

    #[test]
    fn let_zero_result() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "let", &["x=0"]);
        assert_eq!(code, 1); // 0 -> exit code 1
    }

    // -- eval tests -------------------------------------------------------

    #[test]
    fn eval_executes_string() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let run_fn = |_state: &mut ShellState, cmd: &str| -> RunResult {
            if cmd.contains("echo") {
                RunResult::empty()
            } else {
                RunResult::empty()
            }
        };
        let _lock = crate::test_support::mock::FD_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let a = make_args(&["echo", "hello"]);
        let result = try_builtin(&mut state, &host, "eval", &a, "", Some(&run_fn)).unwrap();
        assert!(matches!(result, BuiltinResult::Result(0)));
    }

    // -- source tests -----------------------------------------------------

    #[test]
    fn source_executes_file() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_file("/tmp/script.sh", b"echo sourced");
        let run_fn = |_state: &mut ShellState, cmd: &str| -> RunResult {
            if cmd.contains("echo") {
                RunResult::empty()
            } else {
                RunResult::empty()
            }
        };
        let _lock = crate::test_support::mock::FD_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let a = make_args(&["/tmp/script.sh"]);
        let result = try_builtin(&mut state, &host, "source", &a, "", Some(&run_fn)).unwrap();
        assert!(matches!(result, BuiltinResult::Result(0)));
    }

    #[test]
    fn source_strips_shebang() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_file("/tmp/script.sh", b"#!/bin/bash\necho sourced");
        let run_fn = |_state: &mut ShellState, cmd: &str| -> RunResult {
            // Should NOT contain shebang
            assert!(!cmd.contains("#!"));
            RunResult::empty()
        };
        let a = make_args(&["/tmp/script.sh"]);
        let _lock = crate::test_support::mock::FD_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let result = try_builtin(&mut state, &host, "source", &a, "", Some(&run_fn)).unwrap();
        assert!(matches!(result, BuiltinResult::Result(0)));
    }

    #[test]
    fn source_sets_bash_source() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_file("/tmp/s.sh", b"echo ok");
        let run_fn = |state: &mut ShellState, _cmd: &str| -> RunResult {
            assert_eq!(state.env.get("BASH_SOURCE").unwrap(), "/tmp/s.sh");
            RunResult::empty()
        };
        let a = make_args(&["/tmp/s.sh"]);
        try_builtin(&mut state, &host, "source", &a, "", Some(&run_fn));
        // After source completes, BASH_SOURCE should be restored
        assert!(!state.env.contains_key("BASH_SOURCE"));
    }

    // -- history tests ----------------------------------------------------

    #[test]
    fn history_list() {
        let mut state = ShellState::new_default();
        state.history.push("ls".into());
        state.history.push("pwd".into());
        let host = MockHost::new();
        let (_, stdout, _) = run_capture(&mut state, &host, "history", &[]);
        assert!(stdout.contains("ls"));
        assert!(stdout.contains("pwd"));
    }

    #[test]
    fn history_clear() {
        let mut state = ShellState::new_default();
        state.history.push("ls".into());
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "history", &["clear"]);
        assert_eq!(code, 0);
        assert!(state.history.is_empty());
    }

    // -- trap tests -------------------------------------------------------

    #[test]
    fn trap_set_and_clear() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();

        // Set trap
        run_builtin(&mut state, &host, "trap", &["echo bye", "EXIT"]);
        assert_eq!(state.traps.get("EXIT").unwrap(), "echo bye");

        // Clear trap
        run_builtin(&mut state, &host, "trap", &["", "EXIT"]);
        assert!(!state.traps.contains_key("EXIT"));
    }

    // -- getopts tests ----------------------------------------------------

    #[test]
    fn getopts_basic() {
        let mut state = ShellState::new_default();
        state.env.insert("OPTIND".to_string(), "1".to_string());
        let host = MockHost::new();

        let code = run_builtin(&mut state, &host, "getopts", &["ab:c", "opt", "-a"]);
        assert_eq!(code, 0);
        assert_eq!(state.env.get("opt").unwrap(), "a");
    }

    #[test]
    fn getopts_with_arg() {
        let mut state = ShellState::new_default();
        state.env.insert("OPTIND".to_string(), "1".to_string());
        let host = MockHost::new();

        let code = run_builtin(&mut state, &host, "getopts", &["ab:c", "opt", "-b", "val"]);
        assert_eq!(code, 0);
        assert_eq!(state.env.get("opt").unwrap(), "b");
        assert_eq!(state.env.get("OPTARG").unwrap(), "val");
    }

    // -- mapfile tests ----------------------------------------------------

    #[test]
    fn mapfile_basic() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin_stdin(
            &mut state,
            &host,
            "mapfile",
            &["-t", "lines"],
            "line1\nline2\nline3\n",
        );
        assert_eq!(code, 0);
        assert_eq!(
            state.arrays.get("lines").unwrap(),
            &vec![
                "line1".to_string(),
                "line2".to_string(),
                "line3".to_string()
            ]
        );
    }

    #[test]
    fn mapfile_max_lines() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        run_builtin_stdin(
            &mut state,
            &host,
            "mapfile",
            &["-t", "-n", "2", "lines"],
            "a\nb\nc\nd\n",
        );
        assert_eq!(state.arrays.get("lines").unwrap().len(), 2);
    }

    // -- which tests ------------------------------------------------------

    #[test]
    fn which_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_tool("git");
        let (code, stdout, _) = run_capture(&mut state, &host, "which", &["git"]);
        assert_eq!(code, 0);
        assert_eq!(stdout, "/bin/git\n");
    }

    #[test]
    fn which_not_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "which", &["nonexistent"]);
        assert_eq!(code, 1);
    }

    #[test]
    fn which_prefers_bin_over_usr_bin() {
        let mut state = ShellState::new_default();
        let host = MockHost::new()
            .with_file("/bin/cat", b"")
            .with_file("/usr/bin/cat", b"");
        let (code, stdout, _) = run_capture(&mut state, &host, "which", &["cat"]);
        assert_eq!(code, 0);
        assert_eq!(stdout, "/bin/cat\n");
    }

    // -- return tests -----------------------------------------------------

    #[test]
    fn return_with_code() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let a = make_args(&["42"]);
        match try_builtin(&mut state, &host, "return", &a, "", None).unwrap() {
            BuiltinResult::Return(code) => assert_eq!(code, 42),
            _ => panic!("expected Return"),
        }
    }

    // -- normalize_path tests ---------------------------------------------

    #[test]
    fn normalize_path_basic() {
        assert_eq!(normalize_path("/home/user/.."), "/home");
        assert_eq!(normalize_path("/home/./user"), "/home/user");
        assert_eq!(normalize_path("/a/b/c/../../d"), "/a/d");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(normalize_path("/home/user/"), "/home/user");
    }

    // -- command tests ----------------------------------------------------

    #[test]
    fn command_v_builtin() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "command", &["-v", "echo"]);
        assert_eq!(code, 0);
        assert_eq!(stdout, "echo\n");
    }

    #[test]
    fn command_v_tool() {
        let mut state = ShellState::new_default();
        let host = MockHost::new().with_tool("git");
        let code = run_builtin(&mut state, &host, "command", &["-v", "git"]);
        assert_eq!(code, 0);
    }

    #[test]
    fn command_without_v_falls_through() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let a = make_args(&["ls"]);
        let result = try_builtin(&mut state, &host, "command", &a, "", None);
        assert!(result.is_none());
    }

    // -- printf tests -----------------------------------------------------

    #[test]
    fn printf_v_assigns_var() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(
            &mut state,
            &host,
            "printf",
            &["-v", "result", "hello %s", "world"],
        );
        assert_eq!(code, 0);
        assert_eq!(state.env.get("result").unwrap(), "hello world");
    }

    #[test]
    fn printf_without_v_writes_stdout() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "printf", &["hello %s", "world"]);
        assert_eq!(stdout, "hello world");
        assert_eq!(code, 0);
    }

    // -- date tests -------------------------------------------------------

    #[test]
    fn date_unix_timestamp() {
        let mut state = ShellState::new_default();
        // MockHost time() returns 1700000000.0
        let host = MockHost::new();
        let (code, stdout, _) = run_capture(&mut state, &host, "date", &["+%s"]);
        assert_eq!(stdout, "1700000000\n");
        assert_eq!(code, 0);
    }

    // -- chmod tests ------------------------------------------------------

    #[test]
    fn chmod_basic() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "chmod", &["755", "/tmp/script.sh"]);
        assert_eq!(code, 0);
    }

    // -- exec tests -------------------------------------------------------

    #[test]
    fn exec_no_args_noop() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "exec", &[]);
        assert_eq!(code, 0);
    }

    #[test]
    fn exec_with_args_handles_command() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        // exec is a real builtin — it dispatches the command internally.
        // With no run callback and no spawn result, it returns 127.
        let code = run_builtin(&mut state, &host, "exec", &["ls"]);
        assert_eq!(code, 127);
    }

    // -- non-builtin falls through ----------------------------------------

    #[test]
    fn non_builtin_returns_none() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let a: Vec<String> = vec![];
        let result = try_builtin(&mut state, &host, "somecmd", &a, "", None);
        assert!(result.is_none());
    }

    #[test]
    fn curl_falls_through() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let a = make_args(&["http://example.com"]);
        let result = try_builtin(&mut state, &host, "curl", &a, "", None);
        assert!(result.is_none());
    }

    // -- colon builtin ----------------------------------------------------

    #[test]
    fn colon_is_noop() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, ":", &[]);
        assert_eq!(code, 0);
    }

    // -- readonly tests ---------------------------------------------------

    #[test]
    fn readonly_sets_var() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "readonly", &["X=42"]);
        assert_eq!(code, 0);
        assert_eq!(state.env.get("X").unwrap(), "42");
    }

    // -- alias tests ------------------------------------------------------

    #[test]
    fn alias_no_args_lists_all() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        state.aliases.insert("ll".to_string(), "ls -la".to_string());
        state
            .aliases
            .insert("gs".to_string(), "git status".to_string());
        let (code, stdout, _) = run_capture(&mut state, &host, "alias", &[]);
        assert_eq!(code, 0);
        // Should be sorted
        assert_eq!(stdout, "alias gs='git status'\nalias ll='ls -la'\n");
    }

    #[test]
    fn alias_define_single() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "alias", &["ll=ls -la"]);
        assert_eq!(code, 0);
        assert_eq!(state.aliases.get("ll").unwrap(), "ls -la");
    }

    #[test]
    fn alias_define_multiple() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "alias", &["ll=ls -la", "gs=git status"]);
        assert_eq!(code, 0);
        assert_eq!(state.aliases.get("ll").unwrap(), "ls -la");
        assert_eq!(state.aliases.get("gs").unwrap(), "git status");
    }

    #[test]
    fn alias_print_single() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        state.aliases.insert("ll".to_string(), "ls -la".to_string());
        let (code, stdout, _) = run_capture(&mut state, &host, "alias", &["ll"]);
        assert_eq!(code, 0);
        assert_eq!(stdout, "alias ll='ls -la'\n");
    }

    #[test]
    fn alias_print_not_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "alias", &["nope"]);
        assert_eq!(code, 1);
    }

    #[test]
    fn unalias_removes() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        state.aliases.insert("ll".to_string(), "ls -la".to_string());
        let code = run_builtin(&mut state, &host, "unalias", &["ll"]);
        assert_eq!(code, 0);
        assert!(state.aliases.get("ll").is_none());
    }

    #[test]
    fn unalias_dash_a_removes_all() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        state.aliases.insert("ll".to_string(), "ls -la".to_string());
        state
            .aliases
            .insert("gs".to_string(), "git status".to_string());
        let code = run_builtin(&mut state, &host, "unalias", &["-a"]);
        assert_eq!(code, 0);
        assert!(state.aliases.is_empty());
    }

    #[test]
    fn unalias_not_found() {
        let mut state = ShellState::new_default();
        let host = MockHost::new();
        let code = run_builtin(&mut state, &host, "unalias", &["nope"]);
        assert_eq!(code, 1);
    }
}
