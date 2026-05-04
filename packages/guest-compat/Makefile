# Build the guest-compat runtime archive + Tier 1 canaries. Every
# toolchain invocation goes through one of the cp* binaries:
# objects are compiled with `cpcc -c`, archives assembled with
# `cpar rcs`, canaries linked with `cpcc` (which --whole-archives
# libyurt_guest_compat.a per §Override And Link Precedence).
#
# Targets:
#   make lib          — build libyurt_guest_compat.a
#   make canaries     — build every conformance/c/*-canary.wasm
#   make all          — lib + canaries
#   make copy-fixtures — copy canary .wasm into the kernel fixtures dir
#   make clean

REPO_ROOT := $(shell cd ../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/kernel/src/platform/__tests__/fixtures
BUILD_DIR := build
INCLUDE := $(abspath include)
CANARY_DIR := conformance/c
CPCC := $(REPO_ROOT)/target/release/cpcc
CPAR := $(REPO_ROOT)/target/release/cpar

LIB := $(BUILD_DIR)/libyurt_guest_compat.a
SETJMP_LIB := $(BUILD_DIR)/libyurt_setjmp.a
LIB_OBJS := \
  $(BUILD_DIR)/yurt_command.o \
  $(BUILD_DIR)/yurt_dup.o \
  $(BUILD_DIR)/yurt_exec.o \
  $(BUILD_DIR)/yurt_fetch.o \
  $(BUILD_DIR)/yurt_fs.o \
  $(BUILD_DIR)/yurt_mktemp.o \
  $(BUILD_DIR)/yurt_netdb.o \
  $(BUILD_DIR)/yurt_pipe.o \
  $(BUILD_DIR)/yurt_process.o \
  $(BUILD_DIR)/yurt_pthread.o \
  $(BUILD_DIR)/yurt_resource.o \
  $(BUILD_DIR)/yurt_sched.o \
  $(BUILD_DIR)/yurt_signal.o \
  $(BUILD_DIR)/yurt_socket.o \
  $(BUILD_DIR)/yurt_spawn.o \
  $(BUILD_DIR)/yurt_sysinfo.o \
  $(BUILD_DIR)/yurt_time.o \
  $(BUILD_DIR)/yurt_unistd.o \
  $(BUILD_DIR)/yurt_version.o

CANARY_NAMES := stdio sleep system popen affinity dup2 getgroups signal setjmp pipe spawn spawn-wait resource exec socket socket-address socket-listen socket-listen-denied fetch pthread
CANARIES := $(addprefix $(BUILD_DIR)/,$(addsuffix -canary.wasm,$(CANARY_NAMES)))

.PHONY: all lib canaries copy-fixtures clean ensure-toolchain

all: lib canaries

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# Always delegate to cargo so edits under toolchain/cpcc/src/ actually
# rebuild. `cargo build` is a near-no-op when everything is up to date;
# a `test -x` existence guard would silently use stale binaries.
ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p cpcc-toolchain

# Objects compile through `cpcc -c`. The compat archive is not yet built
# when these rules fire and must not be injected; CPCC_ARCHIVE is
# explicitly unset so cpcc skips link-arg framing. This is safe because
# `-c` disables link anyway.
$(BUILD_DIR)/%.o: src/%.c $(wildcard include/*.h) src/yurt_runtime.h src/yurt_markers.h | $(BUILD_DIR) ensure-toolchain
	CPCC_ARCHIVE= CPCC_INCLUDE=$(INCLUDE) $(CPCC) -c $< -o $@

lib: $(LIB)

SETJMP_OBJS := \
  $(BUILD_DIR)/yurt_setjmp.o

$(LIB): $(LIB_OBJS) | $(BUILD_DIR) ensure-toolchain
	$(CPAR) rcs $@ $(LIB_OBJS)

$(SETJMP_LIB): $(SETJMP_OBJS) | $(BUILD_DIR) ensure-toolchain
	$(CPAR) rcs $@ $(SETJMP_OBJS)

$(BUILD_DIR)/setjmp-canary.wasm: $(CANARY_DIR)/setjmp-canary.c $(wildcard include/*.h) $(LIB) $(SETJMP_LIB) | $(BUILD_DIR) ensure-toolchain
	CPCC_ARCHIVE=$(abspath $(LIB)) \
	CPCC_SETJMP_ARCHIVE=$(abspath $(SETJMP_LIB)) \
	CPCC_USE_SETJMP=1 \
	CPCC_INCLUDE=$(INCLUDE) \
	CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/setjmp-canary.pre-opt.wasm \
	$(CPCC) $< -o $@

$(BUILD_DIR)/%-canary.wasm: $(CANARY_DIR)/%-canary.c $(wildcard include/*.h) $(LIB) | $(BUILD_DIR) ensure-toolchain
	CPCC_ARCHIVE=$(abspath $(LIB)) \
	CPCC_INCLUDE=$(INCLUDE) \
	CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/$*-canary.pre-opt.wasm \
	$(CPCC) $< -o $@

canaries: $(CANARIES)

copy-fixtures: canaries
	@for n in $(CANARY_NAMES); do cp $(BUILD_DIR)/$$n-canary.wasm $(FIXTURES)/$$n-canary.wasm; done

clean:
	rm -rf $(BUILD_DIR)

RUST_CANARY_NAMES := dup2 getgroups affinity signal
RUST_CANARY_PRE_OPT := $(addprefix $(BUILD_DIR)/rust/,$(addsuffix -canary.pre-opt.wasm,$(RUST_CANARY_NAMES)))
RUST_CANARY_WASM := $(addprefix $(BUILD_DIR)/rust/,$(addsuffix -canary.wasm,$(RUST_CANARY_NAMES)))
RUST_STD_CANARY_NAMES := std-tempdir std-env-process std-paths std-fs std-file-lock std-thread std-process-status std-process-output std-process-env-cwd std-process-spawn-stdio std-process-child-stdout std-process-stdio-from std-net-connect std-net-stream std-net-peer-addr std-net-hostname std-net-shutdown std-net-try-clone std-net-socket-addr std-net-take-error std-net-nodelay std-net-peek std-net-nonblocking std-net-listener

.PHONY: rust-canaries rust-std-canaries

rust-canaries: $(LIB) ensure-toolchain
	@mkdir -p $(BUILD_DIR)/rust
	CPCC_ARCHIVE=$(abspath $(LIB)) \
	CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/rust \
	CPCC_NO_WASM_OPT=1 \
	CARGO_TARGET_DIR=$(REPO_ROOT)/target \
	$(REPO_ROOT)/target/release/cargo-yurt yurt build --release \
	  -p dup2-canary -p getgroups-canary -p affinity-canary -p signal-canary
	@for n in $(RUST_CANARY_NAMES); do \
	  cp $(REPO_ROOT)/target/wasm32-wasip1/release/$$n-canary.wasm $(BUILD_DIR)/rust/$$n-canary.wasm; \
	done

rust-std-canaries: $(LIB) ensure-toolchain
	@mkdir -p $(BUILD_DIR)/rust
	@version=$$(rustc --version | awk '{print $$2}'); \
	std_root="$(REPO_ROOT)/packages/guest-compat/build/rust-std/$$version"; \
	if [ ! -d "$$std_root/lib/rustlib/wasm32-wasip1/lib" ]; then \
	  echo "missing Yurt Rust std for $$version; run scripts/build-rust-std.sh --rust $$version" >&2; \
	  exit 1; \
	fi; \
	rm -rf $(REPO_ROOT)/target/rust-std-canaries/$$version; \
	for n in $(RUST_STD_CANARY_NAMES); do \
	  CPCC_ARCHIVE=$(abspath $(LIB)) \
	  CPCC_PRESERVE_PRE_OPT=$(abspath $(BUILD_DIR))/rust \
	  CPCC_NO_WASM_OPT=1 \
	  YURT_RUST_STD="$$std_root" \
	  CARGO_TARGET_DIR=$(REPO_ROOT)/target/rust-std-canaries/$$version \
	  $(REPO_ROOT)/target/release/cargo-yurt yurt build --release \
	    --manifest-path $(REPO_ROOT)/packages/guest-compat/conformance/rust/$$n-canary/Cargo.toml; \
	  cp $(REPO_ROOT)/target/rust-std-canaries/$$version/wasm32-wasip1/release/$$n-canary.wasm \
	    $(BUILD_DIR)/rust/$$n-canary.wasm; \
	  cp $(BUILD_DIR)/rust/$$n-canary.wasm $(FIXTURES)/$$n-canary.wasm; \
	done
