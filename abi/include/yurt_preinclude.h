#ifndef YURT_COMPAT_PREINCLUDE_H
#define YURT_COMPAT_PREINCLUDE_H

#if !defined(__ASSEMBLER__)
#ifdef __cplusplus
extern "C" {
#endif
void qsort_r(void *base, __SIZE_TYPE__ nmemb, __SIZE_TYPE__ size,
             int (*compar)(const void *, const void *, void *),
             void *arg);
#ifdef __cplusplus
}
#endif
#endif

#endif
