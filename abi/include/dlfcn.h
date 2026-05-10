#ifndef YURT_COMPAT_DLFCN_H
#define YURT_COMPAT_DLFCN_H

/* Phase 1 shared-library surface for YurtOS guests.
 *
 * Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
 *
 * The four functions below are intentionally narrow. They wrap the
 * `yurt_dl{open,sym,close,error}` host imports and present the standard
 * POSIX dlfcn surface so unmodified C code that uses dlopen builds and
 * runs unchanged.
 *
 * Semantics (see the spec for the full contract):
 *
 *   - RTLD_LAZY is treated as RTLD_NOW. WASM imports resolve at
 *     instantiation; lazy binding does not exist on this platform.
 *     The flag is accepted for source compatibility.
 *   - RTLD_GLOBAL exposes the side module's exports to subsequent
 *     dlopen calls in the same sandbox. RTLD_LOCAL keeps them
 *     private to the returned handle.
 *   - dlopen of the same canonical path returns the same handle and
 *     bumps a refcount. dlclose decrements; on zero the host-side
 *     instance is dropped, but the side module's reserved memory and
 *     table region are NOT reclaimed (WASM has no defragmentation).
 *     This matches Emscripten and is documented in the spec.
 *   - Side modules with non-trivial TLS fail dlopen with EINVAL.
 *   - dlerror() returns a pointer to a static (per-process) message
 *     buffer and clears the error state. The pointer is valid until
 *     the next dlfcn call.
 */

#ifdef __cplusplus
extern "C" {
#endif

#define RTLD_LAZY 0x0001
#define RTLD_NOW 0x0002
#define RTLD_GLOBAL 0x0100
#define RTLD_LOCAL 0x0000

void *dlopen(const char *path, int flags);
void *dlsym(void *handle, const char *name);
int dlclose(void *handle);
char *dlerror(void);

#ifdef __cplusplus
}
#endif

#endif /* YURT_COMPAT_DLFCN_H */
