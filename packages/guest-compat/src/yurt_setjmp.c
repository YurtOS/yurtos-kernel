/* setjmp/longjmp implementation on top of Asyncify.
 *
 * The host (kernel) drives the Asyncify state machine: when
 * setjmp is called for the first time, host_setjmp records the
 * current Asyncify save-state into env and returns 0.  When longjmp
 * is called, host_longjmp triggers an unwind that the runtime
 * recognizes as a longjmp (rather than an async-import suspension)
 * and rewinds back to setjmp's call site, where setjmp's import is
 * re-invoked under state=REWINDING and returns the longjmp value.
 *
 * From the C program's perspective this is exactly POSIX:
 *   - setjmp returns 0 the first time, val on longjmp(env, val)
 *   - longjmp does not return
 *   - longjmp(env, 0) is treated as longjmp(env, 1)
 *
 * The actual unwind/rewind state machine lives in the runtime; from
 * here all we need is the import declarations and the thin C-side
 * adaption (zero-to-one promotion for longjmp's val, _setjmp/_longjmp
 * aliases, and sigsetjmp/siglongjmp dropping the savesigs flag since
 * we don't model signal masks per-process). */

#include "yurt_runtime.h"
#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>

__attribute__((import_module("yurt"), import_name("host_setjmp")))
extern int yurt_host_setjmp(void *env);

__attribute__((import_module("yurt"), import_name("host_longjmp")))
extern void yurt_host_longjmp(void *env, int val);

/* Asyncify save-state buffer.
 *
 * binaryen's --asyncify pass leaves buffer allocation to the user,
 * and we need a stable wasm-memory address that the host can write
 * the [start, end] header into (asyncify_start_unwind reads
 * `*(uint32_t*)dataAddr` to know where to write next, and
 * `*(uint32_t*)(dataAddr+4)` for the buffer end).
 *
 * 16 KiB is enough for the deepest C call stack we've measured in
 * the canaries and applets that use setjmp; binaries with deeper
 * stacks can grow this in a follow-up without changing the host
 * contract.  The buffer is exported by address so the runtime can
 * locate it without needing __alloc / malloc availability. */
#define YURT_ASYNCIFY_BUF_SIZE 16384

static char yurt_asyncify_buf[YURT_ASYNCIFY_BUF_SIZE]
    __attribute__((aligned(16)));

/* Exported so the host can locate the buffer post-instantiation.
 * Returns a pointer to the start of the 8-byte header — the host
 * then writes the [start, end] u32 pair and uses the same address
 * as the dataAddr argument to asyncify_start_unwind/_rewind.
 *
 * `used` is mandatory: nothing inside the guest calls these, so
 * `--gc-sections` would strip them and the host would have no way
 * to locate the asyncify save-state buffer.  `export_name` alone
 * names the export but doesn't anchor it against GC. */
__attribute__((visibility("default"), used,
               export_name("yurt_asyncify_buf_addr")))
void *yurt_asyncify_buf_addr(void) {
    return yurt_asyncify_buf;
}

__attribute__((visibility("default"), used,
               export_name("yurt_asyncify_buf_size")))
int yurt_asyncify_buf_size(void) {
    return YURT_ASYNCIFY_BUF_SIZE;
}

int setjmp(jmp_buf env) {
    return yurt_host_setjmp((void *)env);
}

int _setjmp(jmp_buf env) {
    return yurt_host_setjmp((void *)env);
}

int sigsetjmp(sigjmp_buf env, int savesigs) {
    /* We don't track per-process signal masks separately, so
     * savesigs is a no-op; semantics are identical to setjmp. */
    (void)savesigs;
    return yurt_host_setjmp((void *)env);
}

void longjmp(jmp_buf env, int val) {
    /* POSIX: longjmp(env, 0) must cause setjmp to return 1 instead. */
    if (val == 0) val = 1;
    yurt_host_longjmp((void *)env, val);
    __builtin_unreachable();
}

void _longjmp(jmp_buf env, int val) {
    if (val == 0) val = 1;
    yurt_host_longjmp((void *)env, val);
    __builtin_unreachable();
}

void siglongjmp(sigjmp_buf env, int val) {
    if (val == 0) val = 1;
    yurt_host_longjmp((void *)env, val);
    __builtin_unreachable();
}
