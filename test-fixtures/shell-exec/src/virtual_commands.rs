//! Virtual commands — cat, curl, wget.
//!
//! Command logic runs entirely in the sandbox (Rust). Only I/O crosses to the
//! host via `HostInterface::fetch` / `register_tool`.

use crate::control::RunResult;
use crate::host::{HostInterface, WriteMode};
use crate::state::ShellState;
use crate::{shell_eprint, shell_print};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub const VIRTUAL_COMMANDS: &[&str] = &["cat", "curl", "wget"];

pub fn is_virtual_command(name: &str) -> bool {
    VIRTUAL_COMMANDS.contains(&name)
}

pub fn try_virtual_command(
    state: &mut ShellState,
    host: &dyn HostInterface,
    cmd: &str,
    args: &[String],
    stdin: &str,
) -> Option<RunResult> {
    // Virtual commands write via shell_print! → fd 1.  When stdout_fd
    // differs from 1 (pipeline pipe, redirect, command substitution),
    // dup2 stdout_fd onto fd 1 so the output reaches the right target.
    let do_dup2 = state.stdout_fd != 1;
    let saved_fd1 = if do_dup2 { host.dup(1).ok() } else { None };
    if do_dup2 {
        if let Err(err) = host.dup2(state.stdout_fd, 1) {
            if let Some(fd) = saved_fd1 {
                let _ = host.dup2(fd, 1);
                let _ = host.close_fd(fd);
            }
            shell_eprint!("{}: failed to redirect stdout: {err}\n", cmd);
            return Some(RunResult::exit(1));
        }
    }

    let result = match cmd {
        "cat" => Some(cmd_cat(state, host, args, stdin)),
        "curl" => Some(cmd_curl(state, host, args, stdin)),
        "wget" => Some(cmd_wget(state, host, args)),
        _ => None,
    };

    if let Some(fd) = saved_fd1 {
        if let Err(err) = host.dup2(fd, 1) {
            let _ = host.close_fd(fd);
            shell_eprint!("{}: failed to restore stdout: {err}\n", cmd);
            return Some(RunResult::exit(1));
        }
        let _ = host.close_fd(fd);
    }

    result
}

fn cmd_cat(
    state: &ShellState,
    host: &dyn HostInterface,
    args: &[String],
    stdin: &str,
) -> RunResult {
    if args.is_empty() {
        shell_print!("{}", stdin);
        return RunResult::empty();
    }

    for arg in args {
        if arg == "-" {
            shell_print!("{}", stdin);
            continue;
        }
        let resolved = state.resolve_path(arg);
        match host.read_file_str(&resolved) {
            Ok(contents) => shell_print!("{}", contents),
            Err(err) => {
                shell_eprint!("cat: {arg}: {err}\n");
                return RunResult::exit(1);
            }
        }
    }
    RunResult::empty()
}

// ---------------------------------------------------------------------------
// curl
// ---------------------------------------------------------------------------

fn cmd_curl(
    state: &mut ShellState,
    host: &dyn HostInterface,
    args: &[String],
    stdin: &str,
) -> RunResult {
    let mut method = None::<String>;
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut data = None::<String>;
    let mut output_file = None::<String>;
    let mut silent = false;
    let mut head_only = false;
    let mut follow_redirects = false;
    let mut url = None::<String>;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-X" => {
                i += 1;
                if i < args.len() {
                    method = Some(args[i].clone());
                }
            }
            "-H" => {
                i += 1;
                if i < args.len() {
                    if let Some(colon) = args[i].find(':') {
                        let name = args[i][..colon].trim().to_string();
                        let value = args[i][colon + 1..].trim().to_string();
                        headers.push((name, value));
                    }
                }
            }
            "-d" | "--data" => {
                i += 1;
                if i < args.len() {
                    data = Some(args[i].clone());
                }
            }
            "-o" => {
                i += 1;
                if i < args.len() {
                    output_file = Some(args[i].clone());
                }
            }
            "-s" | "--silent" => silent = true,
            "-I" | "--head" => head_only = true,
            "-L" | "--location" => follow_redirects = true,
            "-sS" | "-Ss" => silent = true,
            _ => {
                if !arg.starts_with('-') {
                    url = Some(arg.clone());
                }
            }
        }
        i += 1;
    }

    let url = match url {
        Some(u) => {
            if !u.contains("://") {
                format!("https://{u}")
            } else {
                u
            }
        }
        None => {
            shell_eprint!("{}", "curl: no URL specified\n");
            return RunResult::exit(1);
        }
    };

    // Check for network configuration
    let has_network = state.env.contains_key("YURT_NETWORK");
    if !has_network {
        // We still try the fetch — the host will return an error if no network
        // bridge is configured. This lets the error message come from the host.
    }

    // Determine method
    let method = method.unwrap_or_else(|| {
        if data.is_some() {
            "POST".to_string()
        } else {
            "GET".to_string()
        }
    });

    // Auto-add Content-Type for -d
    if data.is_some()
        && !headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("content-type"))
    {
        headers.push((
            "Content-Type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        ));
    }

    // If data comes from stdin (- means read from stdin)
    let body = match data.as_deref() {
        Some("-") => Some(stdin),
        Some(d) => Some(d),
        None => None,
    };

    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let _ = follow_redirects; // follow-redirect is handled by the host fetch
    let _ = silent; // silence progress output (we don't output progress anyway)

    let result = host.fetch(&url, &method, &header_refs, body);

    if let Some(ref err) = result.error {
        shell_eprint!("curl: {err}\n");
        return RunResult::exit(1);
    }

    if head_only {
        let mut out = format!("HTTP/{} {}\r\n", result.status, status_text(result.status));
        for (name, value) in &result.headers {
            out.push_str(&format!("{}: {}\r\n", name, value));
        }
        out.push_str("\r\n");
        shell_print!("{}", out);
        return RunResult::empty();
    }

    if let Some(ref file) = output_file {
        let resolved = state.resolve_path(file);
        if let Err(e) = host.write_file(&resolved, result.body.as_bytes(), WriteMode::Truncate) {
            shell_eprint!("curl: failed to write {file}: {e}\n");
            return RunResult::exit(1);
        }
        return RunResult::empty();
    }

    shell_print!("{}", result.body);
    RunResult::empty()
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// wget
// ---------------------------------------------------------------------------

fn cmd_wget(state: &mut ShellState, host: &dyn HostInterface, args: &[String]) -> RunResult {
    let mut output_file = None::<String>;
    let mut quiet = false;
    let mut url = None::<String>;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-O" => {
                i += 1;
                if i < args.len() {
                    output_file = Some(args[i].clone());
                }
            }
            "-q" | "--quiet" => quiet = true,
            _ => {
                // Handle combined flags like -qO-
                if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
                    let chars: Vec<char> = arg[1..].chars().collect();
                    let mut j = 0;
                    while j < chars.len() {
                        match chars[j] {
                            'q' => quiet = true,
                            'O' => {
                                // Rest of this arg is the output file
                                let rest: String = chars[j + 1..].iter().collect();
                                if !rest.is_empty() {
                                    output_file = Some(rest);
                                } else {
                                    // Next arg is the output file
                                    i += 1;
                                    if i < args.len() {
                                        output_file = Some(args[i].clone());
                                    }
                                }
                                break;
                            }
                            _ => {}
                        }
                        j += 1;
                    }
                } else if !arg.starts_with('-') {
                    url = Some(arg.clone());
                }
            }
        }
        i += 1;
    }

    let url = match url {
        Some(u) => {
            // Auto-prepend https:// if no scheme (like real wget, but https for browser compat)
            if !u.contains("://") {
                format!("https://{u}")
            } else {
                u
            }
        }
        None => {
            shell_eprint!("{}", "wget: no URL specified\n");
            return RunResult::exit(1);
        }
    };

    let result = host.fetch(&url, "GET", &[], None);

    if let Some(ref err) = result.error {
        shell_eprint!("wget: {err}\n");
        return RunResult::exit(1);
    }

    // -O - means write to stdout
    if output_file.as_deref() == Some("-") {
        shell_print!("{}", result.body);
        return RunResult::empty();
    }

    // Determine output filename
    let filename = match output_file {
        Some(f) => f,
        None => {
            // Extract basename from URL
            let path = url.split('?').next().unwrap_or(&url);
            let basename = path.rsplit('/').next().unwrap_or("index.html");
            if basename.is_empty() {
                "index.html".to_string()
            } else {
                basename.to_string()
            }
        }
    };

    let resolved = state.resolve_path(&filename);
    if let Err(e) = host.write_file(&resolved, result.body.as_bytes(), WriteMode::Truncate) {
        shell_eprint!("wget: failed to write {filename}: {e}\n");
        return RunResult::exit(1);
    }

    if !quiet {
        shell_eprint!("saved to {filename}\n");
    }

    RunResult::empty()
}

#[cfg(test)]
mod tests {
    use super::try_virtual_command;
    use crate::host::FetchResult;
    use crate::state::ShellState;
    use crate::test_support::mock::MockHost;
    use std::collections::HashMap;

    #[test]
    fn virtual_command_reports_stdout_dup2_setup_failure() {
        let mut state = ShellState::new_default();
        state.stdout_fd = -1;
        let host = MockHost::new().with_fetch_result(
            "https://example.com",
            FetchResult {
                ok: true,
                status: 200,
                headers: HashMap::new(),
                body: "body".to_string(),
                body_base64: None,
                error: None,
            },
        );

        let result = try_virtual_command(
            &mut state,
            &host,
            "curl",
            &["https://example.com".to_string()],
            "",
        )
        .expect("curl should be handled as a virtual command");

        assert_eq!(result.exit_code, 1);
    }
}
