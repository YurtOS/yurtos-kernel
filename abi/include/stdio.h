#ifndef YURT_COMPAT_STDIO_H
#define YURT_COMPAT_STDIO_H

/* Pull in the real wasi-sdk stdio.h. */
#define tmpfile __yurt_hidden_wasilibc_tmpfile
#pragma push_macro("__wasi__")
#ifndef __wasi__
#define __wasi__ 1
#endif
#include_next <stdio.h>
#pragma pop_macro("__wasi__")
#undef tmpfile
#ifdef tmpfile64
#undef tmpfile64
#define tmpfile64 tmpfile
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* flockfile / funlockfile / ftrylockfile — POSIX thread-safe stdio
 * locking.  wasi-libc gates these behind `_REENTRANT` (single-thread
 * sandbox builds don't define it), but autoconf-generated code
 * routinely calls them and expects the declarations.  Yurt is
 * single-threaded; real impls are no-ops in libyurt_abi
 * (yurt_fs.c).  Expose unconditionally so configure probes find
 * the declarations. */
void flockfile(FILE *f);
void funlockfile(FILE *f);
int  ftrylockfile(FILE *f);

#ifndef L_cuserid
#define L_cuserid 32
#endif
char *cuserid(char *s);

/* popen(3) / pclose(3) — POSIX, not in wasi-libc.  libyurt_abi provides
 * read-mode popen via pipe(), posix_spawn("/bin/sh", "-c", command), and
 * waitpid(). */
FILE *popen(const char *command, const char *mode);
int pclose(FILE *stream);

FILE *tmpfile(void);

#ifdef __cplusplus
}
#endif

#endif /* YURT_COMPAT_STDIO_H */
