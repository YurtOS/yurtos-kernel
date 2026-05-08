# yurt-cc Drop-In C Compiler Compatibility Design

**Status:** Draft
**Date:** 2026-05-08
**Scope:** Make `yurt-cc` a drop-in replacement for wasi-sdk `clang` when building target-side C and C dependencies for `wasm32-wasip1` Yurt guests.

## Problem

Yurt packages need one target C compiler: `yurt-cc`. A caller should be able to take upstream C build machinery and replace the compiler command with `yurt-cc`:

```bash
CC=/path/to/yurt-cc
AR=/path/to/yurt-ar
RANLIB=/path/to/yurt-ranlib
```

or, for Cargo build scripts:

```bash
CC_wasm32_wasip1=/path/to/yurt-cc
AR_wasm32_wasip1=/path/to/yurt-ar
RANLIB_wasm32_wasip1=/path/to/yurt-ranlib
```

The source code should remain unmodified. Package-specific workarounds such as "use wasi-sdk clang for dependencies, but yurt-cc for final Yurt code" are toolchain bugs in disguise. If C code can be compiled for `wasm32-wasip1` with wasi-sdk `clang`, then `yurt-cc` should compile it with the same source and the same package build flags, while adding Yurt's required target, ABI, and post-link behavior.

The current failure appears in the `zstd-sys` dependency path while building the `pkg` crate through `cargo-yurt`. `zstd-sys` automatically adds its `wasm-shim/` include directory for wasm targets. With `CC_wasm32_wasip1=yurt-cc`, the build fails around standard header compatibility: the package's shim headers, wasi-sdk headers, and Yurt compatibility headers do not compose under the include order emitted by the build.

The exact root cause still needs to be established from the failing compiler invocation. Plausible causes include a header collision in the `#include_next` chain, wrapper-forced compile flags such as `-std=gnu23` or `-Wall`/`-Wextra`, and current include path ordering. The implementation must start by capturing the real `zstd-sys` compile command and comparing the same package-provided invocation under wasi-sdk `clang` and `yurt-cc`.

This is exactly the kind of dependency build `yurt-cc` must support. zstd should not need source patches, feature changes, or a compiler bypass.

## Goals

- `yurt-cc` is the normal target C compiler for arbitrary Yurt package builds.
- Unmodified upstream C packages build by changing the compiler tools, not their sources.
- Rust `cc-rs` and `*-sys` dependencies can use `CC_wasm32_wasip1=yurt-cc`.
- `yurt-cc` preserves wasi-sdk clang's standard header semantics unless Yurt intentionally implements a compatible extension.
- `yurt-cc` can be used as `CC` or `CC_wasm32_wasip1` without callers knowing about `YURT_CC_INCLUDE`.
- Yurt compatibility headers compose with package-local shim headers such as `zstd-sys/wasm-shim`.
- Final links still inject the Yurt ABI archive, wrapped symbols, exports, pre-opt preservation, and `wasm-opt` processing.
- The first acceptance case is the real failing zstd dependency build, backed by smaller regression tests that explain the failure.

## Non-Goals

- Claiming Yurt implements every POSIX or Linux runtime behavior. Some programs may compile and link but fail at runtime because the sandbox intentionally lacks an OS feature.
- Patching third-party C packages to understand Yurt.
- Teaching `cargo-yurt` to become a package manager.
- Replacing wasi-sdk headers or libc with a Yurt-owned libc.
- Making curated C-port Makefiles the compatibility model for generic dependency builds. Curated ports may pass extra flags, but generic packages must not depend on those local conventions.

## Compatibility Contract

`yurt-cc` is a compiler driver wrapper, not a separate C dialect.

For compile-only invocations, replacing wasi-sdk `clang` with `yurt-cc` must only add the target, sysroot, and transparent Yurt compatibility include path needed for Yurt's wasm target. It must not introduce default language, warning, optimization, or include-order behavior that would make otherwise valid package C code fail.

For final links, `yurt-cc` adds the Yurt ABI archive and required linker framing. Link injection is independent of whether a source file includes Yurt compatibility headers.

There are three useful classes of failure:

- **Wrapper bug:** the same source and package flags compile with wasi-sdk `clang` but fail with `yurt-cc`. This includes header collisions, forced warnings, forced language standards, and unsupported compiler queries.
- **Runtime/API gap:** the code expects a POSIX/Linux API that Yurt does not implement. The right fix is either implement the API with a tested Yurt contract or document it as unsupported. Source patches remain a last resort for package porting, not the default path.
- **Package/toolchain mismatch:** the package relies on a compiler feature or target unrelated to wasi-sdk clang compatibility. This should be diagnosed clearly.

## Design

### 1. Keep Wrapper-Owned Compile Flags Minimal

`yurt-cc` should own only the flags required to select the target toolchain:

- `--target=wasm32-wasip1`
- `--sysroot=<wasi-sdk sysroot>`
- Yurt compatibility include path handling in a clang-compatible form
- Yurt-specific defines only when they are required for the ABI mode selected by the caller

The wrapper should not force `-std=gnu23`, `-Wall`, `-Wextra`, or `-O2` for arbitrary package builds. Those flags change source compatibility and diagnostics. A package that enables `-Werror`, expects an older C mode, probes compiler flags through `cc-rs`, or depends on debug-friendly optimization behavior should see the package's requested clang behavior.

Curated Yurt C ports that need stricter warnings, a newer C mode, or optimization should pass those flags in their Makefiles.

The migration must inventory every curated port or ABI build that currently relies on wrapper-injected `-std=gnu23`, `-Wall`, `-Wextra`, or `-O2`. For each affected Makefile, move the required flags into that build and verify the result with the existing smoke target. For ABI and canary artifacts, compare exported symbols and run the existing conformance smoke checks after the migration; object byte-for-byte equivalence is not required, but missing exports, unexpected wrapped symbols, and obvious size regressions should be investigated.

### 2. Provide The Compatibility Include Path By Default

Generic builds must not need to know about `YURT_CC_INCLUDE`. `yurt-cc` should discover its installed Yurt compatibility include directory and add it automatically.

The default include order should preserve package intent:

1. User-provided include directories and compiler arguments, in the order the package passed them.
2. Yurt's transparent compatibility include directory.
3. The wasi-sdk sysroot headers.

The implementation must not simply prepend Yurt's include path before user arguments. It should either parse and preserve user `-I`/`-isystem` ordering before inserting Yurt's compatibility directory, or use a clang-supported mechanism such as `-idirafter` when that gives the desired "after user includes, before sysroot" behavior for this target.

This means a package shim such as `zstd-sys/wasm-shim/time.h` gets first chance when the package asks for it. If that shim uses `#include_next`, it should then reach Yurt's compatibility header, and Yurt's compatibility header should use `#include_next` to reach wasi-sdk. If a package shim does not include the next header, Yurt's standard-name header may be bypassed for that translation unit; that is acceptable only if the package shim is self-contained. Yurt must not depend on every translation unit observing its standard-name headers.

`YURT_CC_INCLUDE` remains an explicit override for curated ports and local experiments. When it is set, `yurt-cc` uses that include directory and does not also inject the discovered default include directory; duplicating equivalent Yurt standard-name headers breaks `#include_next` chains. `YURT_CC_INCLUDE` is not part of the generic package contract. A caller who only sets `CC=yurt-cc` or `CC_wasm32_wasip1=yurt-cc` should get the supported default behavior. Validation should explicitly clear `YURT_CC_INCLUDE` for generic-package tests so the result proves the default path, not ambient shell state.

### 3. Make Compatibility Headers Transparent

Yurt may provide headers with standard names such as `stdio.h`, `time.h`, and `unistd.h` only when they behave as compatible extensions to wasi-sdk headers.

Rules for standard-name compatibility headers:

- Include the upstream wasi-sdk header first with `#include_next` where an upstream header exists.
- Never redefine upstream types such as `clock_t`, `FILE`, `size_t`, or structs already owned by wasi-libc.
- Add declarations only after the upstream header has exposed the required types.
- Guard additions against upstream wasi-libc evolution so a future wasi-sdk update does not create duplicate declarations.
- Do not assume Yurt's include directory is the only include directory before the sysroot. Package-local shim directories can appear before or after it.

If a declaration cannot safely live in a standard-name header under arbitrary package include ordering, move it to an explicit Yurt header such as `yurt/compat.h` or `yurt/posix.h`. Curated ports can include that header directly; generic upstream packages should not have to.

If the `zstd-sys` failure turns out to be caused by package shim and Yurt header interaction, the preferred fix is to make Yurt's standard-name header more defensive. Patching `zstd-sys` is not the default fix. Include reordering in `yurt-cc` is acceptable only if it follows the default include-order contract above and still preserves package-provided `-I` order.

### 4. Treat zstd-sys As The First Acceptance Case

The real `zstd-sys` build is the compatibility canary. Its build script adds `wasm-shim/` for wasm targets and compiles bundled C through `cc-rs`. The acceptance requirement is:

- Build the relevant Rust crate with `CC_wasm32_wasip1=yurt-cc`.
- Do not change zstd source.
- Do not disable zstd's wasm shim as a workaround.
- Do not bypass `yurt-cc` for dependency C compilation.

The implementation plan must include an explicit discovery phase:

1. Capture the failing `zstd-sys` compile command and environment from the `pkg` build.
2. Replay the same package-provided source and flags under wasi-sdk `clang`.
3. Replay them under `yurt-cc`.
4. Identify whether the first divergence is header lookup, wrapper-injected flags, archive validation, linker framing during a compile/probe invocation, or another wrapper behavior.
5. Fix the wrapper or Yurt compatibility headers according to that root cause.

### 5. Keep Archive Validation And Link Injection Out Of Compile/Probe Invocations

`YURT_CC_ARCHIVE` points at the Yurt ABI archive, usually `abi/build/libyurt_abi.a`. On final link invocations, `yurt-cc` validates that archive, frames it with `--whole-archive`, injects wrapped symbols and exports, optionally preserves the pre-optimized wasm, and runs the configured `wasm-opt` step.

For C object compilation and compiler probes, the archive must be irrelevant even if `YURT_CC_ARCHIVE` is inherited in the environment. `yurt-cc` must skip archive lookup, archive version validation, linker argument injection, pre-opt preservation, and `wasm-opt` for:

- `-c`
- `-E`
- `-S`
- `-r`
- `--relocatable`
- clang query/probe invocations that do not produce a final linked artifact

The mechanical boundary is output intent, not just the absence of `-c`. `yurt-cc` should classify an invocation as a Yurt final link only when it is producing a wasm artifact intended to run under Yurt. Obvious compile/preprocess/assembly/relocatable modes are never final links. Query-only invocations are never final links.

Link-shaped configure probes are the hard case because they compile and link a tiny executable without `-c`. The implementation must provide an explicit probe opt-out, `YURT_CC_NO_LINK_INJECTION=1`, that makes these invocations behave like wasi-sdk clang: no archive validation, no ABI archive injection, and no `wasm-opt`. `cargo-yurt` should use that opt-out for dependency build-script C compilers if it exports `CC_wasm32_wasip1` automatically in the future. Plain Make/configure users can set it during configure checks and unset it for the final program link. Regression tests must cover both states.

This keeps the contract simple: package build systems choose `yurt-cc` as the compiler, and `yurt-cc` handles Yurt-specific linking when a final linked wasm artifact is being produced.

### 6. Support Compiler Probe Behavior

Build systems such as `cc-rs`, autoconf, and Makefiles frequently run compiler probes. `yurt-cc` should pass through ordinary clang query and probe invocations without surprising side effects.

Wrapper-reserved flags are the small `yurt-cc` control surface and are consumed by the wrapper: `--dry-run`, `--print-sdk-path`, and `--version`. All other flags should be forwarded to clang with their relative order preserved, except where the wrapper deliberately inserts target/sysroot/default include/link defaults according to this design. In particular, user include flags must remain before the default Yurt compatibility include path. If a future wrapper flag is added, it must be documented here and covered by a parser test so clang pass-through behavior does not change accidentally.

Probe/query examples:

- `--version`: print `yurt-cc <version>` on the first line and include the underlying clang `--version` output after it, so humans see both and parsers that look for clang still find it.
- `-v`
- `-E`
- `-S`
- `-c`
- `-print-search-dirs`
- package flag-support tests

Probe failures should match wasi-sdk clang unless the probe asks for behavior outside the Yurt target.

## Validation

### Real Dependency Acceptance

Add a small workspace fixture crate, `test-fixtures/zstd-sys-smoke`, that depends on the same `zstd-sys` path that currently fails. The fixture exists only to exercise dependency C compilation through `cc-rs`; it does not need meaningful runtime behavior.

```bash
env -u YURT_CC_INCLUDE \
CC_wasm32_wasip1=target/release/yurt-cc \
AR_wasm32_wasip1=target/release/yurt-ar \
RANLIB_wasm32_wasip1=target/release/yurt-ranlib \
YURT_CC_ARCHIVE=abi/build/libyurt_abi.a \
target/release/cargo-yurt build --release -p zstd-sys-smoke
```

Expected: `zstd-sys` compiles through `yurt-cc` without source patches, feature workarounds, or direct wasi-sdk clang bypass.

After the focused fixture passes, run the original end-to-end path: build `yurt-pkg`'s `pkg` crate through `cargo-yurt` with `YURT_CC_INCLUDE` cleared, `CC_wasm32_wasip1=target/release/yurt-cc`, `AR_wasm32_wasip1=target/release/yurt-ar`, and `RANLIB_wasm32_wasip1=target/release/yurt-ranlib`. Expected: the original zstd failure is gone. Later dependency failures may be tracked separately if they are not `yurt-cc` wrapper regressions, but the original `pkg` path must be part of acceptance.

### Focused Regression Tests

Add small tests in `abi/toolchain/yurt-toolchain` for the bug class:

1. **Flag neutrality dry run**

   A `yurt-cc --dry-run -c foo.c` compile invocation includes target/sysroot but does not inject `-std=gnu23`, `-Wall`, `-Wextra`, or `-O2` unless the user passed them.

2. **Default include discovery and ordering dry run**

   Run `env -u YURT_CC_INCLUDE yurt-cc --dry-run -c -I package/include foo.c`. Expected: the discovered Yurt compatibility include path is present without `YURT_CC_INCLUDE`, `-I package/include` appears before the Yurt include path, and the Yurt include path resolves before the wasi-sdk sysroot headers.

3. **Standard header composition**

   Compile a source through `yurt-cc -c` that includes:

   ```c
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
   ```

   Expected: succeeds with Yurt compatibility headers available. The test intentionally exercises declarations Yurt adds on top of wasi-libc, including `tzset`, `flockfile`, and `funlockfile`, so future duplicate or missing declarations fail visibly.

4. **zstd-like shim include ordering**

   Compile a minimal fixture with a local `wasm-shim/` include directory in both relevant orders:

   - package shim before Yurt compatibility headers, matching the default `yurt-cc` contract for user `-I` directories
   - Yurt compatibility headers before package shim, matching legacy or explicit `YURT_CC_INCLUDE` ordering that curated ports or local scripts may still exercise

   The fixture should model the include ordering used by `zstd-sys`, including a shim standard header and downstream includes that eventually reach wasi-sdk/Yurt headers.

   Expected: no type redefinitions, missing standard types, or duplicate declarations.

5. **cc-rs probe compatibility**

   Add dry-run or subprocess coverage for common compile and probe shapes used by `cc-rs`: compile-only, preprocess-only, and flag support checks. Expected: no archive validation, no link injection during compile/probe steps, and no wrapper-only warnings or language-mode failures.

6. **Inherited archive compile-only test**

   Run `yurt-cc -c` and `yurt-cc -E` with `YURT_CC_ARCHIVE` pointing at a missing or deliberately invalid path. Expected: compile/probe invocations do not inspect the archive and fail only if clang itself fails.

7. **Link-shaped probe test**

   Run a configure-style compiler probe that compiles and links a tiny source without `-c`, with `YURT_CC_ARCHIVE` set to a missing or deliberately invalid path. Expected:

   - without `YURT_CC_NO_LINK_INJECTION=1`, Yurt final-link behavior applies and the invalid archive is reported
   - with `YURT_CC_NO_LINK_INJECTION=1`, probe behavior matches wasi-sdk clang, the archive is not inspected, and no Yurt link framing or `wasm-opt` runs

## Migration

- Remove default wrapper-injected compile policy flags from `yurt-cc`: `-std=gnu23`, `-Wall`, `-Wextra`, and `-O2`. Move any required warning, optimization, or language-standard choices into curated port Makefiles.
- Inventory curated C builds under `abi/` and `test-fixtures/c-ports/` for reliance on those flags, then run their existing smoke/conformance targets after migration.
- Make `yurt-cc` discover and inject the default Yurt compatibility include directory without requiring `YURT_CC_INCLUDE`.
- Audit Yurt standard-name headers for transparent extension behavior under arbitrary include ordering.
- Move unsafe or non-transparent declarations into explicit `yurt/...` headers.
- Keep existing curated C ports working by adding explicit Makefile flags or includes where those ports relied on wrapper side effects.
- Update docs to state the supported package contract: replace `clang` with `yurt-cc`; do not patch source or bypass the wrapper unless a package requires unsupported runtime semantics.

## Open Questions

- Should `cargo-yurt` automatically set `CC_wasm32_wasip1`, `AR_wasm32_wasip1`, and `RANLIB_wasm32_wasip1` for dependency builds once this contract is validated?
- Should `yurt-conf` expose a `shellenv` command that prints the recommended compiler environment for non-Cargo package builds?
