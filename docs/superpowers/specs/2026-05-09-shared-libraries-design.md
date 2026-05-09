# Shared Libraries Design (Phase 1: Contract + Base Implementation)

**Status:** Draft
**Date:** 2026-05-09
**Scope:** Define the guest-visible shared-library contract for YurtOS and a
correct (unoptimized) base implementation that works identically across all
supported WASM backends — Wasmtime, Deno/Node, and browsers (Safari, Chrome).
Performance optimizations specific to Wasmtime are explicitly out of scope
for this phase.

## Problem

YurtOS today has no notion of shared libraries. Every guest is a single
self-contained `.wasm` produced by `yurt-cc` linking `libyurt_abi.a` with
`--whole-archive` ([`abi/README.md:31`](../../../abi/README.md) lists "shared
libraries" as deferred). Each sandbox compiles its module fresh and holds a
private linear memory.

This blocks two distinct scenarios:

1. **Library reuse inside a guest.** A C program cannot `dlopen` a separately
   compiled extension at run time; an interpreter cannot ship as a small core
   plus loadable native modules; ports such as Python or perl cannot keep
   their familiar dynamic-extension architecture.
2. **Memory amortization across sandboxes.** Hundreds of sandboxes loading
   the same Python.WASM cannot share a single physical copy of the
   interpreter's code or initial heap.

The two scenarios are independent. The contract — what an application
running inside a sandbox sees — is the user-facing ABI surface and is
expensive to change once code is shipped. The cross-sandbox memory
amortization is host-internal and runtime-specific. They must be sequenced
**contract-first**, and that is what this document specifies.

A separate spec will address the host-side optimizations (compiled-module
deduplication, AOT cache, pooling allocator, CoW initial memory, and
sandbox snapshots). Those optimizations are scoped to Wasmtime; the
contract defined here is observable identically on every backend.

## Goals

- Pin a guest-visible contract for shared libraries that is observably
  identical on Wasmtime, Deno/Node, and browser WebAssembly.
- Ride existing wasi-sdk / `wasm-ld` infrastructure: side modules are
  produced via `wasm-ld --shared --experimental-pic`, with the
  `dylink.0` custom section as the on-the-wire metadata format.
- Provide a narrow `dlfcn.h` surface (`dlopen`, `dlsym`, `dlclose`,
  `dlerror`) backed by a small set of host imports in the `yurt`
  namespace.
- Define a deterministic library search path (RPATH, `LD_LIBRARY_PATH`,
  default directories) that uses VFS symlinks for SONAME resolution.
- Keep the existing static-link path (`--whole-archive` on
  `libyurt_abi.a`) working unchanged. Programs without `-shared` are
  unaffected.
- Dogfood the contract by porting at least one self-contained chunk of
  `libyurt_abi.a` to a side module before exposing third-party libraries.

## Non-Goals

- Performance work of any kind. Module deduplication, AOT caching,
  pooling allocator, CoW initial memory, and sandbox snapshots are
  Wasmtime-specific optimizations and live in a follow-up spec.
- Component Model dynamic composition. Component Model is the long-term
  successor; revisit when WASI 0.3 lands.
- Full POSIX `dlfcn` semantics. We commit to the four functions listed
  above, not to `RTLD_NEXT`, `dladdr`, `dlinfo`, or audit hooks.
- TLS in side modules. `__tls_base` exists in `dylink.0` but YurtOS's
  pthread surface is intentionally narrow (`abi/README.md:166`); side
  modules with non-trivial TLS fail at load with `EINVAL`.
- A package-manager story for shared libraries. Distribution lives in
  the existing yurtpkg format
  ([`docs/superpowers/specs/2026-05-05-yurt-package-format-design.md`](2026-05-05-yurt-package-format-design.md));
  this spec only defines the runtime contract.

## Module Shape

YurtOS adopts the wasi-sdk / clang `dylink.0` custom-section convention.

### Main module (PIE)

A position-independent main module:

- imports `env.memory`, `env.__indirect_function_table`,
  `env.__memory_base` (i32, mutable), `env.__table_base` (i32, mutable),
  `env.__stack_pointer` (i32, mutable);
- exports `__wasm_call_ctors`, `__wasm_apply_data_relocs`, `__alloc`,
  `__dealloc` (the existing YurtOS shell exports remain valid);
- declares no `dylink.0` section unless it itself participates in dynamic
  linking with relocated globals.

Programs built without `-shared` and without `-fPIC` continue to produce
non-PIE main modules and skip the loader entirely. Static guests are
unaffected.

### Side module

A side module:

- carries a `dylink.0` custom section declaring its `mem_size`,
  `mem_align`, `table_size`, `table_align`, and required dependencies;
- exports its dynamic symbols (functions and globals) by their unmangled
  C names;
- exports `__wasm_call_ctors` (run after relocations) and
  `__wasm_apply_data_relocs` (applies relocations into its reserved
  memory region);
- imports `env.memory`, `env.__indirect_function_table`,
  `env.__memory_base`, `env.__table_base` from the host loader.

The Yurt-specific subsection of `dylink.0` carries a SONAME string. If
the upstream linker drops unrecognized subsections in a future toolchain
revision, the SONAME falls back to the file basename (without trailing
version suffixes).

## `dlfcn` API Surface

New public header `abi/include/dlfcn.h`:

```c
#define RTLD_LAZY   0x0001
#define RTLD_NOW    0x0002
#define RTLD_GLOBAL 0x0100
#define RTLD_LOCAL  0x0000

void *dlopen(const char *path, int flags);
void *dlsym(void *handle, const char *name);
int   dlclose(void *handle);
char *dlerror(void);
```

### Semantics

- `RTLD_LAZY` is treated as `RTLD_NOW`. WASM imports are resolved at
  instantiation; lazy binding does not exist on this platform. The flag
  is accepted for source compatibility.
- `RTLD_GLOBAL` makes the side module's exports visible to subsequent
  `dlopen` calls in the same sandbox (last-binder-wins on collisions).
- `RTLD_LOCAL` (the default when neither flag is set) keeps the side
  module's exports private to the handle returned.
- `dlopen` of an already-loaded SONAME bumps the existing handle's
  refcount and returns the same handle.
- `dlclose` decrements the refcount. Reaching zero drops the host-side
  instance. Reserved memory and table slots are **not** reclaimed —
  WebAssembly has no defragmentation. Programs that load and unload
  many distinct libraries in a long-lived sandbox will leak address
  space until the sandbox itself terminates. This is documented and
  matches Emscripten's behavior.
- `dlerror` returns a pointer to a thread-local message string and
  clears the per-thread error state. The pointer is valid until the
  next `dlfcn` call from the same thread.

### Error model

Errors propagate to the guest as `NULL` (`dlopen`/`dlsym`) or `-1`
(`dlclose`). The descriptive string is fetched via `dlerror`.
Categories:

| Cause | `dlerror` text prefix | Notes |
|---|---|---|
| Path not found | `"file not found: <path>"` | VFS lookup miss after search-path expansion |
| Not a side module | `"not a side module: <path>"` | Missing or invalid `dylink.0` |
| Unresolved symbol | `"undefined symbol: <name>"` | A required import has no provider |
| TLS not supported | `"TLS not supported"` | Side module has nontrivial TLS sections |
| Cycle in deps | `"dependency cycle: <soname>"` | Cycle detection in recursive load |
| Out of memory/table | `"out of memory"` / `"table exhausted"` | Guest `__alloc` or `Table::grow` failed |

## Library Search Path

Search order, highest priority first:

1. Absolute path passed to `dlopen` (no search performed).
2. `RPATH` baked into the main module via `wasm-ld --rpath`. Stored in
   the Yurt subsection of `dylink.0` for the main module.
3. `LD_LIBRARY_PATH` from the sandbox environment, colon-separated.
4. `/usr/local/lib`, `/lib`, `/usr/lib` in that order.

SONAME → versioned filename resolution uses VFS symlinks (already
supported per
[`docs/superpowers/specs/2026-05-05-yurt-package-format-design.md`](2026-05-05-yurt-package-format-design.md)):

```text
/lib/libsqlite.wasm        -> libsqlite.wasm.3
/lib/libsqlite.wasm.3      -> libsqlite.wasm.3.45
/lib/libsqlite.wasm.3.45   (regular file, the actual side module)
```

The loader follows symlinks and dedupes by canonical path: opening
`libsqlite.wasm` and `libsqlite.wasm.3.45` yields the same handle.

## Toolchain

`yurt-cc` (under `abi/toolchain/yurt-toolchain/`) gains two modes:

- `yurt-cc -fPIC -c foo.c -o foo.o` — relocatable PIC object via clang.
- `yurt-cc -shared -o libfoo.wasm foo.o ...` — drives
  `wasm-ld --shared --experimental-pic` to produce a side module. The
  driver injects YurtOS's standard linker framing and runs the
  `dylink.0` validator pass before declaring success.

`yurt-wasi-postlink` gains a `dylink.0` validator pass that:

- rejects malformed `dylink.0` sections;
- computes the Yurt SONAME (from the `-soname` flag or file basename);
- emits a sidecar manifest `libfoo.wasm.yurtmeta.json` with
  `{soname, exports, deps, mem_size, mem_align, table_size, table_align}`.

The existing static-link path (`--whole-archive` on `libyurt_abi.a`)
keeps working unchanged. Programs without `-shared` are unaffected.

## Loader Algorithm

The single ABI seam between guest and host is a small set of imports in
the `yurt` namespace, registered alongside the existing imports added by
`add_misc_imports` in
[`packages/runtime-wasmtime/src/wasm/mod.rs:977`](../../../packages/runtime-wasmtime/src/wasm/mod.rs).
The guest stubs in `abi/src/dlfcn.c` wrap these imports behind the
standard POSIX names declared above.

### Host imports

| Import | Signature (i32 unless noted) | Behavior |
|---|---|---|
| `yurt_dlopen` | `(path_ptr, path_len, flags) -> handle (i64)` | Resolve path, locate or compile side module, instantiate, return opaque handle. `0` on error. |
| `yurt_dlsym` | `(handle: i64, name_ptr, name_len) -> i32` | Look up `name` in the handle's exports; for functions, return their index in `__indirect_function_table`. `-1` on error. |
| `yurt_dlclose` | `(handle: i64) -> i32` | Decrement refcount. `0` on success, `-1` on error. |
| `yurt_dlerror` | `(out_ptr, out_cap) -> i32` | Copy the last error string into the guest buffer; return bytes written (or required, if `> out_cap`). `0` if no error. |

The handle is a host-side `u64` keyed into a per-sandbox handle table.
It is deliberately opaque to the guest.

### Instantiation algorithm

When `yurt_dlopen` fires:

1. Resolve `path` against the search path (§ Library Search Path).
2. Read side-module bytes from the sandbox VFS.
3. Parse the `dylink.0` section to learn `mem_size`, `mem_align`,
   `table_size`, `table_align`, dependencies.
4. Recursively `dlopen` dependencies. Detect cycles by SONAME.
5. Reserve a memory region by calling the guest's exported `__alloc`
   for `mem_size` bytes with the requested alignment. The returned
   pointer is the side module's `__memory_base`. (See
   [`packages/runtime-wasmtime/src/wasm/instance.rs:63`](../../../packages/runtime-wasmtime/src/wasm/instance.rs)
   — the existing YurtOS shell already exports `__alloc` for the same
   purpose.)
6. Reserve `table_size` slots in `__indirect_function_table` by growing
   the table. The returned base index is `__table_base`.
7. Build a per-load `Linker` whose imports resolve in priority order:
   - the main module's `memory` and `__indirect_function_table`;
   - already-loaded side modules' globally-visible exports
     (`RTLD_GLOBAL`-flagged or `RTLD_DEFAULT` resolution chain);
   - host-provided `__memory_base`/`__table_base`/`__stack_pointer`
     globals built fresh for this load;
   - the same `yurt`-namespace host imports the main module sees.
8. Instantiate the side module against this linker.
9. Call the side module's exported `__wasm_apply_data_relocs` to
   apply relocations into its reserved memory region.
10. Call `__wasm_call_ctors`.
11. Insert the resulting instance into the per-sandbox handle table;
    return the handle.

`dlsym` (step 0): look up the requested name in the handle's exports.
For function exports, return their `__indirect_function_table` index
(populated during instantiation). For data exports, return their
absolute address inside the reserved memory region. The caller casts
the returned i32 to a function pointer or data pointer in the standard
WASM PIC ABI.

`dlclose`: decrement refcount; on zero, drop the instance. The
reserved memory and table region are **not** returned to the pool
(see § Semantics).

## Backend Implementations

The algorithm above is runtime-agnostic. Each backend implements the
four host imports using its own engine APIs. The observable contract
must be identical.

### Wasmtime

- New module
  [`packages/runtime-wasmtime/src/wasm/dynlink.rs`](../../../packages/runtime-wasmtime/src/wasm/dynlink.rs)
  owns the per-sandbox handle table and implements the algorithm using
  `wasmtime::Linker::instantiate_async`, `wasmtime::Module::new`,
  `wasmtime::Table::grow`, and `wasmtime::TypedFunc`.
- Host imports registered in
  [`packages/runtime-wasmtime/src/wasm/mod.rs:977`](../../../packages/runtime-wasmtime/src/wasm/mod.rs)
  alongside the existing `yurt`-namespace imports.
- The handle table lives on `StoreData` so it shares the lifetime of
  the sandbox.

### Deno / Node

- New module under `packages/kernel/src/process/` mirrors the
  algorithm using `WebAssembly.Module`, `WebAssembly.Instance`,
  `WebAssembly.Table.prototype.grow`. The module-cache hook
  [`packages/kernel/src/process/module-cache.ts:25`](../../../packages/kernel/src/process/module-cache.ts)
  is reused for compiling side modules.
- Host imports registered alongside the existing `yurt`-namespace
  imports in the kernel's import-builder.

### Browsers (Safari, Chrome)

- The Deno/Node implementation is structured so that everything other
  than VFS access is portable. The browser path mounts the same VFS
  layer (already abstracted in `packages/kernel/src/`) and reuses the
  same loader. No browser-specific code is required beyond the
  existing platform adapter.
- `WebAssembly.compileStreaming` is **not** used because side modules
  arrive from the in-memory VFS, not over `fetch`.

## Dogfood Plan

To prove the contract end-to-end before exposing third-party libraries,
take a self-contained chunk of `libyurt_abi.a` and ship it as a side
module:

- Candidate: the `sched_*` affinity shims (`abi/src/yurt_sched.c`).
  They are small, self-contained, and have an existing canary
  (`affinity-canary`) so behavior is pinned.
- Build product: `/lib/libyurt_sched.wasm` with SONAME `libyurt_sched`.
- The static archive keeps a strong reference to the same symbols for
  back-compat. New main-module builds opt into the dynamic version
  via a `yurt-cc -lyurt_sched -shared-lib-prefer-dynamic` flag (exact
  spelling deferred to the implementation).
- Acceptance: `affinity-canary` rebuilt against the dynamic version
  passes the existing affinity spec
  ([`abi/conformance/sched_getaffinity.spec.toml`](../../../abi/conformance/sched_getaffinity.spec.toml))
  on all three backends.

This forces the toolchain, postlink, loader, and search-path code paths
to walk a real example before any externally distributed library is
involved.

## Testing

### Conformance canaries

New canaries under `abi/conformance/c/`:

- `dlopen-canary` — covers the happy path, `RTLD_NOW`/`RTLD_LAZY`
  equivalence, double-open refcount, missing path, missing symbol,
  bad-format file (not a side module).
- `dlsym-canary` — function lookup, data lookup, `RTLD_DEFAULT` chain
  through `RTLD_GLOBAL` opens.
- `dlclose-canary` — refcount, post-close `dlsym` failure, leak of
  reserved memory documented as expected.
- `rpath-canary` — RPATH > `LD_LIBRARY_PATH` > defaults precedence.

Each canary follows the existing pattern (see
[`abi/conformance/c/dup2-canary.c`](../../../abi/conformance/c/dup2-canary.c)
for the template) with `--list-cases` / `--case <name>` and JSONL
output.

A small companion side module `libyurt_dlcanary.wasm` lives under
`abi/conformance/c/` (built via `yurt-cc -shared`) and exports a
function `yurt_dlcanary_double(int32_t)` that returns its argument
times two. The dlopen canaries link against the main module only and
load this side module at run time.

### Spec files

A `.spec.toml` per canary documents the expected case names, exit
codes, errno values, and stdout invariants — same convention as the
existing specs (e.g.
[`abi/conformance/dup2.spec.toml`](../../../abi/conformance/dup2.spec.toml)).

### Test harness

- The Deno fast-tier test suite gains tests under
  [`packages/kernel/src/__tests__/abi_test.ts`](../../../packages/kernel/src/__tests__/abi_test.ts)
  exercising the dlopen canaries.
- A Rust test under `packages/runtime-wasmtime/tests/` exercises the
  same canaries against the Wasmtime backend.
- A browser smoke run under `packages/kernel/src/__tests__/` is
  deferred until the Phase 1 implementation slice lands; it follows
  the existing browser-platform-adapter pattern.

The Phase 1 implementation lands the canary sources and `.spec.toml`
files first, with the test suite entries skipped (`it.skip` / `#[ignore]`).
Each subsequent implementation slice (toolchain, headers, Wasmtime
loader, Deno loader) flips the relevant skips.

## Out of Scope (deferred to follow-up specs)

- Wasmtime-only optimizations: module deduplication via `Arc<Module>`,
  AOT on-disk cache, pooling allocator, CoW initial memory.
- Cross-sandbox interpreter snapshots (post-init Python heap as CoW
  initial image).
- Component Model dynamic composition.
- TLS in side modules.
- `dladdr`, `dlinfo`, `dlmopen`, audit hooks.

These will land in a separate spec once Phase 1 is shipped and the
contract is observably stable across all three backends.
