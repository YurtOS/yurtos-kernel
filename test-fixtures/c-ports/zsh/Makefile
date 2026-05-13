REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/kernel/src/platform/__tests__/fixtures
ZSH_VERSION := 5.9
ZSH_ARCHIVE := zsh-$(ZSH_VERSION).tar.xz
ZSH_URL := https://www.zsh.org/pub/$(ZSH_ARCHIVE)
ZSH_FALLBACK_URL := https://downloads.sourceforge.net/project/zsh/zsh/$(ZSH_VERSION)/$(ZSH_ARCHIVE)
BUILD_DIR := build
SRC_DIR := src
ABI_INCLUDE := $(REPO_ROOT)/abi/include
ABI_LIB := $(REPO_ROOT)/abi/build/libyurt_abi.a
YURT_CONTINUATION_LIB := $(REPO_ROOT)/abi/build/libyurt_continuation.a
NCURSES_DIR := $(REPO_ROOT)/test-fixtures/c-ports/ncurses
NCURSES_INSTALL := $(NCURSES_DIR)/build/install/usr
NCURSES_INCLUDE := $(NCURSES_INSTALL)/include
NCURSES_LIB := $(NCURSES_INSTALL)/lib/libncursesw.a

YURT_CC := $(REPO_ROOT)/target/release/yurt-cc
YURT_AR := $(REPO_ROOT)/target/release/yurt-ar
YURT_RANLIB := $(REPO_ROOT)/target/release/yurt-ranlib
FETCH_STAMP := $(BUILD_DIR)/.fetch-stamp
PATCH_STAMP := $(BUILD_DIR)/.patch-stamp
PATCHES := $(sort $(wildcard patches/*.patch))

YURT_CFLAGS := -I$(NCURSES_INCLUDE)

.PHONY: all fetch configure copy-fixtures clean ensure-toolchain ensure-compat ensure-ncurses

all: $(BUILD_DIR)/zsh.wasm

ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p yurt-toolchain

ensure-compat:
	$(MAKE) -C $(REPO_ROOT)/abi lib build/libyurt_continuation.a

ensure-ncurses:
	$(MAKE) -C $(NCURSES_DIR) install

fetch: $(PATCH_STAMP)

$(FETCH_STAMP):
	mkdir -p $(BUILD_DIR) $(SRC_DIR)
	if [ ! -f $(SRC_DIR)/configure ]; then \
		curl -fL --retry 5 --retry-all-errors --connect-timeout 20 -o $(BUILD_DIR)/$(ZSH_ARCHIVE) $(ZSH_URL) || \
		curl -fL --retry 5 --retry-all-errors --connect-timeout 20 -o $(BUILD_DIR)/$(ZSH_ARCHIVE) $(ZSH_FALLBACK_URL); \
		tar -xJ -C $(SRC_DIR) --strip-components=1 -f $(BUILD_DIR)/$(ZSH_ARCHIVE); \
	fi
	touch $@

$(PATCH_STAMP): $(FETCH_STAMP) $(PATCHES)
	for patch in $(PATCHES); do \
		patch -N -d $(SRC_DIR) -p1 < $$patch; \
	done
	touch $@

$(SRC_DIR)/config.status: $(PATCH_STAMP) $(NCURSES_LIB) | ensure-toolchain ensure-compat
	cd $(SRC_DIR) && \
		YURT_CC_ARCHIVE="$(ABI_LIB)" \
		YURT_CC_CONTINUATION_ARCHIVE="$(YURT_CONTINUATION_LIB)" \
		YURT_CC_USE_CONTINUATION=1 \
		YURT_CC_INCLUDE="$(ABI_INCLUDE)" \
		CC="$(YURT_CC)" \
		AR="$(YURT_AR)" \
		RANLIB="$(YURT_RANLIB)" \
		CFLAGS="$(YURT_CFLAGS)" \
		LIBS="$(NCURSES_LIB)" \
		ac_cv_func_getrusage=yes \
		ac_cv_func_select=yes \
		zsh_cv_use_getcwd=yes \
		zsh_cv_64_bit_type="long long" \
		zsh_cv_64_bit_utype="unsigned long long" \
		zsh_cv_printf_has_lld=yes \
		./configure \
			--host=wasm32-wasi \
			--prefix=/usr \
			--disable-dynamic \
			--disable-pcre \
			--disable-gdbm \
			--disable-cap \
			--disable-zsh-secure-free \
			ac_cv_func_getrusage=yes
	cd $(SRC_DIR) && \
		awk '{ if ($$1 == "name=zsh/stat") print "name=zsh/stat modfile=Src/Modules/stat.mdd link=static auto=no load=no"; else print }' \
			config.modules > config.modules.tmp && \
		mv config.modules.tmp config.modules && \
		$(MAKE) -C Src prep

configure: $(SRC_DIR)/config.status

$(NCURSES_LIB):
	$(MAKE) -C $(NCURSES_DIR) install

$(BUILD_DIR)/zsh.wasm: $(SRC_DIR)/config.status $(ABI_LIB) $(YURT_CONTINUATION_LIB) $(NCURSES_LIB) | ensure-compat
	cd $(SRC_DIR) && \
		YURT_CC_ARCHIVE="$(ABI_LIB)" \
		YURT_CC_CONTINUATION_ARCHIVE="$(YURT_CONTINUATION_LIB)" \
		YURT_CC_USE_CONTINUATION=1 \
		YURT_CC_INCLUDE="$(ABI_INCLUDE)" \
		$(MAKE) CC="$(YURT_CC)" AR="$(YURT_AR)" RANLIB="$(YURT_RANLIB)"
	cp $(SRC_DIR)/Src/zsh $(BUILD_DIR)/zsh.wasm

copy-fixtures: $(BUILD_DIR)/zsh.wasm
	cp $(BUILD_DIR)/zsh.wasm $(FIXTURES)/zsh.wasm

clean:
	rm -rf $(BUILD_DIR) $(SRC_DIR)
