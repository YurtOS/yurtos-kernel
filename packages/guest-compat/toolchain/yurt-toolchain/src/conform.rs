use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::Command;

use crate::spec::{Case, Spec};
use crate::trace::{diff_case, parse_trace_line, Mismatch};

/// Canary name → every Tier 1 symbol that canary exports. Used by both
/// `run_signature_checks` (C side) and `run_rust_signature_checks` (Rust
/// side, added below) to cover every marker a canary's pre-opt wasm
/// must carry. Coverage across all four canaries is exhaustive of Tier 1.
pub fn canary_symbol_map() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("dup2-canary", &["dup2"]),
        ("pipe-canary", &["dup", "dup3", "pipe", "pipe2"]),
        ("getgroups-canary", &["getgroups"]),
        (
            "posix-runtime-canary",
            &["gethostname", "if_indextoname", "if_nametoindex", "sendfile"],
        ),
        (
            "socket-canary",
            &[
                "getaddrinfo",
                "freeaddrinfo",
                "getnameinfo",
                "gethostbyname",
                "gethostbyaddr",
            ],
        ),
        (
            "resource-canary",
            &[
                "chown",
                "chmod",
                "chroot",
                "fchdir",
                "fchown",
                "getpriority",
                "getrlimit",
                "getpgid",
                "getpgrp",
                "getsid",
                "lchown",
                "setpgid",
                "setpgrp",
                "setpriority",
                "setresgid",
                "setresuid",
                "setrlimit",
                "setsid",
                "tcgetpgrp",
                "tcsetpgrp",
                "umask",
            ],
        ),
        (
            "stdio-canary",
            &["flockfile", "ftrylockfile", "funlockfile", "qsort_r"],
        ),
        (
            "exec-canary",
            &["execv", "execve", "execvp", "fork", "vfork"],
        ),
        (
            "spawn-canary",
            &[
                "posix_spawn",
                "posix_spawnp",
                "posix_spawn_file_actions_init",
                "posix_spawnattr_init",
            ],
        ),
        ("spawn-wait-canary", &["wait", "waitpid"]),
        (
            "affinity-canary",
            &["sched_getaffinity", "sched_setaffinity", "sched_getcpu"],
        ),
        (
            "signal-canary",
            &[
                "signal",
                "sigaction",
                "raise",
                "alarm",
                "sigemptyset",
                "sigfillset",
                "sigaddset",
                "sigdelset",
                "sigismember",
                "sigprocmask",
                "sigsuspend",
            ],
        ),
        ("sleep-canary", &["tzset"]),
        (
            "system-canary",
            &["mkdtemp", "mkostemp", "mkstemp", "mktemp"],
        ),
        (
            "pthread-canary",
            &[
                "pthread_create",
                "pthread_join",
                "pthread_self",
                "pthread_detach",
                "pthread_exit",
                "pthread_mutex_lock",
                "pthread_mutex_unlock",
                "pthread_cond_wait",
                "pthread_cond_signal",
                "pthread_key_create",
                "pthread_setspecific",
                "pthread_getspecific",
                "pthread_once",
            ],
        ),
    ]
}

pub struct Driver {
    pub repo_root: PathBuf,
}

impl Driver {
    pub fn new(repo_root: PathBuf) -> Self {
        Self { repo_root }
    }

    fn target_bin(&self, name: &str) -> PathBuf {
        self.repo_root.join("target/release").join(name)
    }

    fn guest_compat(&self) -> PathBuf {
        self.repo_root.join("packages/guest-compat")
    }

    pub fn ensure_toolchain(&self) -> Result<()> {
        // `cargo build --release -p yurt-toolchain` builds every bin in the crate.
        let status = Command::new("cargo")
            .current_dir(&self.repo_root)
            .args(["build", "--release", "-p", "yurt-toolchain"])
            .status()
            .context("spawning cargo build -p yurt-toolchain")?;
        if !status.success() {
            return Err(anyhow!("cargo build -p yurt-toolchain failed"));
        }
        Ok(())
    }

    pub fn build_archive_and_canaries(&self) -> Result<()> {
        let status = Command::new("make")
            .current_dir(self.guest_compat())
            .args(["all", "copy-fixtures"])
            .status()
            .context("make -C packages/guest-compat all copy-fixtures")?;
        if !status.success() {
            return Err(anyhow!("make -C packages/guest-compat failed"));
        }
        Ok(())
    }

    pub fn run_signature_checks(&self) -> Result<()> {
        let yurt_check = self.target_bin("yurt-check");
        let archive = self.guest_compat().join("build/libyurt_guest_compat.a");
        let build_dir = self.guest_compat().join("build");
        let mut failed = Vec::new();
        for (canary, symbols) in canary_symbol_map() {
            let pre_opt = build_dir.join(format!("{canary}.pre-opt.wasm"));
            println!("== {canary} ({} symbols) ==", symbols.len());
            let mut cmd = Command::new(&yurt_check);
            cmd.arg("--archive").arg(&archive);
            cmd.arg("--pre-opt-wasm").arg(&pre_opt);
            for sym in *symbols {
                cmd.arg("--symbol").arg(*sym);
            }
            let status = cmd
                .status()
                .with_context(|| format!("running yurt-check on {canary}"))?;
            if !status.success() {
                failed.push(*canary);
            }
        }
        if !failed.is_empty() {
            return Err(anyhow!("signature check failed for: {}", failed.join(", ")));
        }
        Ok(())
    }

    pub fn run_behavioral_suite(&self) -> Result<()> {
        // Delegate to the kernel canary suite. This is the Step 1
        // behavioral harness; Step 3a replaces it with TOML-driven spec
        // tests.
        let status = Command::new("deno")
            .current_dir(&self.repo_root)
            .args([
                "test",
                "-A",
                "--no-check",
                "packages/kernel/src/__tests__/guest-compat.test.ts",
            ])
            .status()
            .context("spawning deno test")?;
        if !status.success() {
            return Err(anyhow!("kernel canary suite failed"));
        }
        Ok(())
    }
}

/// Result of running one case through one language's canary.
pub struct CaseResult {
    pub spec_symbol: String,
    pub case_name: String,
    pub language: &'static str,
    pub mismatches: Vec<Mismatch>,
    /// Raw stdout from the canary, surfaced when parsing fails.
    pub raw_stdout: String,
}

impl Driver {
    /// Run `<canary>.wasm --case <name>` via wasmtime and return the
    /// captured stdout + exit code. The canary's working directory is the
    /// guest-compat build/ dir so VFS paths resolve consistently.
    fn run_canary_case(&self, wasm: &std::path::Path, case_name: &str) -> Result<(String, i32)> {
        let out = Command::new("wasmtime")
            .arg("run")
            .arg(wasm)
            .arg("--")
            .arg("--case")
            .arg(case_name)
            .output()
            .with_context(|| format!("running wasmtime on {}", wasm.display()))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let code = out.status.code().unwrap_or(-1);
        Ok((stdout, code))
    }

    /// Diff one case's trace against its spec, for one language. Returns
    /// the result regardless of pass/fail; caller aggregates.
    pub fn run_one(
        &self,
        spec: &Spec,
        case: &Case,
        wasm: &std::path::Path,
        language: &'static str,
    ) -> Result<CaseResult> {
        let (raw_stdout, process_exit) = self.run_canary_case(wasm, &case.name)?;
        let trace_line = raw_stdout.lines().last().unwrap_or("").to_string();
        let mismatches = match parse_trace_line(&trace_line) {
            Ok(t) => diff_case(case, &t, process_exit),
            Err(_) => vec![Mismatch::CaseName {
                expected: case.name.clone(),
                actual: format!("<unparseable: {trace_line}>"),
            }],
        };
        Ok(CaseResult {
            spec_symbol: spec.symbol.clone(),
            case_name: case.name.clone(),
            language,
            mismatches,
            raw_stdout,
        })
    }

    /// Run every case in every spec under `conformance/` against the C and
    /// (optionally) Rust canaries. Returns a flat Vec of results; caller
    /// summarizes.
    ///
    /// When `include_rust` is true, missing Rust canary artifacts are a
    /// HARD FAILURE. Soft-skipping would let a broken `make rust-canaries`
    /// target or a missed copy-step produce a green `yurt-conf --include-rust`
    /// that silently verified nothing on the Rust side — the opposite of
    /// what a "Rust parity" CI gate is for.
    pub fn run_spec_traces(&self, include_rust: bool) -> Result<Vec<CaseResult>> {
        let conformance = self.guest_compat().join("conformance");
        let specs = Spec::load_dir(&conformance)?;
        let build = self.guest_compat().join("build");
        let mut results = Vec::new();
        for spec in &specs {
            let c_wasm = build.join(format!("{}.wasm", spec.canary));
            if !c_wasm.exists() {
                return Err(anyhow!(
                    "missing C canary wasm {} (spec {}). Ensure `make canaries` ran.",
                    c_wasm.display(),
                    spec.symbol
                ));
            }
            let rust_wasm = build.join("rust").join(format!("{}.wasm", spec.canary));
            if include_rust && !rust_wasm.exists() {
                return Err(anyhow!(
                    "--include-rust but missing Rust canary wasm {} (spec {}). \
                     Ensure `make rust-canaries` ran and that cargo-yurt emitted the wasm. \
                     This must be a hard failure — soft-skipping would silently pass the Rust gate.",
                    rust_wasm.display(),
                    spec.symbol
                ));
            }
            for case in &spec.cases {
                results.push(self.run_one(spec, case, &c_wasm, "c")?);
                if include_rust {
                    results.push(self.run_one(spec, case, &rust_wasm, "rust")?);
                }
            }
        }
        Ok(results)
    }

    /// Run yurt-check on the Rust pre-opt wasms for the same canary→symbol
    /// map used by the C side. Every canary in the map MUST have a
    /// pre-opt wasm present — missing artifacts are a hard failure, for
    /// the same reason as `run_spec_traces`.
    pub fn run_rust_signature_checks(&self) -> Result<()> {
        let yurt_check = self.target_bin("yurt-check");
        let archive = self.guest_compat().join("build/libyurt_guest_compat.a");
        let build_dir = self.guest_compat().join("build/rust");
        let mut failed = Vec::new();
        for (canary, symbols) in canary_symbol_map() {
            let pre_opt = build_dir.join(format!("{canary}.pre-opt.wasm"));
            if !pre_opt.exists() {
                return Err(anyhow!(
                    "missing Rust pre-opt wasm {} for canary {}. \
                     Ensure `make rust-canaries` ran with YURT_CC_PRESERVE_PRE_OPT set. \
                     This must be a hard failure — soft-skipping would leave {} Tier 1 \
                     symbols unverified on the Rust side.",
                    pre_opt.display(),
                    canary,
                    symbols.len()
                ));
            }
            println!("== rust {canary} ({} symbols) ==", symbols.len());
            let mut cmd = Command::new(&yurt_check);
            cmd.arg("--archive").arg(&archive);
            cmd.arg("--pre-opt-wasm").arg(&pre_opt);
            for sym in *symbols {
                cmd.arg("--symbol").arg(*sym);
            }
            let status = cmd
                .status()
                .with_context(|| format!("running yurt-check on rust {canary}"))?;
            if !status.success() {
                failed.push(*canary);
            }
        }
        if !failed.is_empty() {
            return Err(anyhow!(
                "rust signature check failed for: {}",
                failed.join(", ")
            ));
        }
        Ok(())
    }
}

pub fn detect_repo_root() -> Result<PathBuf> {
    // Walk upward from CWD until we find a Cargo.toml with `[workspace]`.
    let mut cur = std::env::current_dir()?;
    loop {
        let cargo = cur.join("Cargo.toml");
        if cargo.is_file() {
            if let Ok(text) = std::fs::read_to_string(&cargo) {
                if text.contains("[workspace]") {
                    return Ok(cur);
                }
            }
        }
        if !cur.pop() {
            break;
        }
    }
    Err(anyhow!(
        "could not locate repo root from {:?}",
        std::env::current_dir()?
    ))
}
