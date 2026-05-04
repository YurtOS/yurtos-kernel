/* getrlimit(2) / setrlimit(2) — wasi-sdk declares them in
 * <sys/resource.h> but ships no implementation.  Many configure
 * scripts probe for them (e.g. to size buffers), and several real
 * programs query RLIMIT_NOFILE or RLIMIT_STACK during startup.
 *
 * Yurt's resource semantics are quite different from a real OS:
 * the sandbox is process-isolated, not user-isolated, and most
 * limits are enforced at the WASI layer (memory cap via wasm
 * linear-memory limit, deadline timeouts via cancellation, output
 * caps via FdTable buffer ceilings).  So `getrlimit` reports the
 * underlying mechanism's *effective* cap (rounded if needed) and
 * `setrlimit` accepts requests but is a no-op above the policy
 * minimums — the kernel-side caps win.
 *
 * Defaults below mirror what a small Linux sandbox would report.
 * Programs that just want "is this absurdly low or absurdly high"
 * see reasonable values.
 */

#include "yurt_markers.h"

#include <errno.h>
#include <stddef.h>
#include <sys/resource.h>

YURT_DECLARE_MARKER(getrlimit);
YURT_DECLARE_MARKER(setrlimit);

YURT_DEFINE_MARKER(getrlimit, 0x67726c6du) /* "grlm" */
YURT_DEFINE_MARKER(setrlimit, 0x73726c6du) /* "srlm" */

int getrlimit(int resource, struct rlimit *rlim) {
  YURT_MARKER_CALL(getrlimit);

  if (rlim == NULL) {
    errno = EFAULT;
    return -1;
  }

  /* Defaults: report sensible values, all soft == hard.  The actual
   * enforcement happens at the WASI / runtime level — these are
   * informational for callers that probe limits during startup. */
  rlim_t cur = RLIM_INFINITY;
  rlim_t max = RLIM_INFINITY;

  switch (resource) {
    case RLIMIT_CPU:
      /* Wall-clock deadline is enforced by the runtime, not as
       * CPU-time accounting.  Report unlimited. */
      break;
    case RLIMIT_FSIZE:
      /* No per-file size limit beyond the VFS total budget. */
      break;
    case RLIMIT_DATA:
      /* Data segment is bounded by the wasm linear memory cap;
       * we don't know that here, so report 64 MB as a typical
       * sandbox ceiling. */
      cur = 64ULL * 1024 * 1024;
      max = cur;
      break;
    case RLIMIT_STACK:
      /* wasm stack is allocated by the linker; default 64 KB on
       * wasi-sdk.  Report 1 MB to match what most Linux systems
       * give a thread by default. */
      cur = 1ULL * 1024 * 1024;
      max = cur;
      break;
    case RLIMIT_CORE:
      /* No core dumps in wasm. */
      cur = 0;
      max = 0;
      break;
    case RLIMIT_RSS:
      /* RSS == data segment cap. */
      cur = 64ULL * 1024 * 1024;
      max = cur;
      break;
    case RLIMIT_NOFILE:
      /* The fd table is unbounded in our kernel today, but most
       * real programs sanity-check "less than 1024" or "more than
       * 16" — pick 1024 to match Linux convention. */
      cur = 1024;
      max = 1024;
      break;
    case RLIMIT_NPROC:
      /* Spawned processes are tracked in the kernel's process table;
       * no hard cap.  Report 1024. */
      cur = 1024;
      max = 1024;
      break;
    default:
      /* Unknown resource — POSIX says EINVAL. */
      errno = EINVAL;
      return -1;
  }

  rlim->rlim_cur = cur;
  rlim->rlim_max = max;
  return 0;
}

int setrlimit(int resource, const struct rlimit *rlim) {
  YURT_MARKER_CALL(setrlimit);

  if (rlim == NULL) {
    errno = EFAULT;
    return -1;
  }

  /* Validate the resource number by reusing getrlimit's switch. */
  struct rlimit current;
  if (getrlimit(resource, &current) != 0) {
    return -1;
  }

  /* Accept-and-ignore: the runtime owns the real ceilings.  We
   * don't fail because programs that try to lower their own limits
   * (e.g. drop core file size to 0) are doing the right thing
   * defensively, and refusing the call would only cause them to
   * abort.  Returning success keeps them moving. */
  return 0;
}
