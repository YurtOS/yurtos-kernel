/* termios.h — wasm32/wasi terminal control types and constants.
 *
 * musl wasm32 layout (60 bytes):
 *   [0]  c_iflag  (uint32_t)
 *   [4]  c_oflag  (uint32_t)
 *   [8]  c_cflag  (uint32_t)
 *   [12] c_lflag  (uint32_t)
 *   [16] c_line   (uint8_t)
 *   [17] c_cc[32] (uint8_t[32])  → ends at 49, padded to 52
 *   [52] c_ispeed (uint32_t)
 *   [56] c_ospeed (uint32_t)
 * total: 60 bytes
 *
 * Note: the yurt host_tcgetattr import writes "ispeed/ospeed" to offsets
 * 40/44 (inside c_cc), which is harmless because our C code reads the baud
 * rate from CBAUD bits of c_cflag, not from c_ispeed/c_ospeed.
 */

#ifndef _TERMIOS_H
#define _TERMIOS_H

#include <stdint.h>
#include <sys/types.h>

typedef uint32_t tcflag_t;
typedef uint8_t  cc_t;
typedef uint32_t speed_t;

#define NCCS 32

struct termios {
    tcflag_t c_iflag;
    tcflag_t c_oflag;
    tcflag_t c_cflag;
    tcflag_t c_lflag;
    cc_t     c_line;
    cc_t     c_cc[NCCS];
    /* 3 bytes implicit padding here (wasm32 aligns speed_t to 4) */
    speed_t  c_ispeed;
    speed_t  c_ospeed;
};

/* c_cc index constants */
#define VINTR    0
#define VQUIT    1
#define VERASE   2
#define VKILL    3
#define VEOF     4
#define VTIME    5
#define VMIN     6
#define VSWTC    7
#define VSTART   8
#define VSTOP    9
#define VSUSP   10
#define VEOL    11
#define VREPRINT 12
#define VDISCARD 13
#define VWERASE  14
#define VLNEXT  15
#define VEOL2   16

/* c_iflag bits */
#define IGNBRK  0x0001
#define BRKINT  0x0002
#define IGNPAR  0x0004
#define PARMRK  0x0008
#define INPCK   0x0010
#define ISTRIP  0x0020
#define INLCR   0x0040
#define IGNCR   0x0080
#define ICRNL   0x0100
#define IUCLC   0x0200
#define IXON    0x0400
#define IXANY   0x0800
#define IXOFF   0x1000
#define IMAXBEL 0x2000
#define IUTF8   0x4000

/* c_oflag bits */
#define OPOST   0x0001
#define OLCUC   0x0002
#define ONLCR   0x0004
#define OCRNL   0x0008
#define ONOCR   0x0010
#define ONLRET  0x0020
#define OFILL   0x0040
#define OFDEL   0x0080

/* c_cflag bits */
#define CBAUD   0x0000000fu
#define CBAUDEX 0x00001000u
#define B0      0u
#define B50     1u
#define B75     2u
#define B110    3u
#define B134    4u
#define B150    5u
#define B200    6u
#define B300    7u
#define B600    8u
#define B1200   9u
#define B1800   10u
#define B2400   11u
#define B4800   12u
#define B9600   13u
#define B19200  14u
#define B38400  15u
#define CSIZE   0x00000030u
#define CS5     0x00000000u
#define CS6     0x00000010u
#define CS7     0x00000020u
#define CS8     0x00000030u
#define CSTOPB  0x00000040u
#define CREAD   0x00000080u
#define PARENB  0x00000100u
#define PARODD  0x00000200u
#define HUPCL   0x00000400u
#define CLOCAL  0x00000800u
#define CRTSCTS 0x80000000u

/* c_lflag bits */
#define ISIG    0x00000001u
#define ICANON  0x00000002u
#define XCASE   0x00000004u
#define ECHO    0x00000008u
#define ECHOE   0x00000010u
#define ECHOK   0x00000020u
#define ECHONL  0x00000040u
#define NOFLSH  0x00000080u
#define TOSTOP  0x00000100u
#define ECHOCTL 0x00000200u
#define ECHOPRT 0x00000400u
#define ECHOKE  0x00000800u
#define FLUSHO  0x00001000u
#define PENDIN  0x00004000u
#define IEXTEN  0x00008000u

/* tcsetattr optional_actions values */
#define TCSANOW   0
#define TCSADRAIN 1
#define TCSAFLUSH 2

/* tcflow action values */
#define TCOOFF 0
#define TCOON  1
#define TCIOFF 2
#define TCION  3

/* tcflush queue_selector values */
#define TCIFLUSH  0
#define TCOFLUSH  1
#define TCIOFLUSH 2

/* Window size struct and ioctls. */
struct winsize {
    unsigned short ws_row;
    unsigned short ws_col;
    unsigned short ws_xpixel;
    unsigned short ws_ypixel;
};

#define TIOCGWINSZ 0x5413
#define TIOCSWINSZ 0x5414
#define TIOCCONS   0x541D
#define TIOCLINUX  0x541C
#define TIOCSCTTY  0x540E
#define TIOCNOTTY  0x5422

#ifdef __cplusplus
extern "C" {
#endif

int      tcgetattr(int fd, struct termios *termios_p);
int      tcsetattr(int fd, int optional_actions, const struct termios *termios_p);
int      tcflush(int fd, int queue_selector);
int      tcdrain(int fd);
int      tcflow(int fd, int action);
int      tcsendbreak(int fd, int duration);
pid_t    tcgetsid(int fd);

speed_t  cfgetospeed(const struct termios *termios_p);
speed_t  cfgetispeed(const struct termios *termios_p);
int      cfsetospeed(struct termios *termios_p, speed_t speed);
int      cfsetispeed(struct termios *termios_p, speed_t speed);
void     cfmakeraw(struct termios *termios_p);
/* cfsetspeed — GNU extension that sets both ispeed and ospeed at once. */
static inline int cfsetspeed(struct termios *termios_p, speed_t speed) {
    int r = cfsetispeed(termios_p, speed);
    if (r == 0) r = cfsetospeed(termios_p, speed);
    return r;
}

#ifdef __cplusplus
}
#endif

#endif /* _TERMIOS_H */
