use anyhow::Result;

#[derive(Debug, Default)]
pub struct MaturinPlan {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn plan_invocation(forwarded: &[String]) -> Result<MaturinPlan> {
    let mut plan = MaturinPlan::default();
    for (name, path) in crate::cargo_yurt::discover_yurt_crate_ports()? {
        plan.args.push("--config".to_string());
        plan.args.push(format!(
            "patch.crates-io.{name}.path=\"{}\"",
            path.display()
        ));
    }
    plan.args.extend_from_slice(forwarded);
    if let Some(existing) = std::env::var_os("RUSTC_WRAPPER").filter(|v| !v.is_empty()) {
        plan.env.push((
            "YURT_RUSTC_WRAPPER_INNER".to_string(),
            std::path::PathBuf::from(existing).display().to_string(),
        ));
    }
    plan.env.push((
        "RUSTC_WRAPPER".to_string(),
        crate::cargo_yurt::rustc_wrapper_path()?
            .display()
            .to_string(),
    ));

    if !plan
        .args
        .windows(2)
        .any(|pair| pair[0] == "--target" && pair[1] == "wasm32-wasip1")
        && !plan.args.iter().any(|arg| arg == "--target=wasm32-wasip1")
    {
        plan.args.push("--target".to_string());
        plan.args.push("wasm32-wasip1".to_string());
    }

    let mut rustflags = std::env::var("CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS").unwrap_or_default();
    let std_root = crate::rust_std::resolve_std_for_invocation(forwarded)?;
    if !rustflags.is_empty() {
        rustflags.push(' ');
    }
    rustflags.push_str(&format!(
        "--sysroot={} -Aexplicit-builtin-cfgs-in-flags --cfg yurt --cfg unix",
        std_root.display()
    ));
    if !rustflags.is_empty() {
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            rustflags.trim_end().to_string(),
        ));
    }

    Ok(plan)
}
