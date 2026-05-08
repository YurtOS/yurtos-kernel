//! Post-link .wasm rewriter. See Cargo.toml for the design; this file
//! is the glue.
//!
//! Each `Shim` entry pairs:
//!   - A stable legacy-mangling PREFIX for the target stdlib function
//!     (the final 17h<hash>E suffix is build-dependent; we match anything
//!     after the prefix).
//!   - The stable `#[export_name = ...]` identifier of the yurt-wasi-shims
//!     replacement that the consumer crate must have linked in.
//!
//! On each shim: look up both functions in the module, assert their wasm
//! type signatures are equal, rewrite the target's body to call the
//! replacement and return, leaving all other functions untouched.

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use std::path::PathBuf;
use walrus::{FunctionBuilder, FunctionId, Module};

/// Table of stdlib fns we rewrite post-link. Mangled prefix (without the
/// terminating hash segment) → yurt-wasi-shims export name.
const SHIMS: &[(&str, &str)] = &[("_ZN3std3env8temp_dir", "__yurt_wasi_shim_env_temp_dir")];

#[derive(Parser, Debug)]
#[command(
    name = "yurt-wasi-postlink",
    about = "Rewrite wasip1 stdlib-panic functions in a .wasm to call yurt-wasi-shims replacements."
)]
struct Args {
    /// Input .wasm file (must still contain its `name` custom section;
    /// build with `strip = false`).
    #[arg(short, long)]
    input: PathBuf,

    /// Output .wasm path. May be the same as input for an in-place rewrite.
    #[arg(short, long)]
    output: PathBuf,

    /// Exit successfully if no target symbols are found (useful for
    /// blanket application across crates that don't all use panicky fns).
    #[arg(long)]
    allow_missing: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();

    let mut module = Module::from_file(&args.input)
        .with_context(|| format!("loading {}", args.input.display()))?;

    let mut rewrites = 0usize;
    let mut skipped: Vec<&str> = Vec::new();

    for (prefix, shim_name) in SHIMS {
        let target = find_by_prefix(&module, prefix);
        let shim = find_by_export(&module, shim_name);

        match (target, shim) {
            (Some(t), Some(s)) => {
                rewrite_body(&mut module, t, s)
                    .with_context(|| format!("rewriting {prefix} → {shim_name}"))?;
                eprintln!("yurt-wasi-postlink: rewrote {prefix}* → {shim_name}");
                rewrites += 1;
            }
            (None, None) => {
                skipped.push(prefix);
            }
            (Some(_), None) => {
                bail!(
                    "stdlib fn matching `{prefix}*` is present but shim `{shim_name}` is not \
                     linked in. Add `yurt-wasi-shims` as a direct dependency of the crate \
                     whose .wasm you're post-linking."
                );
            }
            (None, Some(_)) => {
                // Shim linked in but target unused — harmless dead weight,
                // log and continue.
                eprintln!(
                    "yurt-wasi-postlink: shim `{shim_name}` present but no reference to \
                     `{prefix}*` found; leaving untouched"
                );
            }
        }
    }

    if rewrites == 0 && !skipped.is_empty() && !args.allow_missing {
        bail!(
            "no stdlib fn matching any configured prefix found in {}. \
             Either pass --allow-missing for a best-effort rewrite or verify the input was \
             built with `strip = false` so the `name` section survives. Skipped prefixes: {:?}",
            args.input.display(),
            skipped
        );
    }

    module
        .emit_wasm_file(&args.output)
        .with_context(|| format!("writing {}", args.output.display()))?;

    eprintln!(
        "yurt-wasi-postlink: {rewrites} rewrite(s), wrote {}",
        args.output.display()
    );
    Ok(())
}

fn find_by_prefix(module: &Module, prefix: &str) -> Option<FunctionId> {
    module
        .funcs
        .iter()
        .find(|f| matches!(&f.name, Some(n) if n.starts_with(prefix) && n.ends_with('E')))
        .map(|f| f.id())
}

fn find_by_export(module: &Module, export_name: &str) -> Option<FunctionId> {
    module
        .exports
        .iter()
        .find_map(|e| match e.item {
            walrus::ExportItem::Function(id) if e.name == export_name => Some(id),
            _ => None,
        })
        .or_else(|| {
            // Fallback: not every exported function has a matching export
            // entry (LTO sometimes inlines). Search the name section.
            module
                .funcs
                .iter()
                .find(|f| matches!(&f.name, Some(n) if n == export_name))
                .map(|f| f.id())
        })
}

fn rewrite_body(module: &mut Module, target: FunctionId, shim: FunctionId) -> Result<()> {
    let target_ty = module.funcs.get(target).ty();
    let shim_ty = module.funcs.get(shim).ty();

    let (target_params, target_results) = {
        let t = module.types.get(target_ty);
        (t.params().to_vec(), t.results().to_vec())
    };
    let (shim_params, shim_results) = {
        let t = module.types.get(shim_ty);
        (t.params().to_vec(), t.results().to_vec())
    };

    if target_params != shim_params || target_results != shim_results {
        return Err(anyhow!(
            "target / shim type mismatch: target is {:?}→{:?}, shim is {:?}→{:?}",
            target_params,
            target_results,
            shim_params,
            shim_results
        ));
    }

    // Build a new function body that forwards all locals 0..n to the shim.
    let mut builder = FunctionBuilder::new(&mut module.types, &target_params, &target_results);

    let new_locals: Vec<_> = target_params
        .iter()
        .map(|ty| module.locals.add(*ty))
        .collect();

    let mut body = builder.func_body();
    for local in &new_locals {
        body.local_get(*local);
    }
    body.call(shim);
    // Implicit return at end of the body.

    let new_func = builder.local_func(new_locals);
    let existing = module.funcs.get_mut(target);
    // Swap in the new body, keeping the same FunctionId so all existing
    // references stay valid.
    match &mut existing.kind {
        walrus::FunctionKind::Local(old) => {
            *old = new_func;
        }
        walrus::FunctionKind::Import(_) | walrus::FunctionKind::Uninitialized(_) => {
            bail!("target function is not a local function");
        }
    }
    Ok(())
}
