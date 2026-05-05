#ifndef YURT_BUSYBOX_COMPAT_TERMIOS_H
#define YURT_BUSYBOX_COMPAT_TERMIOS_H

#include <sys/types.h>

typedef unsigned int tcflag_t;
typedef unsigned char cc_t;
typedef unsigned int speed_t;

#ifndef NCCS
#define NCCS 32
#endif

struct termios {
	tcflag_t c_iflag;
	tcflag_t c_oflag;
	tcflag_t c_cflag;
	tcflag_t c_lflag;
	cc_t c_cc[NCCS];
	speed_t c_ispeed;
	speed_t c_ospeed;
};

#define VINTR 0
#define VQUIT 1
#define VERASE 2
#define VKILL 3
#define VEOF 4
#define VTIME 5
#define VMIN 6
#define VSTART 8
#define VSTOP 9
#define VSUSP 10
#define VEOL 11

#define ISIG    0x00000001u
#define ICANON  0x00000002u
#define ECHO    0x00000008u
#define ECHOE   0x00000010u
#define ECHOK   0x00000020u
#define ECHONL  0x00000040u
#define NOFLSH  0x00000080u
#define TOSTOP  0x00000100u
#define IEXTEN  0x00000400u
#define ECHOCTL 0x00000200u
#define ECHOKE  0x00000800u
#define ECHOPRT 0x00002000u

#define BRKINT  0x00000002u
#define ICRNL   0x00000100u
#define INLCR   0x00000040u
#define IXON    0x00000400u
#define IXOFF   0x00001000u
#define IXANY   0x00000800u
#define IUCLC   0x00000200u
#define IMAXBEL 0x00002000u

#define OPOST   0x00000001u
#define ONLCR   0x00000002u
#define OCRNL   0x00000008u
#define ONOCR   0x00000010u
#define ONLRET  0x00000020u
#define OFILL   0x00000040u
#define OFDEL   0x00000080u

#define TAB0    0x00000000u
#define TAB1    0x00000800u
#define TAB2    0x00001000u
#define TAB3    0x00001800u
#define TABDLY  0x00001800u

#define TCSANOW   0
#define TCSADRAIN 1
#define TCSAFLUSH 2

#define TCIFLUSH 0
#define TCOFLUSH 1
#define TCIOFLUSH 2

#define TCIOFF 0
#define TCION  1
#define TCOOFF 2
#define TCOON  3

#define B0       0
#define B50      1
#define B75      2
#define B110     3
#define B134     4
#define B150     5
#define B200     6
#define B300     7
#define B600     8
#define B1200    9
#define B1800    10
#define B2400    11
#define B4800    12
#define B9600    13
#define B19200   14
#define B38400   15
#define B57600   0x1001
#define B115200  0x1002
#define B230400  0x1003
#define B460800  0x1004
#define B500000  0x1005
#define B576000  0x1006
#define B921600  0x1007
#define B1000000 0x1008
#define B1152000 0x1009
#define B1500000 0x100a
#define B2000000 0x100b
#define B2500000 0x100c
#define B3000000 0x100d
#define B3500000 0x100e
#define B4000000 0x100f

int tcgetattr(int fd, struct termios *termios_p);
int tcsetattr(int fd, int optional_actions, const struct termios *termios_p);
speed_t cfgetispeed(const struct termios *termios_p);
speed_t cfgetospeed(const struct termios *termios_p);
int cfsetispeed(struct termios *termios_p, speed_t speed);
int cfsetospeed(struct termios *termios_p, speed_t speed);
int cfsetspeed(struct termios *termios_p, speed_t speed);
void cfmakeraw(struct termios *termios_p);
int tcdrain(int fd);
int tcflow(int fd, int action);
int tcflush(int fd, int queue_selector);
int tcsendbreak(int fd, int duration);

#endif
