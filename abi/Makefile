# Build the kernel ABI runtime archive + Tier 1 canaries. Every
# toolchain invocation goes through one of the yurt-* binaries:
# objects are compiled with `yurt-cc -c`, archives assembled with
# `yurt-ar rcs`, canaries linked with `yurt-cc` (which --whole-archives
# libyurt_abi.a per §Override And Link Precedence).
#
# Targets:
#   make lib                  — build libyurt_abi.a
#   make canaries             — build every conformance/c/*-canary.wasm
#   make side-module-canaries — build Phase 1 shared-library side modules
#                               (NOT in `all` until slice 1C/1D land — see
#                               docs/superpowers/plans/2026-05-09-shared-libraries-phase1.md)
#   make all                  — lib + canaries
#   make copy-fixtures        — copy canary .wasm into the kernel fixtures dir
#   make clean

REPO_ROOT := $(shell cd .. && pwd)
FIXTURES := $(REPO_ROOT)/packages/kernel/src/platform/__tests__/fixtures
BUILD_DIR := build
INCLUDE := $(abspath include)
CANARY_DIR := conformance/c
YURT_CC := $(REPO_ROOT)/target/release/yurt-cc
YURT_AR := $(REPO_ROOT)/target/release/yurt-ar
DENO ?= deno

# yurt-cc itself stays package-neutral. These flags preserve the curated ABI
# build policy: gnulib-derived ports need C23 additions, and the ABI canaries
# keep the historical warning/optimization profile here.
YURT_CFLAGS := -O2 -std=gnu23 -Wall -Wextra
LIB := $(BUILD_DIR)/libyurt_abi.a
CONTINUATION_LIB := $(BUILD_DIR)/libyurt_continuation.a
SETJMP_LIB := $(BUILD_DIR)/libyurt_setjmp.a
LIB_OBJS := \
  $(BUILD_DIR)/yurt_command.o \
  $(BUILD_DIR)/yurt_cwd.o \
  $(BUILD_DIR)/yurt_dl_main.o \
  $(BUILD_DIR)/yurt_dlfcn.o \
  $(BUILD_DIR)/yurt_dup.o \
  $(BUILD_DIR)/yurt_exec.o \
  $(BUILD_DIR)/yurt_fetch.o \
  $(BUILD_DIR)/yurt_fnmatch.o \
  $(BUILD_DIR)/yurt_fs.o \
  $(BUILD_DIR)/yurt_ioctl.o \
  $(BUILD_DIR)/yurt_locale_rs.o \
  $(BUILD_DIR)/yurt_mman.o \
  $(BUILD_DIR)/yurt_mktemp.o \
  $(BUILD_DIR)/yurt_netdb.o \
  $(BUILD_DIR)/yurt_netif.o \
  $(BUILD_DIR)/yurt_pipe.o \
  $(BUILD_DIR)/yurt_poll.o \
  $(BUILD_DIR)/yurt_process.o \
  $(BUILD_DIR)/yurt_pthread.o \
  $(BUILD_DIR)/yurt_pthread_rs.o \
  $(BUILD_DIR)/yurt_resource.o \
  $(BUILD_DIR)/yurt_sched.o \
  $(BUILD_DIR)/yurt_select.o \
  $(BUILD_DIR)/yurt_sendfile.o \
  $(BUILD_DIR)/yurt_signal.o \
  $(BUILD_DIR)/yurt_socket.o \
  $(BUILD_DIR)/yurt_spawn.o \
  $(BUILD_DIR)/yurt_sysinfo.o \
  $(BUILD_DIR)/yurt_time.o \
  $(BUILD_DIR)/yurt_tty.o \
  $(BUILD_DIR)/yurt_unistd.o \
  $(BUILD_DIR)/yurt_version.o \
  $(BUILD_DIR)/yurt_write.o

CANARY_NAMES := stdio sleep system popen affinity dup2 dlopen getgroups posix-runtime locale signal setjmp fork pipe spawn spawn-wait resource exec socket socket-address socket-listen socket-listen-denied fetch pthread pthread-main-exit unix
CANARIES := $(addprefix $(BUILD_DIR)/,$(addsuffix -canary.wasm,$(CANARY_NAMES)))
FORK_DEFAULT_CANARY := $(BUILD_DIR)/fork-default-canary.wasm

# Phase 1 shared-library side-module fixtures
# (docs/superpowers/specs/2026-05-09-shared-libraries-design.md). These are
# NOT linked against libyurt_abi.a; they are built with `yurt-cc -shared`,
# validated by `yurt-wasi-postlink --side-module`, and consumed by the
# Phase 1 dlopen loader (which itself lands in slices 1C–1E). Until that
# loader is wired up, building side modules is opt-in: the
# `side-module-canaries` target is intentionally NOT a prerequisite of
# `all`. Run it manually (or in CI when the consumer arrives) via
# `make -C abi side-module-canaries`.
SIDE_MODULE_CANARIES := $(BUILD_DIR)/libyurt_dlcanary.wasm
YURT_WASI_POSTLINK := $(REPO_ROOT)/target/release/yurt-wasi-postlink

.PHONY: all lib canaries copy-fixtures clean ensure-toolchain check-native-abi-contract check-headers side-module-canaries

all: lib canaries side-module-canaries

check-native-abi-contract:
	cd $(REPO_ROOT) && $(DENO) run --allow-read --allow-write scripts/generate-native-abi.ts --check

check-headers: ensure-toolchain
	$(abspath tests/check_headers.sh)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Always delegate to cargo so edits under toolchain/yurt-toolchain/src/ actually
# rebuild. `cargo build` is a near-no-op when everything is up to date;
# a `test -x` existence guard would silently use stale binaries.
ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p yurt-toolchain -p yurt-wasi-postlink
	rm -rf $(REPO_ROOT)/target/release/yurt-include
	cp -R $(INCLUDE) $(REPO_ROOT)/target/release/yurt-include

# Objects compile through `yurt-cc -c`. The compat archive is not yet built
# when these rules fire and must not be injected; YURT_CC_ARCHIVE is
# explicitly unset so yurt-cc skips link-arg framing. This is safe because
# `-c` disables link anyway.
$(BUILD_DIR)/%.o: src/%.c $(wildcard include/*.h) src/yurt_runtime.h src/yurt_markers.h | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE= YURT_CC_INCLUDE=$(INCLUDE) $(YURT_CC) $(YURT_CFLAGS) -c $< -o $@

$(BUILD_DIR)/yurt_locale_rs.o: rust/yurt-libc/src/locale.rs | $(BUILD_DIR)
	rustc --target wasm32-wasip1 \
	  --crate-type=lib \
	  --emit=obj=$@ \
	  -C panic=abort \
	  -C opt-level=2 \
	  $<

$(BUILD_DIR)/yurt_pthread_rs.o: rust/yurt-libc/src/pthread.rs | $(BUILD_DIR)
	rustc --target wasm32-wasip1 \
	  --crate-type=lib \
	  --emit=obj=$@ \
	  -C panic=abort \
	  -C opt-level=2 \
	  $<

lib: $(LIB)

CONTINUATION_OBJS := \
  $(BUILD_DIR)/yurt_setjmp.o \
  $(BUILD_DIR)/yurt_fork.o

$(LIB): $(LIB_OBJS) | $(BUILD_DIR) ensure-toolchain
	rm -f $@
	$(YURT_AR) rcs $@ $(LIB_OBJS)

$(CONTINUATION_LIB): $(CONTINUATION_OBJS) | $(BUILD_DIR) ensure-toolchain
	$(YURT_AR) rcs $@ $(CONTINUATION_OBJS)

$(SETJMP_LIB): $(CONTINUATION_LIB) | $(BUILD_DIR)
	cp $(CONTINUATION_LIB) $@

$(BUILD_DIR)/setjmp-canary.wasm: $(CANARY_DIR)/setjmp-canary.c $(wildcard include/*.h) $(LIB) $(CONTINUATION_LIB) | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE=$(abspath $(LIB)) \
	YURT_CC_CONTINUATION_ARCHIVE=$(abspath $(CONTINUATION_LIB)) \
	YURT_CC_USE_CONTINUATION=1 \
	YURT_CC_INCLUDE=$(INCLUDE) \
	YURT_CC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/setjmp-canary.pre-opt.wasm \
	$(YURT_CC) $(YURT_CFLAGS) $< -o $@

$(BUILD_DIR)/fork-canary.wasm: $(CANARY_DIR)/fork-canary.c $(wildcard include/*.h) $(LIB) $(CONTINUATION_LIB) | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE=$(abspath $(LIB)) \
	YURT_CC_CONTINUATION_ARCHIVE=$(abspath $(CONTINUATION_LIB)) \
	YURT_CC_USE_CONTINUATION=1 \
	YURT_CC_INCLUDE=$(INCLUDE) \
	YURT_CC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/fork-canary.pre-opt.wasm \
	$(YURT_CC) $(YURT_CFLAGS) -DYURT_FORK_CANARY_CONTINUATION=1 $< -o $@

$(FORK_DEFAULT_CANARY): $(CANARY_DIR)/fork-canary.c $(wildcard include/*.h) $(LIB) | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE=$(abspath $(LIB)) \
	YURT_CC_INCLUDE=$(INCLUDE) \
	YURT_CC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/fork-default-canary.pre-opt.wasm \
	$(YURT_CC) $(YURT_CFLAGS) $< -o $@

$(BUILD_DIR)/%-canary.wasm: $(CANARY_DIR)/%-canary.c $(wildcard include/*.h) $(LIB) | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE=$(abspath $(LIB)) \
	YURT_CC_INCLUDE=$(INCLUDE) \
	YURT_CC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/$*-canary.pre-opt.wasm \
	$(YURT_CC) $(YURT_CFLAGS) $< -o $@

canaries: $(CANARIES) $(FORK_DEFAULT_CANARY)

# ── Side-module fixtures (Phase 1 shared libraries) ──────────────────
# Each side module follows the same two-step build:
#   1. yurt-cc -fPIC -c     compile with position-independent code
#   2. yurt-cc -shared      link via wasm-ld --shared --experimental-pic
#                           (skips libyurt_abi.a injection per slice 1B.1)
# Then `yurt-wasi-postlink --side-module` validates the dylink.0 custom
# section emitted by wasm-ld and writes a sidecar manifest the Phase 1
# loader will consume.
#
# Side modules do NOT depend on $(LIB); they have no static ABI archive
# to link against by definition. They DO depend on the headers in
# include/ (currently only <stdint.h>-style standard headers, but the
# rule wildcard keeps incremental rebuilds correct if a header is added).
$(BUILD_DIR)/libyurt_dlcanary.o: $(CANARY_DIR)/libyurt_dlcanary.c $(wildcard include/*.h) | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE= YURT_CC_INCLUDE=$(INCLUDE) \
	$(YURT_CC) $(YURT_CFLAGS) -fPIC -fvisibility=hidden -c $< -o $@

$(BUILD_DIR)/libyurt_dlcanary.wasm: $(BUILD_DIR)/libyurt_dlcanary.o | $(BUILD_DIR) ensure-toolchain
	YURT_CC_ARCHIVE= YURT_CC_INCLUDE=$(INCLUDE) \
	YURT_CC_NO_WASM_OPT=1 \
	$(YURT_CC) -shared $< -o $@
	# yurt-cc -shared automatically runs `yurt-wasi-postlink --side-module`
	# at the end of the link, validating dylink.0 and emitting
	# $@.yurtmeta.json. No separate postlink invocation needed.

side-module-canaries: $(SIDE_MODULE_CANARIES)

copy-fixtures: canaries side-module-canaries
	@for n in $(CANARY_NAMES); do cp $(BUILD_DIR)/$$n-canary.wasm $(FIXTURES)/$$n-canary.wasm; done
	@cp $(FORK_DEFAULT_CANARY) $(FIXTURES)/fork-default-canary.wasm
	@cp $(BUILD_DIR)/libyurt_dlcanary.wasm $(FIXTURES)/libyurt_dlcanary.wasm
	@cp $(BUILD_DIR)/libyurt_dlcanary.wasm.yurtmeta.json $(FIXTURES)/libyurt_dlcanary.wasm.yurtmeta.json

clean:
	rm -rf $(BUILD_DIR)

RUST_CANARY_NAMES := dup2 getgroups affinity signal socket-rust
RUST_CANARY_PRE_OPT := $(addprefix $(BUILD_DIR)/rust/,$(addsuffix -canary.pre-opt.wasm,$(RUST_CANARY_NAMES)))
RUST_CANARY_WASM := $(addprefix $(BUILD_DIR)/rust/,$(addsuffix -canary.wasm,$(RUST_CANARY_NAMES)))
RUST_STD_CANARY_NAMES := std-tempdir std-env-process std-paths std-fs std-file-lock std-thread std-process-status std-process-output std-process-env-cwd std-process-spawn-stdio std-process-child-stdout std-process-stdio-from std-net-connect std-net-stream std-net-peer-addr std-net-hostname std-net-shutdown std-net-try-clone std-net-socket-addr std-net-take-error std-net-nodelay std-net-peek std-net-nonblocking std-net-listener

.PHONY: rust-canaries rust-std-canaries

rust-canaries: $(LIB) ensure-toolchain
	@mkdir -p $(BUILD_DIR)/rust
	YURT_CC_ARCHIVE=$(abspath $(LIB)) \
	YURT_CC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/rust \
	YURT_CC_NO_WASM_OPT=1 \
	CARGO_TARGET_DIR=$(REPO_ROOT)/target \
	$(REPO_ROOT)/target/release/cargo-yurt yurt build --release \
	  -p dup2-canary -p getgroups-canary -p affinity-canary -p signal-canary -p socket-rust-canary
	@for n in $(RUST_CANARY_NAMES); do \
	  cp $(REPO_ROOT)/target/wasm32-wasip1/release/$$n-canary.wasm $(BUILD_DIR)/rust/$$n-canary.wasm; \
	done
	@cp $(BUILD_DIR)/rust/socket-rust-canary.wasm $(FIXTURES)/socket-rust-canary.wasm

rust-std-canaries: $(LIB) ensure-toolchain
	@mkdir -p $(BUILD_DIR)/rust
	@version=$$(rustc --version | awk '{print $$2}'); \
	std_root="$(REPO_ROOT)/abi/build/rust-std/$$version"; \
	if [ ! -d "$$std_root/lib/rustlib/wasm32-wasip1/lib" ]; then \
	  echo "missing Yurt Rust std for $$version; run scripts/build-rust-std.sh --rust $$version" >&2; \
	  exit 1; \
	fi; \
	rm -rf $(REPO_ROOT)/target/rust-std-canaries/$$version; \
	for n in $(RUST_STD_CANARY_NAMES); do \
	  YURT_CC_ARCHIVE=$(abspath $(LIB)) \
	  YURT_CC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/rust \
	  YURT_CC_NO_WASM_OPT=1 \
	  YURT_RUST_STD="$$std_root" \
	  CARGO_TARGET_DIR=$(REPO_ROOT)/target/rust-std-canaries/$$version \
	  $(REPO_ROOT)/target/release/cargo-yurt yurt build --release \
	    --manifest-path $(REPO_ROOT)/abi/conformance/rust/$$n-canary/Cargo.toml; \
	  cp $(REPO_ROOT)/target/rust-std-canaries/$$version/wasm32-wasip1/release/$$n-canary.wasm \
	    $(BUILD_DIR)/rust/$$n-canary.wasm; \
	  cp $(BUILD_DIR)/rust/$$n-canary.wasm $(FIXTURES)/$$n-canary.wasm; \
	done
