REPO_ROOT := $(shell cd ../../.. && pwd)
FIXTURES := $(REPO_ROOT)/packages/kernel/src/platform/__tests__/fixtures
NCURSES_VERSION := 6.5
NCURSES_ARCHIVE := ncurses-$(NCURSES_VERSION).tar.gz
NCURSES_URL := https://invisible-mirror.net/archives/ncurses/$(NCURSES_ARCHIVE)
BUILD_DIR := build
SRC_DIR := src
INSTALL_DIR := $(abspath $(BUILD_DIR)/install)
INSTALLED_LIB := $(INSTALL_DIR)/usr/lib/libncursesw.a
CANARY_SRC := canary/terminfo-canary.c
CANARY_WASM := $(BUILD_DIR)/terminfo-canary.wasm
FETCH_STAMP := $(BUILD_DIR)/.fetch-stamp
CONFIG_STAMP := $(BUILD_DIR)/.config-stamp
BUILD_STAMP := $(BUILD_DIR)/.build-stamp
FALLBACK_PATCH_STAMP := $(BUILD_DIR)/.fallback-patch-stamp

ABI_INCLUDE := $(REPO_ROOT)/abi/include
ABI_LIB := $(REPO_ROOT)/abi/build/libyurt_abi.a
YURT_CC := $(REPO_ROOT)/target/release/yurt-cc
YURT_AR := $(REPO_ROOT)/target/release/yurt-ar
YURT_RANLIB := $(REPO_ROOT)/target/release/yurt-ranlib
HOST_TIC ?= $(shell for p in /opt/homebrew/opt/ncurses/bin/tic /usr/local/opt/ncurses/bin/tic /usr/bin/tic tic; do if command -v "$$p" >/dev/null 2>&1; then command -v "$$p"; break; fi; done)
HOST_INFOCMP ?= $(shell for p in /opt/homebrew/opt/ncurses/bin/infocmp /usr/local/opt/ncurses/bin/infocmp /usr/bin/infocmp infocmp; do if command -v "$$p" >/dev/null 2>&1; then command -v "$$p"; break; fi; done)

CPPFLAGS :=
LIBS := $(ABI_LIB)

.PHONY: all fetch configure install copy-fixtures clean ensure-toolchain ensure-compat

all: install

ensure-toolchain:
	cd $(REPO_ROOT) && cargo build --release -p yurt-toolchain

ensure-compat:
	$(MAKE) -C $(REPO_ROOT)/abi lib

fetch: $(FETCH_STAMP)

$(FETCH_STAMP):
	mkdir -p $(BUILD_DIR) $(SRC_DIR)
	if [ ! -f $(SRC_DIR)/configure ]; then \
		curl -fL -o $(BUILD_DIR)/$(NCURSES_ARCHIVE) $(NCURSES_URL); \
		tar -xzf $(BUILD_DIR)/$(NCURSES_ARCHIVE) -C $(SRC_DIR) --strip-components=1; \
	fi
	touch $@

$(CONFIG_STAMP): $(FETCH_STAMP) | ensure-toolchain ensure-compat
	cd $(SRC_DIR) && \
		CC="$(YURT_CC)" \
		AR="$(YURT_AR)" \
		RANLIB="$(YURT_RANLIB)" \
		YURT_CC_ARCHIVE="$(ABI_LIB)" \
		YURT_CC_INCLUDE="$(ABI_INCLUDE)" \
		CPPFLAGS="$(CPPFLAGS)" \
		LIBS="" \
		./configure \
			--host=wasm32-wasi \
			--prefix=/usr \
			--with-install-prefix="$(INSTALL_DIR)" \
			--without-shared \
			--with-normal \
			--without-debug \
			--without-ada \
			--without-cxx \
			--without-cxx-binding \
			--without-manpages \
			--without-progs \
			--without-tests \
			--enable-termcap \
			--enable-widec \
			--with-default-terminfo-dir=/usr/share/terminfo \
			--with-terminfo-dirs=/usr/share/terminfo \
			--with-tic-path="$(HOST_TIC)" \
			--with-infocmp-path="$(HOST_INFOCMP)" \
			--with-fallbacks=xterm-256color,xterm,vt100
	touch $@

configure: $(CONFIG_STAMP)

$(FALLBACK_PATCH_STAMP): $(CONFIG_STAMP)
	$(MAKE) -C $(SRC_DIR)/ncurses fallback.c
	awk '/^static short [A-Za-z_][A-Za-z0-9_]*_number_data\[\]/ { sub(/^static short /, "static NCURSES_INT2 ") } { print }' \
		$(SRC_DIR)/ncurses/fallback.c > $(BUILD_DIR)/fallback.c.tmp
	mv $(BUILD_DIR)/fallback.c.tmp $(SRC_DIR)/ncurses/fallback.c
	touch $@

$(BUILD_STAMP): $(FALLBACK_PATCH_STAMP)
	cd $(SRC_DIR) && $(MAKE)
	touch $@

$(INSTALLED_LIB): $(BUILD_STAMP)
	cd $(SRC_DIR) && $(MAKE) install.libs install.includes

install: $(INSTALLED_LIB)

$(CANARY_WASM): $(CANARY_SRC) $(INSTALLED_LIB) | ensure-toolchain ensure-compat
	YURT_CC_ARCHIVE="$(ABI_LIB)" \
	YURT_CC_INCLUDE="$(ABI_INCLUDE)" \
	$(YURT_CC) -I$(INSTALL_DIR)/usr/include $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $(CANARY_SRC) $(INSTALLED_LIB)

copy-fixtures: $(CANARY_WASM)
	cp $(CANARY_WASM) $(FIXTURES)/terminfo-canary.wasm

clean:
	rm -rf $(BUILD_DIR) $(SRC_DIR)
