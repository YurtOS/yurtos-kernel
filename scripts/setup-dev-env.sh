#!/usr/bin/env bash
#
# Bootstrap a developer environment for yurtos-kernel on macOS or Linux.
#
# Idempotent — re-running is safe. Designed for cloud dev boxes
# (CodeSpaces, devcontainers, fresh CI runners) and local first-time
# setup. Installs:
#
#   - Rust toolchain (the version pinned in rust-toolchain.toml or the
#     fallback below) plus the wasm32-wasip1 target.
#   - Deno (for the TypeScript microkernel tests).
#   - wabt (provides wat2wasm; needed by the Deno backend tests).
#   - wasm-tools (used to inspect kernel.wasm imports/exports).
#   - pre-commit (the hooks the repo uses).
#
# Skips anything already present at the right version. Prints clear
# notes when a manual step is needed (e.g. missing sudo on Linux).
#
# Usage:
#   scripts/setup-dev-env.sh           # install everything
#   scripts/setup-dev-env.sh --check   # report status without installing

set -euo pipefail

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUST_TOOLCHAIN_FALLBACK="1.95.0"
DENO_VERSION="2.x"

# ── Pretty printing ────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_OFF=""
fi

info()  { printf '%s[info]%s %s\n' "$C_INFO" "$C_OFF" "$*"; }
ok()    { printf '%s[ ok ]%s %s\n' "$C_OK"   "$C_OFF" "$*"; }
warn()  { printf '%s[warn]%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
err()   { printf '%s[err ]%s %s\n' "$C_ERR"  "$C_OFF" "$*" >&2; }
step()  { printf '\n%s== %s ==%s\n' "$C_INFO" "$*" "$C_OFF"; }

# ── Platform detection ─────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      err "unsupported OS: $OS"; exit 1 ;;
esac

LINUX_PKG_MGR=""
if [[ "$PLATFORM" == "linux" ]]; then
  if   command -v apt-get >/dev/null 2>&1; then LINUX_PKG_MGR="apt"
  elif command -v dnf      >/dev/null 2>&1; then LINUX_PKG_MGR="dnf"
  elif command -v pacman   >/dev/null 2>&1; then LINUX_PKG_MGR="pacman"
  elif command -v apk      >/dev/null 2>&1; then LINUX_PKG_MGR="apk"
  fi
fi

# Sudo wrapper: use sudo only if we're not root and it's available.
if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

# ── Helpers ────────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }

install_pkg() {
  local pkg="$1"
  if $CHECK_ONLY; then
    warn "would install: $pkg"
    return
  fi
  case "$PLATFORM:$LINUX_PKG_MGR" in
    macos:*)
      if ! have brew; then
        err "Homebrew not installed. Install from https://brew.sh and re-run."
        exit 1
      fi
      brew install "$pkg"
      ;;
    linux:apt)    $SUDO apt-get update -y && $SUDO apt-get install -y "$pkg" ;;
    linux:dnf)    $SUDO dnf install -y "$pkg" ;;
    linux:pacman) $SUDO pacman -S --noconfirm "$pkg" ;;
    linux:apk)    $SUDO apk add --no-cache "$pkg" ;;
    *) err "no known package manager on this Linux"; exit 1 ;;
  esac
}

# ── Rust toolchain ─────────────────────────────────────────────────────────

step "Rust toolchain"

if ! have rustup; then
  if $CHECK_ONLY; then
    warn "rustup not installed; would install via https://sh.rustup.rs"
  else
    info "installing rustup..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    # shellcheck disable=SC1090
    source "${CARGO_HOME:-$HOME/.cargo}/env"
  fi
fi

if have rustc; then
  ok "rustc: $(rustc --version)"
fi

# Pin the toolchain version. Prefer rust-toolchain.toml if present.
if [[ -f "$REPO_ROOT/rust-toolchain.toml" ]]; then
  ok "using rust-toolchain.toml"
  $CHECK_ONLY || (cd "$REPO_ROOT" && rustup show >/dev/null)
elif have rustup; then
  current="$(rustup show active-toolchain 2>/dev/null | awk '{print $1}' || true)"
  if [[ "$current" != *"$RUST_TOOLCHAIN_FALLBACK"* ]]; then
    if $CHECK_ONLY; then
      warn "active toolchain is '$current'; expected $RUST_TOOLCHAIN_FALLBACK"
    else
      info "installing Rust $RUST_TOOLCHAIN_FALLBACK..."
      rustup toolchain install "$RUST_TOOLCHAIN_FALLBACK"
      rustup default "$RUST_TOOLCHAIN_FALLBACK"
    fi
  else
    ok "Rust $RUST_TOOLCHAIN_FALLBACK active"
  fi
fi

# wasm32-wasip1 target
if have rustup; then
  if rustup target list --installed 2>/dev/null | grep -q '^wasm32-wasip1$'; then
    ok "wasm32-wasip1 target installed"
  else
    if $CHECK_ONLY; then
      warn "wasm32-wasip1 target missing; would install"
    else
      info "installing wasm32-wasip1 target..."
      rustup target add wasm32-wasip1
    fi
  fi
fi

# clippy + rustfmt come bundled, but be paranoid:
if have rustup && ! $CHECK_ONLY; then
  rustup component add clippy rustfmt >/dev/null 2>&1 || true
fi

# ── Deno ───────────────────────────────────────────────────────────────────

step "Deno"

if have deno; then
  ok "deno: $(deno --version | head -1)"
elif $CHECK_ONLY; then
  warn "deno not installed; would install via https://deno.land/install.sh"
else
  info "installing Deno..."
  curl -fsSL https://deno.land/install.sh | sh -s -- --no-modify-path -y
  if [[ -x "$HOME/.deno/bin/deno" ]]; then
    ok "deno installed at $HOME/.deno/bin/deno"
    warn "add ~/.deno/bin to PATH (e.g. in ~/.zshrc or ~/.bashrc)"
  fi
fi

# ── wabt (provides wat2wasm) ───────────────────────────────────────────────

step "wabt (wat2wasm)"

if have wat2wasm; then
  ok "wat2wasm: $(wat2wasm --version)"
else
  install_pkg wabt
fi

# ── wasm-tools ─────────────────────────────────────────────────────────────

step "wasm-tools"

if have wasm-tools; then
  ok "wasm-tools: $(wasm-tools --version)"
else
  if $CHECK_ONLY; then
    warn "wasm-tools missing; would install via cargo install"
  elif have cargo; then
    info "installing wasm-tools via cargo (this may take a few minutes)..."
    cargo install --locked wasm-tools
  else
    warn "cargo not available; install Rust first, then re-run."
  fi
fi

# ── pre-commit ─────────────────────────────────────────────────────────────

step "pre-commit"

if have pre-commit; then
  ok "pre-commit: $(pre-commit --version)"
elif $CHECK_ONLY; then
  warn "pre-commit not installed"
else
  case "$PLATFORM" in
    macos)        install_pkg pre-commit ;;
    linux:apt|linux:dnf|linux:pacman|linux:apk) install_pkg pre-commit ;;
    *)
      if have pip3; then
        pip3 install --user pre-commit
      else
        warn "install pre-commit manually (https://pre-commit.com)"
      fi
      ;;
  esac
fi

if have pre-commit && [[ -f "$REPO_ROOT/.pre-commit-config.yaml" ]] && ! $CHECK_ONLY; then
  if [[ -d "$REPO_ROOT/.git" ]] && [[ ! -f "$REPO_ROOT/.git/hooks/pre-commit" ]]; then
    info "registering pre-commit hooks..."
    (cd "$REPO_ROOT" && pre-commit install --hook-type pre-commit --hook-type pre-push)
  fi
fi

# ── Final smoke check ──────────────────────────────────────────────────────

step "Smoke check"

missing=0
for tool in rustc cargo rustup deno wat2wasm; do
  if have "$tool"; then
    ok "$tool present"
  else
    err "$tool missing"
    missing=$((missing + 1))
  fi
done

if [[ $missing -gt 0 ]]; then
  err "$missing tool(s) missing — re-run without --check to install."
  exit 1
fi

ok "dev environment is ready."
echo
info "next steps:"
echo "  cargo test -p yurt-kernel-wasm --lib"
echo "  cargo test -p yurt-runtime-wasmtime --test kernel_wasm_trampoline"
echo "  deno test --allow-read --allow-env --allow-run packages/microkernel-deno/"
