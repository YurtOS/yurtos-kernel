/* ioctl(2) — generalised device-control syscall for wasm32-wasip1.
 *
 * ioctl() is used by shells, networking tools, terminal utilities, and many
 * autoconf-generated probes.  wasi-libc provides no ioctl; we provide one
 * here that dispatches to the appropriate yurt host import based on the
 * request number.
 *
 * Categories handled:
 *   TTY control  — TIOCGWINSZ, TIOCSWINSZ, TIOCGPGRP, TIOCSPGRP
 *   Termios      — TCGETS, TCSETS, TCSETSW, TCSETSF
 *   File/fd      — FIONREAD, FIONBIO, FIOCLEX, FIONCLEX
 *   Unknown      — return 0 (silent success) for autoconf-style probes
 *
 * The return convention mirrors Linux: 0 on success, -1 with errno on error.
 */

#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <termios.h>
#include <unistd.h>

#include "yurt_runtime.h"

/* -- TTY ioctl numbers (Linux/wasm32 values) -- */
#ifndef TCGETS
#define TCGETS      0x5401
#endif
#ifndef TCSETS
#define TCSETS      0x5402
#endif
#ifndef TCSETSW
#define TCSETSW     0x5403
#endif
#ifndef TCSETSF
#define TCSETSF     0x5404
#endif
#ifndef TIOCGPGRP
#define TIOCGPGRP   0x540F
#endif
#ifndef TIOCSPGRP
#define TIOCSPGRP   0x5410
#endif
#ifndef TIOCGWINSZ
#define TIOCGWINSZ  0x5413
#endif
#ifndef TIOCSWINSZ
#define TIOCSWINSZ  0x5414
#endif
#ifndef TIOCGEXCL
#define TIOCGEXCL   0x5440
#endif
#ifndef TIOCSCTTY
#define TIOCSCTTY   0x540E
#endif

/* -- File-descriptor ioctl numbers -- */
#ifndef FIONREAD
#define FIONREAD    0x541B
#endif
#ifndef FIONBIO
#define FIONBIO     0x5421
#endif
#ifndef FIOCLEX
#define FIOCLEX     0x5451
#endif
#ifndef FIONCLEX
#define FIONCLEX    0x5450
#endif

/* Forward declaration for yurt_tty_winsize defined in yurt_tty.c */
int yurt_tty_winsize(int fd, void *ws_out);

int ioctl(int fd, unsigned long request, ...) {
    va_list ap;
    va_start(ap, request);

    int rc = 0;

    switch (request) {

    /* ── Window size ── */
    case TIOCGWINSZ: {
        void *ws = va_arg(ap, void *);
        rc = yurt_tty_winsize(fd, ws);
        break;
    }
    case TIOCSWINSZ: {
        /* Accept silently — sandbox window size is controlled by the host. */
        (void)va_arg(ap, void *);
        rc = 0;
        break;
    }

    /* ── Foreground process group ── */
    case TIOCGPGRP: {
        pid_t *pgid = va_arg(ap, pid_t *);
        int pg = yurt_host_tcgetpgrp(fd);
        if (pg < 0) { errno = ENOTTY; rc = -1; break; }
        *pgid = (pid_t)pg;
        rc = 0;
        break;
    }
    case TIOCSPGRP: {
        const pid_t *pgid = va_arg(ap, const pid_t *);
        int ret = yurt_host_tcsetpgrp(fd, (int)*pgid);
        if (ret < 0) { errno = ENOTTY; rc = -1; break; }
        rc = 0;
        break;
    }

    /* ── Termios (TCGETS / TCSETS family) ── */
    case TCGETS: {
        struct termios *tp = va_arg(ap, struct termios *);
        rc = tcgetattr(fd, tp);
        break;
    }
    case TCSETS:
    case TCSETSW:
    case TCSETSF: {
        const struct termios *tp = va_arg(ap, const struct termios *);
        /* Map ioctl action to tcsetattr action (NOW / DRAIN / FLUSH). */
        int action = (request == TCSETS) ? TCSANOW
                   : (request == TCSETSW) ? TCSADRAIN
                   : TCSAFLUSH;
        rc = tcsetattr(fd, action, tp);
        break;
    }

    /* ── Controlling terminal ── */
    case TIOCSCTTY: {
        (void)va_arg(ap, int);
        /* Register fd as our controlling terminal in the kernel process table.
         * Failure is non-fatal — some programs probe TIOCSCTTY before setuid. */
        rc = yurt_host_tiocsctty(fd) >= 0 ? 0 : -1;
        if (rc < 0) errno = EPERM;
        break;
    }
    case TIOCGEXCL: {
        (void)va_arg(ap, int);
        rc = 0;
        break;
    }

    /* ── File-descriptor ioctls ── */
    case FIONREAD: {
        /* Report 0 bytes pending — we can't introspect pipe buffers here. */
        int *nbytes = va_arg(ap, int *);
        *nbytes = 0;
        rc = 0;
        break;
    }
    case FIONBIO:
    case FIOCLEX:
    case FIONCLEX: {
        /* Non-blocking mode and close-on-exec flags: accept silently. */
        (void)va_arg(ap, int);
        rc = 0;
        break;
    }

    default:
        /* Unknown ioctl — return 0 so autoconf probes don't abort. */
        rc = 0;
        break;
    }

    va_end(ap);
    return rc;
}
