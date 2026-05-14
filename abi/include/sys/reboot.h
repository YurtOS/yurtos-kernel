/* sys/reboot.h — Linux reboot constants for wasm32/wasi.
 * The sandbox does not reboot a host system; this header exists so
 * Linux-oriented userland such as BusyBox init can compile. Calls return
 * the libc/ABI stub result supplied by the linked runtime. */

#ifndef _SYS_REBOOT_H
#define _SYS_REBOOT_H

#define RB_AUTOBOOT    0x01234567
#define RB_HALT_SYSTEM 0xCDEF0123
#define RB_ENABLE_CAD  0x89ABCDEF
#define RB_DISABLE_CAD 0x00000000
#define RB_POWER_OFF   0x4321FEDC
#define RB_SW_SUSPEND  0xD000FCE2
#define RB_KEXEC       0x45584543

#define LINUX_REBOOT_CMD_RESTART    RB_AUTOBOOT
#define LINUX_REBOOT_CMD_HALT       RB_HALT_SYSTEM
#define LINUX_REBOOT_CMD_CAD_ON     RB_ENABLE_CAD
#define LINUX_REBOOT_CMD_CAD_OFF    RB_DISABLE_CAD
#define LINUX_REBOOT_CMD_POWER_OFF  RB_POWER_OFF
#define LINUX_REBOOT_CMD_RESTART2   0xA1B2C3D4
#define LINUX_REBOOT_CMD_SW_SUSPEND RB_SW_SUSPEND
#define LINUX_REBOOT_CMD_KEXEC      RB_KEXEC

int reboot(int cmd);

#endif /* _SYS_REBOOT_H */
