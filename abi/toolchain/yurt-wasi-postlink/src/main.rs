//! Post-link .wasm rewriter. See Cargo.toml for the design; this file
//! is the glue.
//!
//! Two operating modes:
//!
//! 1. **Default (shim rewrite).** Each `Shim` entry pairs a stable
//!    legacy-mangling PREFIX for a panicky Rust stdlib function (the
//!    final 17h<hash>E suffix is build-dependent; we match anything
//!    after the prefix) with the stable `#[export_name = ...]` identifier
//!    of the yurt-wasi-shims replacement that the consumer crate must
//!    have linked in. We look up both functions in the module, assert
//!    their wasm type signatures are equal, rewrite the target's body
//!    to call the replacement and return, leaving all other functions
//!    untouched.
//!
//! 2. **`--side-module`.** Validate the wasm-ld-emitted `dylink.0`
//!    custom section (per the WebAssembly tool-conventions
//!    DynamicLinking spec) and emit a `<output>.yurtmeta.json` sidecar
//!    listing the side module's SONAME, exported symbols, declared
//!    dependencies, and dylink memory/table requirements. Used by the
//!    Phase 1 shared-library loader (see
//!    docs/superpowers/specs/2026-05-09-shared-libraries-design.md).

pub mod side_module;

use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use std::path::{Path, PathBuf};
use walrus::{FunctionBuilder, FunctionId, Module};

/// Table of stdlib fns we rewrite post-link. Mangled prefix (without the
/// terminating hash segment) → yurt-wasi-shims export name.
const SHIMS: &[(&str, &str)] = &[("_ZN3std3env8temp_dir", "__yurt_wasi_shim_env_temp_dir")];

#[derive(Parser, Debug)]
#[command(
    name = "yurt-wasi-postlink",
    about = "Post-link .wasm rewriter (stdlib-shim rewrite + Phase 1 side-module validation)."
)]
struct Args {
    /// Input .wasm file (in shim-rewrite mode, must still contain its
    /// `name` custom section; build with `strip = false`).
    #[arg(short, long)]
    input: PathBuf,

    /// Output .wasm path. May be the same as input for an in-place rewrite.
    #[arg(short, long)]
    output: PathBuf,

    /// Treat the input as a side module: validate the `dylink.0` custom
    /// section, emit a `<output>.yurtmeta.json` sidecar, and skip the
    /// stdlib-shim rewrite.
    #[arg(long)]
    side_module: bool,

    /// SONAME to record in the side-module manifest. Defaults to the
    /// input file's basename with any leading `lib` and trailing `.wasm`
    /// stripped (so `libfoo.wasm` → `foo`). Only meaningful with
    /// `--side-module`.
    #[arg(long, requires = "side_module")]
    soname: Option<String>,

    /// Output path for the side-module manifest. Defaults to
    /// `<output>.yurtmeta.json`. Only meaningful with `--side-module`.
    #[arg(long, requires = "side_module")]
    meta_out: Option<PathBuf>,

    /// Exit successfully if no target symbols are found (useful for
    /// blanket application across crates that don't all use panicky fns).
    /// Only meaningful in the default (shim-rewrite) mode.
    #[arg(long)]
    allow_missing: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.side_module {
        run_side_module(&args)
    } else {
        run_shim_rewrite(&args)
    }
}

fn run_side_module(args: &Args) -> Result<()> {
    // Read the input bytes once and keep them around. We use walrus
    // only to *read* exports for the manifest — we DO NOT round-trip
    // the wasm through `emit_wasm_file`. Walrus places custom sections
    // after the standard sections during emission, but the WebAssembly
    // DynamicLinking spec requires `dylink.0` to appear BEFORE any
    // non-custom section. A walrus re-emit would silently demote a
    // valid wasm-ld --shared output into something the runtime loader
    // would refuse as "not a side module". Bytes-in / bytes-out keeps
    // the section ordering wasm-ld emitted.
    let bytes =
        std::fs::read(&args.input).with_context(|| format!("reading {}", args.input.display()))?;
    let module =
        Module::from_buffer(&bytes).with_context(|| format!("parsing {}", args.input.display()))?;

    let dylink = module
        .customs
        .iter()
        .find_map(|(_id, sec)| {
            if sec.name() == "dylink.0" {
                let raw = sec
                    .as_any()
                    .downcast_ref::<walrus::RawCustomSection>()?;
                Some(raw.data.clone())
            } else {
                None
            }
        })
        .ok_or_else(|| {
            anyhow!(
                "{} is missing the `dylink.0` custom section. \
                 yurt-cc -shared was supposed to emit one. \
                 Either the link did not pass --experimental-pic or the input is not a side module.",
                args.input.display()
            )
        })?;

    let info = side_module::parse_dylink_0(&dylink)
        .with_context(|| format!("parsing dylink.0 in {}", args.input.display()))?;

    let exports = side_module::collect_dynamic_exports(&module);

    let soname = args
        .soname
        .clone()
        .unwrap_or_else(|| side_module::soname_from_path(&args.input));

    let meta = side_module::Manifest {
        soname,
        exports,
        deps: info.needed,
        mem_size: info.mem_size,
        mem_align: info.mem_align,
        table_size: info.table_size,
        table_align: info.table_align,
    };

    let meta_path = args
        .meta_out
        .clone()
        .unwrap_or_else(|| default_meta_path(&args.output));

    side_module::write_manifest(&meta, &meta_path)
        .with_context(|| format!("writing {}", meta_path.display()))?;

    // Copy the input bytes verbatim to the output. When --output
    // equals --input (the in-place mode used by yurt-cc auto-postlink)
    // skip the write entirely — there is nothing to do, the bytes are
    // already on disk under the right name.
    if args.input != args.output {
        std::fs::write(&args.output, &bytes)
            .with_context(|| format!("writing {}", args.output.display()))?;
    }

    eprintln!(
        "yurt-wasi-postlink --side-module: wrote {} (+ {})",
        args.output.display(),
        meta_path.display()
    );
    Ok(())
}

fn default_meta_path(output: &Path) -> PathBuf {
    let mut s = output.as_os_str().to_owned();
    s.push(".yurtmeta.json");
    PathBuf::from(s)
}

fn run_shim_rewrite(args: &Args) -> Result<()> {
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
