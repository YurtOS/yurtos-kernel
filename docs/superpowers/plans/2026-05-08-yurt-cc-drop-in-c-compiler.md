# yurt-cc Drop-In C Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `yurt-cc` usable as the drop-in target C compiler for generic `wasm32-wasip1` C builds, including `cc-rs` dependencies such as `zstd-sys`.

**Architecture:** Keep `yurt-cc` as the single compiler driver, but split invocation classification from argv assembly. Compile/probe invocations get target, sysroot, and a default transparent Yurt include path; final Yurt links additionally get archive validation, link framing, exports, pre-opt preservation, and `wasm-opt`.

**Tech Stack:** Rust 2021, `clap`, `anyhow`, existing `yurt-toolchain` tests with fake wasi-sdk layouts, Cargo workspace fixtures, wasi-sdk clang for ignored integration tests.

---

## File Structure

- Modify `abi/toolchain/yurt-toolchain/src/env.rs`
  - Add `no_link_injection: bool` parsed from `YURT_CC_NO_LINK_INJECTION`.
  - Keep `YURT_CC_INCLUDE` as an explicit override for curated builds; generic builds use the discovered default include when it is unset.
- Modify `abi/toolchain/yurt-toolchain/src/cargo_yurt.rs`
  - Export `YURT_CC_NO_LINK_INJECTION=1` into Cargo builds so `cc-rs`/build-script compiler probes do not inspect the Yurt ABI archive.
- Modify `abi/toolchain/yurt-toolchain/src/main.rs`
  - Remove wrapper-injected compile policy flags: `-O2`, `-std=gnu23`, `-Wall`, `-Wextra`.
  - Add invocation classification helpers for compile/probe vs final link.
  - Skip archive version checks unless the invocation is a final Yurt link.
  - Add default Yurt include discovery from runtime binary location, with a repo-layout fallback.
  - Preserve user include ordering before default Yurt include.
  - Keep link framing only for final Yurt links.
- Modify `abi/toolchain/yurt-toolchain/tests/cli.rs`
  - Add helpers for fake wasi-sdk setup.
  - Replace old include-first expectation with package include before Yurt include before sysroot.
  - Add tests for flag neutrality, inherited invalid archive on `-c`/`-E`, `YURT_CC_NO_LINK_INJECTION`, and wrapper-reserved flag output.
- Modify `abi/Makefile`
  - Move `-O2 -std=gnu23 -Wall -Wextra` into ABI compile/link invocations that relied on wrapper defaults.
- Modify `test-fixtures/c-ports/busybox/Makefile`
  - Add explicit compile policy flags if the Makefile currently relies on `yurt-cc` defaults.
- Modify `abi/Makefile`
  - Copy `abi/include` into `target/release/yurt-include` during `ensure-toolchain`, so the release binary can discover headers relative to `current_exe()`.
- Modify root `Cargo.toml`
  - Add `test-fixtures/zstd-sys-smoke` workspace member if the fixture crate is committed in this repo.
- Modify root `Cargo.lock`
  - Record the new workspace package and exact `zstd-sys` fixture dependency.
- Create `test-fixtures/zstd-sys-smoke/Cargo.toml`
  - Minimal fixture depending on `zstd-sys`.
- Create `test-fixtures/zstd-sys-smoke/src/lib.rs`
  - Tiny Rust item so the fixture crate builds and pulls the dependency.

## Task 1: Lock The yurt-cc CLI Contract In Tests

**Files:**
- Modify: `abi/toolchain/yurt-toolchain/tests/cli.rs`

- [ ] **Step 1: Add fake wasi-sdk test helpers**

Add these helpers near the top of `abi/toolchain/yurt-toolchain/tests/cli.rs`, after `fn bin()`:

```rust
fn fake_sdk() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::create_dir_all(root.join("share/wasi-sysroot/include")).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let clang = root.join("bin/clang");
        fs::write(&clang, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&clang, fs::Permissions::from_mode(0o755)).unwrap();

        let nm = root.join("bin/llvm-nm");
        fs::write(&nm, b"#!/bin/sh\nexit 1\n").unwrap();
        fs::set_permissions(&nm, fs::Permissions::from_mode(0o755)).unwrap();
    }

    tmp
}

fn stdout_string(out: std::process::Output) -> String {
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

fn stdout_tokens(stdout: &str) -> Vec<&str> {
    stdout.split_whitespace().collect()
}

fn expected_repo_yurt_include() -> String {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("include");
    p.canonicalize()
        .unwrap_or(p)
        .display()
        .to_string()
}
```

- [ ] **Step 2: Write the flag-neutrality failing test**

Add this test after `invoking_clang_respects_env_sdk`:

```rust
#[test]
fn dry_run_does_not_force_compile_policy_flags() {
    let sdk = fake_sdk();

    let stdout = stdout_string(
        Command::new(bin())
            .env("WASI_SDK_PATH", sdk.path())
            .arg("--dry-run")
            .arg("-c")
            .arg("foo.c")
            .output()
            .unwrap(),
    );

    assert!(stdout.contains("--target=wasm32-wasip1"), "{stdout}");
    assert!(stdout.contains("--sysroot="), "{stdout}");
    let tokens = stdout_tokens(&stdout);
    assert!(!tokens.contains(&"-O2"), "{stdout}");
    assert!(!tokens.contains(&"-std=gnu23"), "{stdout}");
    assert!(!tokens.contains(&"-Wall"), "{stdout}");
    assert!(!tokens.contains(&"-Wextra"), "{stdout}");
}
```

- [ ] **Step 3: Write the default include discovery and ordering failing test**

Add this test after the flag-neutrality test:

```rust
#[test]
fn dry_run_discovers_default_yurt_include_after_user_includes() {
    let sdk = fake_sdk();

    let stdout = stdout_string(
        Command::new(bin())
            .env("WASI_SDK_PATH", sdk.path())
            .env_remove("YURT_CC_INCLUDE")
            .arg("--dry-run")
            .arg("-c")
            .arg("-I")
            .arg("package/include")
            .arg("foo.c")
            .output()
            .unwrap(),
    );

    let user_idx = stdout.find("-I package/include").unwrap();
    let expected_include = expected_repo_yurt_include();
    let yurt_idx = stdout
        .find("yurt-include")
        .or_else(|| stdout.find(&expected_include))
        .unwrap_or_else(|| panic!("missing default Yurt include {expected_include}: {stdout}"));
    let sysroot_idx = stdout.find("--sysroot=").unwrap();
    assert!(user_idx < yurt_idx, "{stdout}");
    assert!(yurt_idx < sysroot_idx, "{stdout}");
}
```

- [ ] **Step 4: Replace the old include-first test with final-link framing plus ordering**

Rename `dry_run_injects_compat_archive_and_include_first` to `dry_run_injects_archive_and_preserves_include_order`, and replace its include assertions with:

```rust
    assert!(stdout.contains("-I package/include"), "{stdout}");
    assert!(stdout.contains("-I /fake/include"), "{stdout}");
    let expected_include = expected_repo_yurt_include();
    assert!(
        stdout.contains("yurt-include") || stdout.contains(&expected_include),
        "missing default Yurt include {expected_include}: {stdout}",
    );
    assert!(
        stdout.find("-I package/include").unwrap() < stdout.find("-I /fake/include").unwrap(),
        "user include must precede explicit Yurt include: {stdout}",
    );
    assert!(
        stdout.find("-I /fake/include").unwrap() < stdout.find("--sysroot=").unwrap(),
        "explicit Yurt include must precede the WASI sysroot headers: {stdout}",
    );
```

Also add the package include arguments to the command:

```rust
        .arg("-I")
        .arg("package/include")
```

- [ ] **Step 5: Write inherited invalid archive tests for compile/probe**

Add these tests after `missing_version_sentinel_is_a_hard_error`:

```rust
#[test]
fn compile_only_skips_archive_validation_even_when_archive_is_invalid() {
    let sdk = fake_sdk();

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .arg("-c")
        .arg("foo.c")
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(!stdout.contains("missing-libyurt_abi.a"), "{stdout}");
    assert!(!stdout.contains("--whole-archive"), "{stdout}");
}

#[test]
fn preprocess_only_skips_archive_validation_even_when_archive_is_invalid() {
    let sdk = fake_sdk();

    let out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .arg("-E")
        .arg("foo.c")
        .output()
        .unwrap();

    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(!stdout.contains("missing-libyurt_abi.a"), "{stdout}");
    assert!(!stdout.contains("--whole-archive"), "{stdout}");
}
```

- [ ] **Step 6: Write link-shaped probe opt-out tests**

Add this test after the compile/preprocess archive tests:

```rust
#[test]
fn link_shaped_probe_can_disable_yurt_link_injection() {
    let sdk = fake_sdk();

    let without_opt_out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .arg("probe.c")
        .arg("-o")
        .arg("probe")
        .output()
        .unwrap();
    assert!(!without_opt_out.status.success(), "expected invalid archive failure");
    let stderr = String::from_utf8_lossy(&without_opt_out.stderr);
    assert!(stderr.contains("version check") || stderr.contains("missing-libyurt_abi"), "{stderr}");

    let with_opt_out = Command::new(bin())
        .env("WASI_SDK_PATH", sdk.path())
        .env("YURT_CC_ARCHIVE", sdk.path().join("missing-libyurt_abi.a"))
        .env("YURT_CC_NO_LINK_INJECTION", "1")
        .arg("probe.c")
        .arg("-o")
        .arg("probe")
        .output()
        .unwrap();
    assert!(
        with_opt_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&with_opt_out.stderr)
    );
}
```

- [ ] **Step 7: Tighten version output expectation**

Update `version_prints_version` to assert the first line starts with `yurt-cc`:

```rust
    let first = stdout.lines().next().unwrap_or("");
    assert!(first.starts_with("yurt-cc "), "version output: {stdout}");
```

- [ ] **Step 8: Run the focused tests and verify they fail**

Run:

```bash
cargo test -p yurt-toolchain --test cli -- --nocapture
```

Expected: FAIL. The new failures should show current wrapper behavior: forced compile flags, no default discovered include, archive validation before compile/probe classification, and no `YURT_CC_NO_LINK_INJECTION` support.

- [ ] **Step 9: Commit the failing tests**

```bash
git add abi/toolchain/yurt-toolchain/tests/cli.rs
git commit -m "test: lock yurt-cc drop-in compiler contract"
```

## Task 2: Implement Invocation Classification And Link Injection Gating

**Files:**
- Modify: `abi/toolchain/yurt-toolchain/src/env.rs`
- Modify: `abi/toolchain/yurt-toolchain/src/main.rs`
- Modify: `abi/toolchain/yurt-toolchain/src/cargo_yurt.rs`
- Modify: `abi/toolchain/yurt-toolchain/tests/cargo_yurt_dry_run.rs`

- [ ] **Step 1: Add `YURT_CC_NO_LINK_INJECTION` to the environment**

In `abi/toolchain/yurt-toolchain/src/env.rs`, add this field to `Env`:

```rust
    pub no_link_injection: bool,
```

Set it in `Env::from_process()`:

```rust
            no_link_injection: has_var(["YURT_CC_NO_LINK_INJECTION"]),
```

- [ ] **Step 2: Replace `is_link_invocation` with final-link classification**

In `abi/toolchain/yurt-toolchain/src/main.rs`, replace `is_link_invocation` with:

```rust
fn is_compile_or_probe_invocation(user_args: &[String]) -> bool {
    user_args
        .iter()
        .any(|a| a == "-c" || a == "-E" || a == "-S" || a == "-r" || a == "--relocatable")
}

fn is_final_yurt_link_invocation(env: &env::Env, user_args: &[String]) -> bool {
    !env.no_link_injection && !is_compile_or_probe_invocation(user_args)
}
```

- [ ] **Step 3: Gate archive version checks on final-link classification**

In `main()`, replace:

```rust
    if let Some(archive) = env.archive.as_ref() {
        if !env.skip_version_check {
            archive::check_version(&sdk.nm(), archive).context("version check")?;
        }
    }
```

with:

```rust
    let final_yurt_link = is_final_yurt_link_invocation(&env, &cli.args);

    if final_yurt_link {
        if let Some(archive) = env.archive.as_ref() {
            if !env.skip_version_check {
                archive::check_version(&sdk.nm(), archive).context("version check")?;
            }
        }
    }
```

- [ ] **Step 4: Pass final-link classification into argv construction**

Change the `build_clang_invocation` signature to:

```rust
fn build_clang_invocation(
    sdk: &wasi_sdk::WasiSdk,
    env: &env::Env,
    user_args: &[String],
    final_yurt_link: bool,
) -> Vec<OsString> {
```

Change the call site to:

```rust
    let argv = build_clang_invocation(&sdk, &env, &cli.args, final_yurt_link);
```

- [ ] **Step 5: Gate link argv and post-link work on final-link classification**

Inside `build_clang_invocation`, replace:

```rust
    if let Some(archive) = env.archive.as_ref() {
        if is_link_invocation(user_args) {
```

with:

```rust
    if let Some(archive) = env.archive.as_ref() {
        if final_yurt_link {
```

In `main()`, replace:

```rust
    if is_link_invocation(&cli.args) {
```

with:

```rust
    if final_yurt_link {
```

- [ ] **Step 6: Wire cargo-yurt to disable yurt-cc link injection for build-script probes**

Add this test to `abi/toolchain/yurt-toolchain/tests/cargo_yurt_dry_run.rs` after `injected_env_includes_yurt_link_injected`:

```rust
#[test]
fn cargo_yurt_disables_yurt_cc_link_injection_for_build_script_probes() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = plan_invocation(Subcommand::Build, &[]).unwrap();
    assert_eq!(
        plan.env
            .iter()
            .find(|(k, _)| k == "YURT_CC_NO_LINK_INJECTION")
            .map(|(_, v)| v.as_str()),
        Some("1"),
    );
}
```

Then in `abi/toolchain/yurt-toolchain/src/cargo_yurt.rs`, after the existing `YURT_LINK_INJECTED` env insertion, add:

```rust
    // Cargo build scripts and cc-rs dependencies may run link-shaped compiler
    // probes. Those probes must behave like wasi-sdk clang and must not inspect
    // or inject the Yurt ABI archive.
    plan.env
        .push(("YURT_CC_NO_LINK_INJECTION".to_string(), "1".to_string()));
```

This env var affects build-script invocations of `yurt-cc`. It does not disable the Rust final link, because `cargo-yurt` injects the Rust link contract through `CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS` and the wasi-sdk clang linker env, not through the `yurt-cc` wrapper.

- [ ] **Step 7: Run the archive/probe tests**

Run:

```bash
cargo test -p yurt-toolchain --test cli compile_only_skips_archive_validation_even_when_archive_is_invalid -- --nocapture
cargo test -p yurt-toolchain --test cli preprocess_only_skips_archive_validation_even_when_archive_is_invalid -- --nocapture
cargo test -p yurt-toolchain --test cli link_shaped_probe_can_disable_yurt_link_injection -- --nocapture
cargo test -p yurt-toolchain --test cargo_yurt_dry_run cargo_yurt_disables_yurt_cc_link_injection_for_build_script_probes -- --nocapture
```

Expected: PASS.

- [ ] **Step 8: Commit invocation classification**

```bash
git add abi/toolchain/yurt-toolchain/src/env.rs abi/toolchain/yurt-toolchain/src/main.rs abi/toolchain/yurt-toolchain/src/cargo_yurt.rs abi/toolchain/yurt-toolchain/tests/cargo_yurt_dry_run.rs
git commit -m "fix: skip yurt link handling for compiler probes"
```

## Task 3: Implement Default Include Discovery And Flag Neutrality

**Files:**
- Modify: `abi/toolchain/yurt-toolchain/src/main.rs`
- Modify: `abi/Makefile`

- [ ] **Step 1: Add a runtime include discovery helper**

In `abi/toolchain/yurt-toolchain/src/main.rs`, add `PathBuf` to imports:

```rust
use std::path::{Path, PathBuf};
```

Add this helper above `build_clang_invocation`:

```rust
fn default_yurt_include_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bin_dir = exe.parent()?;
    let installed = bin_dir.join("yurt-include");
    if installed.join("stdio.h").is_file() {
        return Some(installed.canonicalize().unwrap_or(installed));
    }

    repo_include_from_manifest_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
}

fn repo_include_from_manifest_dir(manifest_dir: &Path) -> Option<PathBuf> {
    let include = manifest_dir.join("../..").join("include");
    if include.join("stdio.h").is_file() {
        Some(include.canonicalize().unwrap_or(include))
    } else {
        None
    }
}
```

`CARGO_MANIFEST_DIR` for this crate is `abi/toolchain/yurt-toolchain`, so `../..` resolves to `abi/include`. The build-time path is only a development fallback. Release/installed binaries should find headers in `target/release/yurt-include` next to the executable.

- [ ] **Step 2: Remove forced compile policy flags**

In `build_clang_invocation`, delete these pushes:

```rust
    argv.push("-O2".into());
    argv.push("-std=gnu23".into());
    argv.push("-Wall".into());
    argv.push("-Wextra".into());
```

Also delete the long comment that justified `-std=gnu23`; that policy moves to Makefiles in Task 4.

- [ ] **Step 3: Rebuild argv so user args precede Yurt include**

Replace the beginning of `build_clang_invocation` with:

```rust
    let mut argv: Vec<OsString> = Vec::new();
    for a in user_args {
        argv.push(a.into());
    }

    if let Some(inc) = env.include.as_ref() {
        argv.push("-I".into());
        argv.push(inc.clone().into_os_string());
    }
    if let Some(default_include) = default_yurt_include_dir() {
        argv.push("-I".into());
        argv.push(default_include.into_os_string());
    }

    argv.push(format!("--sysroot={}", sdk.sysroot().display()).into());
    argv.push("--target=wasm32-wasip1".into());
```

This preserves package `-I` arguments before the Yurt include path. `YURT_CC_INCLUDE` is an explicit override: when it is set, do not also inject the discovered default include, because duplicating equivalent Yurt standard-name headers breaks `#include_next` chains. Keep `--target` and `--sysroot` near the front so clang applies the wasi target/sysroot before compiling source inputs. The CLI dry-run tests are the authority for this ordering.

- [ ] **Step 4: Copy headers next to release binaries in `abi/Makefile`**

In `abi/Makefile`, update `ensure-toolchain` from:

```make
ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p yurt-toolchain
```

to:

```make
ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p yurt-toolchain
	rm -rf $(REPO_ROOT)/target/release/yurt-include
	cp -R $(INCLUDE) $(REPO_ROOT)/target/release/yurt-include
```

This makes the default include path relocatable for the repo's release binaries and avoids relying on a build-time absolute source path after install/copy.

- [ ] **Step 5: Run include and flag tests**

Run:

```bash
cargo test -p yurt-toolchain --test cli dry_run_does_not_force_compile_policy_flags -- --nocapture
cargo test -p yurt-toolchain --test cli dry_run_discovers_default_yurt_include_after_user_includes -- --nocapture
cargo test -p yurt-toolchain --test cli dry_run_injects_archive_and_preserves_include_order -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Run full CLI test suite**

Run:

```bash
cargo test -p yurt-toolchain --test cli -- --nocapture
```

Expected: PASS, except ignored slow tests remain ignored.

- [ ] **Step 7: Commit default include and flag changes**

```bash
git add abi/toolchain/yurt-toolchain/src/main.rs abi/toolchain/yurt-toolchain/tests/cli.rs abi/Makefile
git commit -m "fix: make yurt-cc compile flags package-neutral"
```

## Task 4: Move Curated Build Policy Flags Into Makefiles

**Files:**
- Modify: `abi/Makefile`
- Modify: `test-fixtures/c-ports/busybox/Makefile`

- [ ] **Step 1: Add ABI CFLAGS to `abi/Makefile`**

Near the existing `YURT_CC` definitions in `abi/Makefile`, add:

```make
# yurt-cc itself stays package-neutral. These flags preserve the curated ABI
# build policy: gnulib-derived ports need C23 additions, and the ABI canaries
# keep the historical warning/optimization profile here.
YURT_CFLAGS := -O2 -std=gnu23 -Wall -Wextra
```

- [ ] **Step 2: Apply ABI CFLAGS to ABI object compilation**

Change:

```make
	YURT_CC_ARCHIVE= YURT_CC_INCLUDE=$(INCLUDE) $(YURT_CC) -c $< -o $@
```

to:

```make
	YURT_CC_ARCHIVE= YURT_CC_INCLUDE=$(INCLUDE) $(YURT_CC) $(YURT_CFLAGS) -c $< -o $@
```

- [ ] **Step 3: Apply ABI CFLAGS to C canary links**

Apply these exact replacements in `abi/Makefile`.

For `setjmp-canary.wasm`, change:

```make
	$(YURT_CC) $< -o $@
```

to:

```make
	$(YURT_CC) $(YURT_CFLAGS) $< -o $@
```

For `fork-canary.wasm`, change:

```make
	$(YURT_CC) -DYURT_FORK_CANARY_CONTINUATION=1 $< -o $@
```

to:

```make
	$(YURT_CC) $(YURT_CFLAGS) -DYURT_FORK_CANARY_CONTINUATION=1 $< -o $@
```

For `fork-default-canary.wasm` and the generic `%-canary.wasm` rule, change:

```make
	$(YURT_CC) $< -o $@
```

to:

```make
	$(YURT_CC) $(YURT_CFLAGS) $< -o $@
```

After editing, run:

```bash
rg -n '\$\(YURT_CC\)' abi/Makefile
```

Expected: direct C object/canary compile lines use `$(YURT_CC) $(YURT_CFLAGS)`. Remaining matches may include comments, variable definitions, or Rust `cargo-yurt` invocations.

- [ ] **Step 4: Add explicit BusyBox flags**

In `test-fixtures/c-ports/busybox/Makefile`, add this after the `YURT_RANLIB` definition:

```make
# yurt-cc is package-neutral; BusyBox keeps its historical curated-build
# warning/optimization/profile flags here.
YURT_CFLAGS := -O2 -std=gnu23 -Wall -Wextra
```

Then change the BusyBox build invocation from:

```make
			EXTRA_CFLAGS="$(WASI_EMULATED_CFLAGS)" \
```

to:

```make
			EXTRA_CFLAGS="$(YURT_CFLAGS) $(WASI_EMULATED_CFLAGS)" \
```

Also check for call sites that intentionally expected no Yurt include path. If one exists, add an explicit environment switch in Task 3 before proceeding; otherwise document in the commit body that the repo's generic builds use the default include path and curated builds that set `YURT_CC_INCLUDE=$(INCLUDE)` override that default.

- [ ] **Step 5: Run formatting and build checks for toolchain and ABI**

Run:

```bash
cargo fmt --all -- --check
cargo test -p yurt-toolchain --test cli -- --nocapture
make -C abi lib
```

Expected: PASS.

- [ ] **Step 6: Commit curated build flag migration**

```bash
git add abi/Makefile test-fixtures/c-ports/busybox/Makefile
git commit -m "chore: move yurt C policy flags into curated builds"
```

If BusyBox needed no changes, omit it from `git add`.

## Task 5: Add Header Composition Regression Coverage

**Files:**
- Modify: `abi/toolchain/yurt-toolchain/tests/cli.rs`

- [ ] **Step 1: Add ignored real-clang standard header composition test**

Add this ignored test near the existing ignored slow test:

```rust
#[ignore = "slow: invokes real clang via yurt-cc to compile a C file"]
#[test]
fn standard_headers_expose_yurt_compat_declarations() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skipping - WASI_SDK_PATH not set");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("headers.c");
    fs::write(
        &src,
        br#"
#include <stdio.h>
#include <time.h>
int main(void) {
    FILE *f = stdout;
    clock_t c = 0;
    tzset();
    flockfile(f);
    funlockfile(f);
    return f == 0 || c != 0;
}
"#,
    )
    .unwrap();
    let obj = tmp.path().join("headers.o");

    let st = Command::new(bin())
        .arg("-c")
        .arg(&src)
        .arg("-o")
        .arg(&obj)
        .status()
        .unwrap();
    assert!(st.success());
    assert!(obj.exists());
}
```

- [ ] **Step 2: Add ignored zstd-like include ordering test**

Add this ignored test after the standard header test:

```rust
#[ignore = "slow: invokes real clang via yurt-cc to compile C fixtures"]
#[test]
fn zstd_like_shim_include_order_composes_with_yurt_headers() {
    if std::env::var_os("WASI_SDK_PATH").is_none() {
        eprintln!("skipping - WASI_SDK_PATH not set");
        return;
    }

    let tmp = tempfile::tempdir().unwrap();
    let shim = tmp.path().join("wasm-shim");
    fs::create_dir_all(&shim).unwrap();
    fs::write(
        shim.join("time.h"),
        b"#ifndef ZSTD_WASM_SHIM_TIME_H\n#define ZSTD_WASM_SHIM_TIME_H\n#include_next <time.h>\n#endif\n",
    )
    .unwrap();
    let src = tmp.path().join("shim.c");
    fs::write(
        &src,
        br#"
#include <time.h>
#include <stdio.h>
int main(void) {
    clock_t c = 0;
    FILE *f = stdout;
    tzset();
    return f == 0 || c != 0;
}
"#,
    )
    .unwrap();
    let obj = tmp.path().join("shim.o");

    let st = Command::new(bin())
        .env_remove("YURT_CC_INCLUDE")
        .arg("-c")
        .arg("-I")
        .arg(&shim)
        .arg(&src)
        .arg("-o")
        .arg(&obj)
        .status()
        .unwrap();
    assert!(st.success());
}
```

- [ ] **Step 3: Run the ignored tests manually if wasi-sdk is available**

Run:

```bash
cargo test -p yurt-toolchain --test cli standard_headers_expose_yurt_compat_declarations -- --ignored --nocapture
cargo test -p yurt-toolchain --test cli zstd_like_shim_include_order_composes_with_yurt_headers -- --ignored --nocapture
```

Expected: PASS when `WASI_SDK_PATH` is set; otherwise each test prints a skip message and returns successfully.

- [ ] **Step 4: Commit header regression tests**

```bash
git add abi/toolchain/yurt-toolchain/tests/cli.rs
git commit -m "test: cover yurt compatibility header composition"
```

## Task 6: Add zstd-sys Smoke Fixture

**Files:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Create: `test-fixtures/zstd-sys-smoke/Cargo.toml`
- Create: `test-fixtures/zstd-sys-smoke/src/lib.rs`

- [x] **Step 1: Add the workspace member**

In root `Cargo.toml`, add this member near the other `test-fixtures` entries:

```toml
  "test-fixtures/zstd-sys-smoke",
```

Do not add it to `default-members`; it is a targeted wasm dependency smoke fixture.

- [x] **Step 2: Create the fixture manifest**

Create `test-fixtures/zstd-sys-smoke/Cargo.toml`:

```toml
[package]
name = "zstd-sys-smoke"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
path = "src/lib.rs"

[dependencies]
zstd-sys = "=2.0.16"
```

This resolves to the locked `zstd-sys` package version `2.0.16+zstd.1.5.7`; Cargo ignores build metadata in dependency requirements and warns if the requirement includes `+zstd.1.5.7`. If `yurt-pkg`'s `Cargo.lock` shows a different failing `zstd-sys` base version, replace this exact version with that lockfile version before committing. The fixture must stay deterministic rather than tracking the latest compatible `2.x` release.

- [x] **Step 3: Create the fixture source**

Create `test-fixtures/zstd-sys-smoke/src/lib.rs`:

```rust
pub fn zstd_sys_smoke() -> i32 {
    0
}
```

- [x] **Step 4: Run metadata/check for the fixture**

Run:

```bash
cargo check -p zstd-sys-smoke --target wasm32-wasip1
```

Expected: this may fail before the full wrapper fix if wasi-sdk or target dependencies are missing locally, but Cargo should recognize the package and update `Cargo.lock`. If it fails because the wasm target is unavailable, install/use the existing project target setup and rerun.

Result: `cargo check -p zstd-sys-smoke --target wasm32-wasip1` recognized the package and updated `Cargo.lock`; plain Cargo then failed in `zstd-sys` because cc-rs invoked host `clang` for `wasm32-wasip1`. The Task 7 `cargo-yurt` acceptance is the real drop-in compiler check.

- [x] **Step 5: Commit the fixture**

```bash
git add Cargo.toml Cargo.lock test-fixtures/zstd-sys-smoke
git commit -m "test: add zstd-sys yurt cc smoke fixture"
```

## Task 7: Run Acceptance And Regression Gates

**Files:**
- No source edits expected.

- [x] **Step 1: Run Rust formatting**

```bash
cargo fmt --all -- --check
```

Expected: PASS.

Result: FAIL on pre-existing formatting drift outside this work, including conformance canaries and shell fixtures. No broad formatting rewrite was made as part of this branch.

- [x] **Step 2: Run yurt-toolchain tests**

```bash
cargo test -p yurt-toolchain --tests
```

Expected: PASS.

Result: PASS.

- [x] **Step 3: Run focused zstd smoke through cargo-yurt**

First build the toolchain and ABI archive:

```bash
cargo build --release -p yurt-toolchain
make -C abi lib
```

Then run the smoke fixture:

```bash
KERNEL_WORKTREE=$(pwd)
env -u YURT_CC_INCLUDE \
CC_wasm32_wasip1="$KERNEL_WORKTREE/target/release/yurt-cc" \
AR_wasm32_wasip1="$KERNEL_WORKTREE/target/release/yurt-ar" \
RANLIB_wasm32_wasip1="$KERNEL_WORKTREE/target/release/yurt-ranlib" \
YURT_CC_ARCHIVE="$KERNEL_WORKTREE/abi/build/libyurt_abi.a" \
"$KERNEL_WORKTREE/target/release/cargo-yurt" build --release -p zstd-sys-smoke
```

Expected: PASS; `zstd-sys` compiles through `yurt-cc`. `cargo-yurt` should export `YURT_CC_NO_LINK_INJECTION=1` into the Cargo build environment, so any `cc-rs` link-shaped probes do not inspect or inject the ABI archive.

Result: PASS. A first attempt with relative `target/release/yurt-cc` failed because cc-rs resolves `CC_*` from the build-script working directory; the corrected command uses absolute paths.

- [x] **Step 4: Run ABI smoke**

```bash
make -C abi canaries
```

Expected: PASS.

Result: PASS.

- [x] **Step 5: Run clippy for touched Rust package**

```bash
cargo clippy -p yurt-toolchain --all-targets -- -D warnings
```

Expected: PASS.

Result: PASS after implementing `FromStr` for `Spec` to satisfy the package-level clippy gate.

- [x] **Step 6: Run original yurt-pkg acceptance manually**

This is a manual cross-repository acceptance check, not a required kernel CI gate. From the `yurt-pkg` checkout, run the original `pkg` build path with these compiler variables pointing back to this kernel worktree's release binaries:

```bash
env -u YURT_CC_INCLUDE \
CC_wasm32_wasip1=/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/yurt-cc-drop-in-c-compiler/target/release/yurt-cc \
AR_wasm32_wasip1=/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/yurt-cc-drop-in-c-compiler/target/release/yurt-ar \
RANLIB_wasm32_wasip1=/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/yurt-cc-drop-in-c-compiler/target/release/yurt-ranlib \
YURT_CC_ARCHIVE=/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/yurt-cc-drop-in-c-compiler/abi/build/libyurt_abi.a \
/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/yurt-cc-drop-in-c-compiler/target/release/cargo-yurt build --release -p pkg
```

Expected: the original `zstd-sys` failure is gone. If a later dependency fails for a distinct runtime/API gap, record that separately and do not expand this task unless the failure is another `yurt-cc` wrapper regression.

Result: PARTIAL PASS. `zstd-sys v2.0.16+zstd.1.5.7` compiled through `cargo-yurt` with this branch's `yurt-cc`; the build then failed later in `fs2 v0.4.3` because that crate has no `sys` module for the selected target. That later dependency failure is distinct from the yurt-cc wrapper regression.

- [x] **Step 7: Commit any verification-only docs update if needed**

If verification reveals a required command correction in this plan or the spec, commit only that docs correction:

```bash
git add docs/superpowers/plans/2026-05-08-yurt-cc-drop-in-c-compiler.md docs/superpowers/specs/2026-05-08-yurt-cc-drop-in-c-compiler-design.md
git commit -m "docs: update yurt-cc verification commands"
```

## Self-Review

- Spec coverage:
  - Drop-in compiler contract: Tasks 1-3.
  - Default include path with user includes before Yurt before sysroot: Tasks 1 and 3.
  - Archive validation skipped for compile/probe and opt-out for link-shaped probes: Tasks 1 and 2.
  - Wrapper-reserved flags and pass-through behavior: Tasks 1 and 2.
  - Header composition: Task 5.
  - zstd fixture and original `pkg` acceptance: Tasks 6 and 7.
  - Curated flag migration: Task 4.
- Red-flag scan: no incomplete markers remain; unresolved external acceptance is explicitly a manual verification step.
- Type/signature consistency: `Env::no_link_injection`, `is_compile_or_probe_invocation`, and `is_final_yurt_link_invocation` are introduced before use.
