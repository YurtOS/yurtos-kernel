use std::sync::Mutex;
use yurt_toolchain::maturin_yurt::plan_invocation;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn with_yurt_std<T>(f: impl FnOnce() -> T) -> T {
    let prev = std::env::var_os("YURT_RUST_STD");
    std::env::set_var("YURT_RUST_STD", "/tmp/yurt-rust-std");
    let result = f();
    match prev {
        Some(v) => std::env::set_var("YURT_RUST_STD", v),
        None => std::env::remove_var("YURT_RUST_STD"),
    }
    result
}

#[test]
fn maturin_plan_adds_wasm_target() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(&["build".into()])).unwrap();
    assert!(plan.args.iter().any(|arg| arg == "build"));
    assert!(plan
        .args
        .windows(2)
        .any(|pair| pair[0] == "--target" && pair[1] == "wasm32-wasip1"));
}

#[test]
fn maturin_plan_uses_yurt_std_override() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = with_yurt_std(|| plan_invocation(&["build".into()])).unwrap();

    let flags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(flags.contains("--sysroot=/tmp/yurt-rust-std"));
    assert!(flags.contains("--cfg yurt"));
    assert!(flags.contains("--cfg unix"));
}
