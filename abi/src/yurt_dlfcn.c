/* Phase 1 dlfcn guest stubs.
 *
 * Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
 *
 * The four POSIX-shaped functions in <dlfcn.h> are thin wrappers
 * around four host imports in the `yurt` namespace:
 *
 *   yurt_dlopen  (path_ptr, path_len, flags) -> handle (i32)
 *   yurt_dlsym   (handle, name_ptr, name_len) -> i32
 *   yurt_dlclose (handle) -> i32
 *   yurt_dlerror (out_ptr, out_cap) -> i32
 *
 * Until the host loader lands (slices 1D Wasmtime, 1E Deno/browser),
 * these imports return ENOSYS-like sentinel values:
 *   yurt_dlopen returns 0
 *   yurt_dlsym returns -1
 *   yurt_dlclose returns -1
 *   yurt_dlerror writes a fixed "dlfcn: host loader not implemented"
 *     message into the buffer
 * so guest binaries that reference dlopen still link, and the
 * dlopen-canary main module is buildable. Once the loader lands, the
 * sentinels are replaced with real behavior at the host side without a
 * guest rebuild.
 *
 * Handle width: the contract uses i32 handles. wasm32's `void *` is
 * 32 bits, so the handle fits an opaque pointer directly without a
 * guest-side trampoline table. A null/zero handle means "error".
 *
 * Error reporting: dlerror() returns a pointer into a static
 * per-process buffer that the host fills via yurt_dlerror.
 * Reading clears the buffer (POSIX dlerror semantics). The buffer
 * is 256 bytes; longer host messages are truncated. This is
 * intentionally narrow.
 */

#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define YURT_DLERROR_BUF_SIZE 256

__attribute__((import_module("yurt"), import_name("yurt_dlopen"))) extern int32_t
yurt_host_dlopen(const char *path_ptr, uint32_t path_len, int32_t flags);

__attribute__((import_module("yurt"), import_name("yurt_dlsym"))) extern int32_t
yurt_host_dlsym(int32_t handle, const char *name_ptr, uint32_t name_len);

__attribute__((import_module("yurt"), import_name("yurt_dlclose"))) extern int32_t
yurt_host_dlclose(int32_t handle);

/* Returns the number of bytes the host wrote (or would have written if
 * the buffer were large enough). 0 if no error is pending. */
__attribute__((import_module("yurt"), import_name("yurt_dlerror"))) extern int32_t
yurt_host_dlerror(char *out_ptr, uint32_t out_cap);

static char yurt_dlerror_buf[YURT_DLERROR_BUF_SIZE];

void *dlopen(const char *path, int flags) {
  uint32_t len = path ? (uint32_t)strlen(path) : 0u;
  int32_t handle = yurt_host_dlopen(path, len, (int32_t)flags);
  if (handle == 0) {
    return NULL;
  }
  return (void *)(uintptr_t)(uint32_t)handle;
}

void *dlsym(void *handle, const char *name) {
  if (name == NULL) {
    return NULL;
  }
  int32_t h = (int32_t)(uint32_t)(uintptr_t)handle;
  uint32_t len = (uint32_t)strlen(name);
  int32_t result = yurt_host_dlsym(h, name, len);
  if (result < 0) {
    return NULL;
  }
  /* Function exports return their __indirect_function_table index;
   * data exports return an absolute address inside the side module's
   * reserved memory region. Either way the i32 fits into void *. */
  return (void *)(uintptr_t)(uint32_t)result;
}

int dlclose(void *handle) {
  int32_t h = (int32_t)(uint32_t)(uintptr_t)handle;
  return (int)yurt_host_dlclose(h);
}

char *dlerror(void) {
  /* POSIX semantics: each dlerror() call drains the most recent error
   * since the previous call. The host clears its per-sandbox error
   * state when yurt_dlerror copies the message out. */
  yurt_dlerror_buf[0] = '\0';
  int32_t written = yurt_host_dlerror(yurt_dlerror_buf, (uint32_t)sizeof(yurt_dlerror_buf));
  if (written <= 0) {
    return NULL;
  }
  /* Defensive null-termination in case the host wrote exactly cap
   * bytes without a terminator. */
  yurt_dlerror_buf[YURT_DLERROR_BUF_SIZE - 1] = '\0';
  return yurt_dlerror_buf;
}
