#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/select.h>
#include <time.h>

#include "yurt_markers.h"
#include "yurt_runtime.h"

YURT_DECLARE_MARKER(select);
YURT_DEFINE_MARKER(select, 0x73656c65u) /* "sele" */
YURT_DECLARE_MARKER(pselect);
YURT_DEFINE_MARKER(pselect, 0x70736c63u) /* "pslc" */

_Static_assert(sizeof(void *) == 4, "libyurt ABI requires wasm32 pointers");
/* NOTE: wasi-sdk-33's fd_set is NOT the upstream bit-array — it's a
 * `{ size_t __nfds; int __fds[FD_SETSIZE]; }` struct (sizeof = 4100,
 * not 128). The wire is still a fixed 128-byte little-endian bitmap;
 * we build it bit-by-bit via FD_ISSET, never by memcpy / pointer
 * overlay. The fd_set IN MEMORY layout does not have to match the
 * wire — only FD_ISSET / FD_SET semantics matter. */
_Static_assert(FD_SETSIZE == 1024, "select ABI assumes FD_SETSIZE == 1024");

#define YURT_FD_SETSIZE 1024
#define YURT_SET_BYTES 128 /* u32 words[32] */
#define YURT_SEL_REQ 404
#define YURT_PSEL_REQ 412
#define YURT_SEL_RESP 384

/* The yurt kernel returns Linux-style errno values (EBADF=9, EFAULT=14,
 * EINVAL=22, ...), but wasi-libc uses its own scheme (EBADF=8, EFAULT=21,
 * EINVAL=28, ...). The naive `errno = -rc` convention silently loses
 * the meaning across the ABI mismatch. Translate the common errnos here
 * so guest code that checks `errno == EBADF` (etc.) sees the local
 * value. Anything not in the table falls through as `-rc` (preserves
 * the error magnitude even if not the canonical local constant). */
static int yurt_errno_from_kernel(int kernel_errno) {
  switch (kernel_errno) {
    case 1:  return EPERM;
    case 2:  return ENOENT;
    case 5:  return EIO;
    case 9:  return EBADF;
    case 11: return EAGAIN;
    case 14: return EFAULT;
    case 17: return EEXIST;
    case 20: return ENOTDIR;
    case 22: return EINVAL;
    case 24: return EMFILE;
    case 32: return EPIPE;
    case 38: return ENOSYS;
    case 40: return ELOOP;
    default: return kernel_errno;
  }
}

/* Compact slot -> canonical kernel sigmask bits (signal s => bit s-1).
 * Slot 7 (SIGUSR1/USR2/ALRM) sets all three (documented
 * over-approximation; the lossiness is a pre-existing sigset_t property,
 * moot while sigmask is a no-op). Keep in sync with
 * abi/src/yurt_poll.c:yurt_ppoll_sigset_to_canonical and
 * abi/src/yurt_signal.c. */
static unsigned long long yurt_compact_sigset_to_canonical(sigset_t set) {
  static const unsigned long long slot_bits[8] = {
      1ull << (1 - 1),   /* 0: SIGHUP   */
      1ull << (2 - 1),   /* 1: SIGINT   */
      1ull << (3 - 1),   /* 2: SIGQUIT  */
      1ull << (15 - 1),  /* 3: SIGTERM  */
      1ull << (17 - 1),  /* 4: SIGCHLD  */
      1ull << (28 - 1),  /* 5: SIGWINCH */
      1ull << (13 - 1),  /* 6: SIGPIPE  */
      (1ull << (10 - 1)) | (1ull << (12 - 1)) | (1ull << (14 - 1)),
      /* 7: SIGUSR1 | SIGUSR2 | SIGALRM */
  };
  unsigned long long out = 0;
  unsigned bits = (unsigned)set;
  for (int slot = 0; slot < 8; slot++) {
    if (bits & (1u << slot)) out |= slot_bits[slot];
  }
  return out;
}

static void yurt_fdset_into_wire(
    const fd_set *src, int nfds, unsigned char *slot) {
  /* NULL caller set -> leave the wire slot zero-filled (the kernel
   * treats an all-zero set as "no fds"; same count/-EBADF as NULL).
   * Read the caller set bit-by-bit via FD_ISSET; never memcpy an
   * fd_set. */
  memset(slot, 0, YURT_SET_BYTES);
  if (src == NULL) return;
  for (int fd = 0; fd < nfds; fd++) {
    if (FD_ISSET(fd, src)) {
      slot[(fd / 32) * 4 + (fd % 32) / 8] |= (unsigned char)(1u << (fd % 8));
    }
  }
}

static void yurt_wire_into_fdset(
    const unsigned char *slot, int nfds, fd_set *dst) {
  /* Skip a NULL caller pointer entirely (no write to NULL). */
  if (dst == NULL) return;
  FD_ZERO(dst);
  for (int fd = 0; fd < nfds; fd++) {
    if (slot[(fd / 32) * 4 + (fd % 32) / 8] & (1u << (fd % 8))) {
      FD_SET(fd, dst);
    }
  }
}

static int yurt_select_common(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    const struct timeval *tv,   /* select form; NULL => no timeout */
    const struct timespec *ts,  /* pselect form; NULL => no timeout */
    const sigset_t *sigmask,    /* pselect only */
    int is_pselect) {
  if (nfds < 0 || nfds > YURT_FD_SETSIZE) {
    errno = EINVAL;
    return -1;
  }

  /* nfds==0: yurt_select.c historically returned without touching the
   * caller's fd_sets. Preserve that exactly (C3, intentional POSIX
   * deviation faithful to the retired transform). */
  if (nfds == 0) {
    return 0;
  }

  unsigned char req[YURT_PSEL_REQ];
  memset(req, 0, sizeof(req));
  unsigned set_base;

  *(uint32_t *)(req + 0) = (uint32_t)nfds;
  if (is_pselect) {
    if (ts == NULL) {
      req[16] = 1; /* timeout_null */
    } else {
      int64_t s = (int64_t)ts->tv_sec;
      int32_t n = (int32_t)ts->tv_nsec;
      memcpy(req + 4, &s, 8);
      memcpy(req + 12, &n, 4);
    }
    if (sigmask == NULL) {
      req[17] = 1; /* sigmask_null */
    } else {
      unsigned long long m = yurt_compact_sigset_to_canonical(*sigmask);
      memcpy(req + 20, &m, 8);
    }
    set_base = 28;
  } else {
    if (tv == NULL) {
      req[16] = 1;
    } else {
      int64_t s = (int64_t)tv->tv_sec;
      int32_t u = (int32_t)tv->tv_usec;
      memcpy(req + 4, &s, 8);
      memcpy(req + 12, &u, 4);
    }
    set_base = 20;
  }

  yurt_fdset_into_wire(readfds, nfds, req + set_base);
  yurt_fdset_into_wire(writefds, nfds, req + set_base + YURT_SET_BYTES);
  yurt_fdset_into_wire(exceptfds, nfds, req + set_base + 2 * YURT_SET_BYTES);

  int req_len = is_pselect ? YURT_PSEL_REQ : YURT_SEL_REQ;
  unsigned char resp[YURT_SEL_RESP];
  long long rc =
      is_pselect
          ? yurt_host_pselect(
                (int)(intptr_t)req, req_len, (int)(intptr_t)resp,
                YURT_SEL_RESP)
          : yurt_host_select(
                (int)(intptr_t)req, req_len, (int)(intptr_t)resp,
                YURT_SEL_RESP);
  if (rc < 0) {
    errno = yurt_errno_from_kernel((int)(-rc));
    return -1;
  }

  yurt_wire_into_fdset(resp, nfds, readfds);
  yurt_wire_into_fdset(resp + YURT_SET_BYTES, nfds, writefds);
  yurt_wire_into_fdset(resp + 2 * YURT_SET_BYTES, nfds, exceptfds);
  return (int)rc;
}

int select(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    struct timeval *timeout) {
  YURT_MARKER_CALL(select);
  return yurt_select_common(
      nfds, readfds, writefds, exceptfds, timeout, NULL, NULL, 0);
}

int __wrap_select(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    struct timeval *timeout) {
  return select(nfds, readfds, writefds, exceptfds, timeout);
}

int pselect(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    const struct timespec *timeout,
    const sigset_t *sigmask) {
  YURT_MARKER_CALL(pselect);
  return yurt_select_common(
      nfds, readfds, writefds, exceptfds, NULL, timeout, sigmask, 1);
}

int __wrap_pselect(
    int nfds,
    fd_set *readfds,
    fd_set *writefds,
    fd_set *exceptfds,
    const struct timespec *timeout,
    const sigset_t *sigmask) {
  return pselect(nfds, readfds, writefds, exceptfds, timeout, sigmask);
}

/* wasi-sdk-33 `<sys/select.h>` does:
 *   __REDIR(select, __select_time64);
 *   __REDIR(pselect, __pselect_time64);
 * so a C caller's `select()` / `pselect()` actually resolves to the
 * time64 symbol, not the bare name. Without these aliases, callers
 * trap on an unresolved import. The aliases point at the
 * implementations above; this preserves the time64 contract because
 * our wire layout already uses i64 tv_sec. */
__attribute__((alias("select"))) int __select_time64(
    int, fd_set *, fd_set *, fd_set *, struct timeval *);

__attribute__((alias("pselect"))) int __pselect_time64(
    int, fd_set *, fd_set *, fd_set *, const struct timespec *,
    const sigset_t *);
