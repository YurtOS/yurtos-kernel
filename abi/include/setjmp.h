#ifndef YURT_COMPAT_SETJMP_H
#define YURT_COMPAT_SETJMP_H

/* setjmp/longjmp via asyncify.
 *
 * Background: clang's -mllvm -wasm-enable-sjlj lowers setjmp/longjmp
 * to the wasm exception-handling proposal (calls __wasm_setjmp /
 * __wasm_longjmp), which our wasmtime/V8 targets don't have stable
 * support for.  Instead, yurt implements them on top of binaryen
 * Asyncify: setjmp captures the current asyncify save-state, longjmp
 * triggers an unwind that rewinds back to the matching setjmp call.
 *
 * The mechanism is the same one Wasmer/WASIX uses, and runs everywhere
 * Asyncify runs (Safari, older Chrome, Node, Deno, wasmtime — i.e.,
 * everywhere we care about).
 *
 * jmp_buf storage: opaque to the guest.  The host writes its own
 * bookkeeping structure (a tag + a pointer into the asyncify buffer)
 * into this space.  64 bytes is well above what the host needs and
 * matches the layout of glibc's jmp_buf so callers that allocate
 * jmp_buf on the stack don't see surprising sizes. */

#include <stddef.h>

typedef struct {
    /* Opaque host-managed state.  Aligned to 8 for pointer storage. */
    char _state[64] __attribute__((aligned(8)));
} __yurt_jmp_buf_t;

typedef __yurt_jmp_buf_t jmp_buf[1];
typedef __yurt_jmp_buf_t sigjmp_buf[1];

extern int setjmp(jmp_buf env) __attribute__((returns_twice));
extern int _setjmp(jmp_buf env) __attribute__((returns_twice));
extern int sigsetjmp(sigjmp_buf env, int savesigs) __attribute__((returns_twice));

extern void longjmp(jmp_buf env, int val) __attribute__((noreturn));
extern void _longjmp(jmp_buf env, int val) __attribute__((noreturn));
extern void siglongjmp(sigjmp_buf env, int val) __attribute__((noreturn));

#endif /* YURT_COMPAT_SETJMP_H */
