#ifndef YURT_COMPAT_SYS_EPOLL_H
#define YURT_COMPAT_SYS_EPOLL_H

#include <signal.h>
#include <stdint.h>
#include <sys/types.h>

/* Linux epoll(7) ABI surface. wasi-libc does not provide this header.
 * Issue #92: the kernel exposes epoll via packed-buffer host imports;
 * abi/src/yurt_epoll.c marshals these prototypes into the wire. */

#ifdef __cplusplus
extern "C" {
#endif

/* Flag bits — Linux values. EPOLLOUT here is 0x004 (Linux epoll), NOT
 * the POSIX poll() POLLOUT=0x002 wasi-libc uses for poll(). They are
 * deliberately different across the two APIs. */
#define EPOLLIN        0x001
#define EPOLLPRI       0x002
#define EPOLLOUT       0x004
#define EPOLLERR       0x008
#define EPOLLHUP       0x010
#define EPOLLRDNORM    0x040
#define EPOLLRDBAND    0x080
#define EPOLLWRNORM    0x100
#define EPOLLWRBAND    0x200
#define EPOLLMSG       0x400
#define EPOLLRDHUP     0x2000
#define EPOLLEXCLUSIVE (1u << 28)
#define EPOLLWAKEUP    (1u << 29)
#define EPOLLONESHOT   (1u << 30)
#define EPOLLET        (1u << 31)

#define EPOLL_CLOEXEC 0x80000 /* matches O_CLOEXEC / TFD_CLOEXEC / EFD_CLOEXEC */

#define EPOLL_CTL_ADD 1
#define EPOLL_CTL_DEL 2
#define EPOLL_CTL_MOD 3

typedef union epoll_data {
  void *ptr;
  int fd;
  uint32_t u32;
  uint64_t u64;
} epoll_data_t;

/* x86_64 Linux defines epoll_event as `__attribute__((packed))` so the
 * struct is 12 bytes (u32 events + u64 data with no padding). Match
 * that explicitly — the kernel wire format pins 12 bytes per record. */
struct epoll_event {
  uint32_t events;
  epoll_data_t data;
} __attribute__((packed));

int epoll_create1(int flags);
int epoll_ctl(int epfd, int op, int fd, struct epoll_event *event);
int epoll_wait(int epfd, struct epoll_event *events, int maxevents, int timeout);

#ifdef __cplusplus
}
#endif

#endif /* YURT_COMPAT_SYS_EPOLL_H */
