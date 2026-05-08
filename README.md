# YurtOS Kernel

YurtOS Kernel is the sandbox runtime for running WASM guest programs with a
Yurt-owned process, filesystem, and syscall surface. The TypeScript kernel is
the main developer entry point today; Rust crates provide the native Wasmtime
runtime, ABI tooling, and guest fixture toolchain.

## Requirements

- Deno 2.x available as `deno` on `PATH`.
- Rust 1.95.0 or newer, with `wasm32-wasip1` for guest fixtures.
- Binaryen and WASI SDK for the full guest-compatibility fixture build.

For a quick TypeScript-only pass, Deno is enough. For the same fixture path CI
uses, install the Rust target first:

```bash
rustup target add wasm32-wasip1
```

## Quick Start

Run the interactive sandbox shell:

```bash
deno run --allow-read --allow-write --allow-run --allow-env packages/cli/src/cli.ts
```

Run one shell command in the default fixture-backed sandbox:

```bash
deno run --allow-read --allow-write --allow-run --allow-env packages/cli/src/cli.ts -c 'echo hello'
```

Create a repeatable `.yurtimg` from a `Yurtfile`:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/cli/src/cli.ts image build \
  -f Yurtfile \
  -o /tmp/generated.yurtimg
```

For one-off cases, `yurt image build` also accepts flags such as `--empty`,
`--copy`, `--chmod`, `--rm`, and `--run`. See [docs/images.md](docs/images.md)
for the full image guide.

Run a command from that image:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/cli/src/cli.ts /tmp/generated.yurtimg /bin/echo-args hello yurt
```

The image runner uses the `.yurtimg` as a read-only base filesystem and writes
runtime changes into an overlay upper layer.

## Building

Build the Rust workspace default members:

```bash
cargo build
```

Build the release toolchain crate used by the guest compatibility path:

```bash
cargo build --release -p yurt-toolchain
```

Build ABI and guest fixtures used by the broader smoke tests:

```bash
make -C abi all copy-fixtures
make -C test-fixtures/c-ports/busybox copy-fixtures
```

The TypeScript kernel is run directly with Deno. There is no npm build step.

## Test and Check

Rust checks:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --tests
```

Focused image-runtime Deno checks:

```bash
deno fmt --check \
  packages/kernel/src/image-loader.ts \
  packages/kernel/src/image-exporter.ts \
  packages/kernel/src/image-builder.ts \
  packages/kernel/src/vfs/tar-image-root-provider.ts \
  packages/kernel/src/__tests__/image-loader_test.ts \
  packages/kernel/src/__tests__/image-exporter_test.ts \
  packages/kernel/src/__tests__/image-builder_test.ts \
  packages/kernel/src/__tests__/sandbox-image_test.ts \
  packages/cli/src/__tests__/cli-image_test.ts \
  packages/cli/src/__tests__/cli-image-build_test.ts \
  packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts

deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run \
  packages/kernel/src/__tests__/image-loader_test.ts \
  packages/kernel/src/__tests__/image-exporter_test.ts \
  packages/kernel/src/__tests__/image-builder_test.ts \
  packages/kernel/src/__tests__/sandbox-image_test.ts \
  packages/cli/src/__tests__/cli-image_test.ts \
  packages/cli/src/__tests__/cli-image-build_test.ts \
  packages/kernel/src/vfs/__tests__/tar-image-root-provider_test.ts
```

The repository currently has some pre-existing repo-wide Deno format/lint debt,
so CI gates are scoped to the paths they can enforce today. See
[docs/contributing/gates.md](docs/contributing/gates.md) for the gate layout.

## More Docs

- [Creating and running Yurt images](docs/images.md)
- [Local gates and CI](docs/contributing/gates.md)
- [Native syscall ABI](docs/abi/native-syscall-abi.md)
