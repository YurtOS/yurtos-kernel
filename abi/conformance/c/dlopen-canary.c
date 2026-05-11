/*
 * dlopen-canary — exercises the Phase 1 shared-library contract.
 *
 * Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md
 * Plan: docs/superpowers/plans/2026-05-09-shared-libraries-phase1.md
 *
 * Status (slice 1A): this source is committed alongside the spec doc to
 * pin the contract in code. It is intentionally NOT yet wired into
 * `abi/Makefile` `CANARY_NAMES` — building it requires:
 *
 *   - slice 1B: `yurt-cc -shared` + a built `libyurt_dlcanary.wasm`
 *               side module that exports `yurt_dlcanary_double`.
 *   - slice 1C: `<dlfcn.h>` shipped by `abi/include/dlfcn.h` and the
 *               guest stubs in `abi/src/yurt_dlfcn.c`.
 *   - slice 1D / 1E: host-side loader in the Wasmtime and Deno/Node
 *               backends.
 *
 * Each slice flips the relevant build/test wiring; the source below is
 * the destination state.
 */

#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The Phase 1 dlopen loader requires the main module to export `__alloc`
 * so it can reserve memory for side-module data segments. Re-export
 * malloc under that name. */
__attribute__((used, visibility("default"), export_name("__alloc")))
void *yurt_dlopen_canary_alloc(size_t n) { return malloc(n); }

/* wasm-ld emits env.__wasi_init_tp as an import from any side module
 * built with wasi-libc's shared-library mode. The dlopen loader
 * resolves side-module env.* imports against the main module's
 * exports, so re-export a no-op stub here. */
__attribute__((used, visibility("default"), export_name("__wasi_init_tp")))
void yurt_dlopen_canary_wasi_init_tp(void) {}

/* Print one JSONL trace line. Same convention as dup2-canary.c so the
 * harness can parse output with the existing helpers. */
static void emit(const char *case_name, int exit_code, const char *stdout_line, int has_errno, int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) {
    printf(",\"stdout\":\"%s\"", stdout_line);
  }
  if (has_errno) {
    printf(",\"errno\":%d", errno_value);
  }
  printf("}\n");
}

typedef int32_t (*double_fn)(int32_t);

/* Happy path: open /lib/libyurt_dlcanary.wasm, resolve and call
 * `yurt_dlcanary_double(21)`, expect 42. */
static int case_happy_path(void) {
  void *h = dlopen("/lib/libyurt_dlcanary.wasm", RTLD_NOW);
  if (!h) {
    emit("happy_path", 1, dlerror(), 0, 0);
    return 1;
  }
  double_fn fn = (double_fn)dlsym(h, "yurt_dlcanary_double");
  if (!fn) {
    const char *err = dlerror();
    dlclose(h);
    emit("happy_path", 1, err, 0, 0);
    return 1;
  }
  int32_t result = fn(21);
  dlclose(h);
  if (result != 42) {
    emit("happy_path", 1, "wrong-result", 0, 0);
    return 1;
  }
  emit("happy_path", 0, "dlcanary-ok", 0, 0);
  return 0;
}

/* RTLD_LAZY and RTLD_NOW are observably equivalent on this platform —
 * WASM imports resolve at instantiation. */
static int case_lazy_now_equiv(void) {
  void *lazy = dlopen("/lib/libyurt_dlcanary.wasm", RTLD_LAZY);
  void *now = dlopen("/lib/libyurt_dlcanary.wasm", RTLD_NOW);
  if (!lazy || !now) {
    if (lazy) dlclose(lazy);
    if (now) dlclose(now);
    emit("lazy_now_equiv", 1, "dlopen-failed", 0, 0);
    return 1;
  }
  /* Same SONAME → same handle (dedup by canonical path). */
  int same = (lazy == now) ? 1 : 0;
  dlclose(lazy);
  dlclose(now);
  if (!same) {
    emit("lazy_now_equiv", 1, "different-handles", 0, 0);
    return 1;
  }
  emit("lazy_now_equiv", 0, "lazy-now-ok", 0, 0);
  return 0;
}

/* Refcount: open twice, close once; lookup must still work. */
static int case_double_open_refcount(void) {
  void *h1 = dlopen("/lib/libyurt_dlcanary.wasm", RTLD_NOW);
  void *h2 = dlopen("/lib/libyurt_dlcanary.wasm", RTLD_NOW);
  if (!h1 || !h2) {
    if (h1) dlclose(h1);
    if (h2) dlclose(h2);
    emit("double_open_refcount", 1, "dlopen-failed", 0, 0);
    return 1;
  }
  dlclose(h1);
  double_fn fn = (double_fn)dlsym(h2, "yurt_dlcanary_double");
  if (!fn) {
    dlclose(h2);
    emit("double_open_refcount", 1, "dlsym-after-close-failed", 0, 0);
    return 1;
  }
  int32_t result = fn(7);
  dlclose(h2);
  if (result != 14) {
    emit("double_open_refcount", 1, "wrong-result", 0, 0);
    return 1;
  }
  emit("double_open_refcount", 0, "refcount-ok", 0, 0);
  return 0;
}

/* Missing path → dlopen returns NULL; dlerror returns a non-empty string. */
static int case_missing_path(void) {
  void *h = dlopen("/lib/libdoes_not_exist.wasm", RTLD_NOW);
  if (h) {
    dlclose(h);
    emit("missing_path", 1, "expected-failure", 0, 0);
    return 1;
  }
  const char *err = dlerror();
  if (!err || !*err) {
    emit("missing_path", 1, "no-error-message", 0, 0);
    return 1;
  }
  emit("missing_path", 0, "missing-path-ok", 0, 0);
  return 0;
}

/* Missing symbol → dlsym returns NULL; dlerror non-empty. */
static int case_missing_symbol(void) {
  void *h = dlopen("/lib/libyurt_dlcanary.wasm", RTLD_NOW);
  if (!h) {
    emit("missing_symbol", 1, "dlopen-failed", 0, 0);
    return 1;
  }
  void *sym = dlsym(h, "yurt_dlcanary_does_not_exist");
  if (sym) {
    dlclose(h);
    emit("missing_symbol", 1, "expected-failure", 0, 0);
    return 1;
  }
  const char *err = dlerror();
  dlclose(h);
  if (!err || !*err) {
    emit("missing_symbol", 1, "no-error-message", 0, 0);
    return 1;
  }
  emit("missing_symbol", 0, "missing-symbol-ok", 0, 0);
  return 0;
}

/* A regular (non-side-module) wasm file is rejected with a
 * "not a side module" error. */
static int case_bad_format(void) {
  /* The harness pre-populates /tmp/not-a-side-module.wasm with the
   * bytes of an existing main module (e.g. dup2-canary.wasm). */
  void *h = dlopen("/tmp/not-a-side-module.wasm", RTLD_NOW);
  if (h) {
    dlclose(h);
    emit("bad_format", 1, "expected-failure", 0, 0);
    return 1;
  }
  const char *err = dlerror();
  if (!err || !*err) {
    emit("bad_format", 1, "no-error-message", 0, 0);
    return 1;
  }
  emit("bad_format", 0, "bad-format-ok", 0, 0);
  return 0;
}

static int run_case(const char *name) {
  if (strcmp(name, "happy_path") == 0) return case_happy_path();
  if (strcmp(name, "lazy_now_equiv") == 0) return case_lazy_now_equiv();
  if (strcmp(name, "double_open_refcount") == 0) return case_double_open_refcount();
  if (strcmp(name, "missing_path") == 0) return case_missing_path();
  if (strcmp(name, "missing_symbol") == 0) return case_missing_symbol();
  if (strcmp(name, "bad_format") == 0) return case_bad_format();
  fprintf(stderr, "dlopen-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("happy_path");
  puts("lazy_now_equiv");
  puts("double_open_refcount");
  puts("missing_path");
  puts("missing_symbol");
  puts("bad_format");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode — runs the happy path. */
    return case_happy_path();
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) {
    return list_cases();
  }
  if (argc == 3 && strcmp(argv[1], "--case") == 0) {
    return run_case(argv[2]);
  }
  fprintf(stderr, "usage: dlopen-canary [--case <name> | --list-cases]\n");
  return 2;
}
