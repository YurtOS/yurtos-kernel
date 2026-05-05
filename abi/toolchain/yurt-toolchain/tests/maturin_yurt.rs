use std::sync::Mutex;
use yurt_toolchain::maturin_yurt::plan_invocation;

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn maturin_plan_adds_wasm_target() {
    let _guard = ENV_LOCK.lock().unwrap();
    let plan = plan_invocation(&["build".into()]).unwrap();
    assert_eq!(
        plan.args,
        vec![
            "build".to_string(),
            "--target".to_string(),
            "wasm32-wasip1".to_string()
        ]
    );
}

#[test]
fn maturin_plan_uses_yurt_std_override() {
    let _guard = ENV_LOCK.lock().unwrap();
    let prev = std::env::var_os("YURT_RUST_STD");
    std::env::set_var("YURT_RUST_STD", "/tmp/yurt-rust-std");

    let plan = plan_invocation(&["build".into()]).unwrap();

    match prev {
        Some(v) => std::env::set_var("YURT_RUST_STD", v),
        None => std::env::remove_var("YURT_RUST_STD"),
    }

    let flags = plan
        .env
        .iter()
        .find(|(k, _)| k == "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    assert!(flags.contains("--sysroot=/tmp/yurt-rust-std"));
}
