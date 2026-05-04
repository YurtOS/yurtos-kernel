#!/usr/bin/env bash
# Guest-compat implementation-signature check for every coreutils .wasm.
# Requires ./scripts/build-coreutils.sh --engine=cargo-yurt (default after
# step-4 task 3) to have populated target/wasm32-wasip1/release/coreutils-pre-opt/.
# §Verifying Precedence, §Package Validation Requirements.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$REPO_ROOT/packages/guest-compat/build/libyurt_guest_compat.a"
PRE_OPT_DIR="$REPO_ROOT/target/wasm32-wasip1/release/coreutils-pre-opt"
CPCHECK="$REPO_ROOT/target/release/cpcheck"

if [[ ! -d "$PRE_OPT_DIR" ]]; then
  echo "check-coreutils: pre-opt dir missing at $PRE_OPT_DIR" >&2
  echo "  run: ./scripts/build-coreutils.sh --engine=cargo-yurt" >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "check-coreutils: archive missing; run \`make -C packages/guest-compat lib\`" >&2
  exit 2
fi
if [[ ! -x "$CPCHECK" ]]; then
  echo "check-coreutils: cpcheck missing; run \`cargo build --release -p cpcc-toolchain\`" >&2
  exit 2
fi

# Binaries that live in the pre-opt dir but are NOT built through cargo-yurt
# and therefore intentionally lack the 16 Tier 1 guest-compat symbols:
#   - yurt-shell-exec: host-side shell runtime (exports __run_command etc.),
#     explicitly excluded in build-coreutils.sh. Not a consumer of the library.
#   - *-canary: conformance test programs from packages/guest-compat/conformance/
#     that probe individual syscall stubs and are NOT standard coreutils tools.
SKIP_PATTERN='yurt-shell-exec|affinity-canary|dup2-canary|getgroups-canary|signal-canary'

# SMOKE_ONLY=1 restricts the run to cat/grep/sort — the three representative
# binaries called out in the spec. CI (Task 8) runs the full suite; developers
# can opt into the fast path.
TARGETS=()
if [[ "${SMOKE_ONLY:-0}" == "1" ]]; then
  TARGETS=(cat grep sort)
else
  # Every pre-opt wasm produced by build-coreutils.sh, sorted for determinism.
  # Use a while-read loop (bash 3.2 compatible; mapfile requires bash 4+).
  # find -printf is GNU-only; use basename instead for macOS portability.
  while IFS= read -r line; do TARGETS+=("$line"); done < <(
    find "$PRE_OPT_DIR" -maxdepth 1 -name '*.pre-opt.wasm' \
    | xargs -n1 basename | sed 's/\.pre-opt\.wasm$//' \
    | grep -Ev "^($SKIP_PATTERN)$" | sort
  )
fi

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "check-coreutils: no pre-opt wasms found under $PRE_OPT_DIR" >&2
  exit 2
fi

echo "check-coreutils: running cpcheck over ${#TARGETS[@]} coreutils binaries"
fail_list=()
for tool in "${TARGETS[@]}"; do
  wasm="$PRE_OPT_DIR/$tool.pre-opt.wasm"
  if [[ ! -f "$wasm" ]]; then
    echo "  [MISS] $tool (expected $wasm)"
    fail_list+=("$tool:missing-preopt")
    continue
  fi
  if "$CPCHECK" --archive "$ARCHIVE" --pre-opt-wasm "$wasm" >/dev/null 2>&1; then
    printf '  [ OK ] %s\n' "$tool"
  else
    printf '  [FAIL] %s\n' "$tool"
    fail_list+=("$tool:cpcheck-failed")
  fi
done

if [[ "${#fail_list[@]}" -gt 0 ]]; then
  echo ""
  echo "check-coreutils: ${#fail_list[@]} binary/-ies failed:"
  printf '  - %s\n' "${fail_list[@]}"
  exit 1
fi

echo "check-coreutils: OK (${#TARGETS[@]} binaries, 16 symbols each)"
