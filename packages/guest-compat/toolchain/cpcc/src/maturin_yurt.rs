use anyhow::Result;

#[derive(Debug, Default)]
pub struct MaturinPlan {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn plan_invocation(forwarded: &[String]) -> Result<MaturinPlan> {
    let mut plan = MaturinPlan::default();
    plan.args.extend_from_slice(forwarded);

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
    if let Some(std_root) = crate::rust_std::resolve_std_for_invocation(forwarded)? {
        if !rustflags.is_empty() {
            rustflags.push(' ');
        }
        rustflags.push_str(&format!("--sysroot={}", std_root.display()));
    }
    if !rustflags.is_empty() {
        plan.env.push((
            "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS".to_string(),
            rustflags.trim_end().to_string(),
        ));
    }

    Ok(plan)
}
