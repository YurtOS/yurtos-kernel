/* TTY / terminal control — bridges libc terminal APIs to the yurt kernel.
 *
 * isatty(3), tcgetattr(3), tcsetattr(3), tcflush(3), tcdrain(3), tcflow(3),
 * cfget/cfset ispeed/ospeed: all route through yurt_host_* imports so that
 * job-control shells (for example BusyBox ash) and any C program that links libcompat gets
 * sensible terminal behaviour instead of ENOSYS stubs.
 *
 * We do NOT implement a line discipline on the host side; the kernel passes
 * bytes between the master and slave without modification.  tcsetattr
 * succeeds silently — the settings are accepted and ignored.
 */

#include <errno.h>
#include <termios.h>
#include <unistd.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "yurt_runtime.h"

/* TIOCGWINSZ is Linux-specific; define it here if absent.
 * Value 0x5413 is standard on Linux x86/wasm32. */
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
#endif

/* isatty(3): returns 1 if fd refers to a terminal, 0 otherwise. */
int isatty(int fd) {
    int rc = yurt_host_isatty(fd);
    if (rc < 0) {
        errno = ENOTTY;
        return 0;
    }
    return 1;
}

/* tcgetattr(3): fill *termios_p with the current terminal attributes.
 * We ask the host to write a sane default termios blob directly into
 * *termios_p via its linear-memory pointer. */
int tcgetattr(int fd, struct termios *termios_p) {
    int rc = yurt_host_tcgetattr(fd, (int)(intptr_t)termios_p, (int)sizeof(struct termios));
    if (rc < 0) {
        errno = ENOTTY;
        return -1;
    }
    return 0;
}

/* tcsetattr(3): apply terminal attributes from *termios_p.
 * The host accepts and ignores the settings (no line discipline). */
int tcsetattr(int fd, int optional_actions, const struct termios *termios_p) {
    int rc = yurt_host_tcsetattr(fd, optional_actions, (int)(intptr_t)termios_p);
    if (rc < 0) {
        errno = ENOTTY;
        return -1;
    }
    return 0;
}

/* tcflush(3): discard queued input/output.  No-op in yurt (passthrough TTY). */
int tcflush(int fd, int queue_selector) {
    (void)fd; (void)queue_selector;
    /* Accept silently — no buffered data to discard at the WASM layer. */
    return 0;
}

/* tcdrain(3): wait for output to be transmitted.  No-op (writes are immediate). */
int tcdrain(int fd) {
    (void)fd;
    return 0;
}

/* tcflow(3): suspend/resume transmission.  No-op. */
int tcflow(int fd, int action) {
    (void)fd; (void)action;
    return 0;
}

/* tcsendbreak(3): no-op. */
int tcsendbreak(int fd, int duration) {
    (void)fd; (void)duration;
    return 0;
}

pid_t tcgetsid(int fd) {
    if (yurt_host_isatty(fd) < 0) {
        errno = ENOTTY;
        return (pid_t)-1;
    }
    return getsid(0);
}

/* cfgetospeed / cfgetispeed: extract baud rate from c_cflag.
 * CBAUD = 0xf on Linux/musl — the low 4 bits of c_cflag hold the baud constant. */
#ifndef CBAUD
#define CBAUD 0xf
#endif

speed_t cfgetospeed(const struct termios *termios_p) {
    return (speed_t)(termios_p->c_cflag & CBAUD);
}

speed_t cfgetispeed(const struct termios *termios_p) {
    return (speed_t)(termios_p->c_cflag & CBAUD);
}

/* cfsetospeed / cfsetispeed: store baud rate into c_cflag. */
int cfsetospeed(struct termios *termios_p, speed_t speed) {
    termios_p->c_cflag = (termios_p->c_cflag & ~(tcflag_t)CBAUD) | ((tcflag_t)speed & CBAUD);
    return 0;
}

int cfsetispeed(struct termios *termios_p, speed_t speed) {
    (void)speed; /* input and output share the same baud in our model */
    return 0;
}

/* cfmakeraw(3): put the terminal into raw mode (no line discipline). */
void cfmakeraw(struct termios *termios_p) {
    termios_p->c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
    termios_p->c_oflag &= ~OPOST;
    termios_p->c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
    termios_p->c_cflag &= ~(CSIZE | PARENB);
    termios_p->c_cflag |= CS8;
    termios_p->c_cc[VMIN] = 1;
    termios_p->c_cc[VTIME] = 0;
}

/* yurt_tty_winsize — fills an 8-byte { rows, cols, xpix, ypix } struct. */
int yurt_tty_winsize(int fd, void *ws_out) {
    int rc = yurt_host_winsize(fd, (int)(intptr_t)ws_out, 8);
    if (rc < 0) {
        errno = ENOTTY;
        return -1;
    }
    return 0;
}
