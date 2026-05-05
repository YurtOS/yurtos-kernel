#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

source scripts/dev-init.sh

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required runtime: $1" >&2
    exit 1
  fi
}

require deno
require node
require bun
require wasmtime
require wasmer

echo "==> Runtime versions"
deno --version | head -n 1
node --version
bun --version
wasmtime --version
wasmer --version

echo "==> Build TypeScript package"
deno task build:ts

echo "==> Node JS-host smoke"
node scripts/smoke-js-engine.mjs

echo "==> Bun JS-host smoke"
# Bun currently lacks JSPI. The basic resident bash path must pass; async
# pipe/waitpid subprocess paths are reported as known gaps until the asyncify
# fallback reaches parity.
YURT_ALLOW_KNOWN_BUN_ASYNC_GAPS=1 bun scripts/smoke-js-engine.mjs

echo "==> Wasmtime WASI smoke"
wasmtime run packages/kernel/src/platform/__tests__/fixtures/true-cmd.wasm
WASMTIME_OUT="$(wasmtime run packages/kernel/src/platform/__tests__/fixtures/hello.wasm)"
test "$WASMTIME_OUT" = "hello from wasm"

echo "==> Wasmer WASI smoke"
wasmer run packages/kernel/src/platform/__tests__/fixtures/true-cmd.wasm
WASMER_OUT="$(wasmer run packages/kernel/src/platform/__tests__/fixtures/hello.wasm)"
test "$WASMER_OUT" = "hello from wasm"

if [ "${YURT_RUNTIME_FULL:-0}" = "1" ]; then
  echo "==> Wasmtime SDK server integration"
  bash scripts/build-sdk-server.sh
  SERVER_BINARY=dist/yurt-server deno test -A --no-check packages/integration-tests/tests/
else
  echo "==> Skipping full Wasmtime SDK integration (set YURT_RUNTIME_FULL=1 to run)"
fi

cat <<'MSG'
==> Runtime engine smoke complete

Coverage note:
- Node and Bun execute the TypeScript kernel package as JS hosts.
- Wasmtime and Wasmer run plain WASI canaries directly.
- Wasmtime SDK-server integration is available with YURT_RUNTIME_FULL=1.
- There is no Wasmer SDK-server backend yet; add one before treating Wasmer as
  full-kernel coverage.
MSG
