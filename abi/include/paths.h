/* paths.h — standard UNIX path definitions for wasm32/wasi.
 * Provides the _PATH_* macros expected by BusyBox and other Linux programs. */

#ifndef _PATHS_H
#define _PATHS_H

#define _PATH_DEFPATH   "/usr/bin:/bin"
#define _PATH_STDPATH   "/usr/bin:/bin:/usr/sbin:/sbin"
#define _PATH_BSHELL    "/bin/sh"
#define _PATH_CSHELL    "/bin/csh"
#define _PATH_TTY       "/dev/tty"
#define _PATH_CONSOLE   "/dev/console"
#define _PATH_DEVNULL   "/dev/null"
#define _PATH_LOG       "/dev/log"
#define _PATH_KLOG      "/proc/kmsg"
#define _PATH_LOGIN     "/bin/login"
#define _PATH_NOLOGIN   "/etc/nologin"
#define _PATH_SHELLS    "/etc/shells"
#define _PATH_UTMP      "/var/run/utmp"
#define _PATH_WTMP      "/var/log/wtmp"
#define _PATH_LASTLOG   "/var/log/lastlog"
#define _PATH_MAILDIR   "/var/spool/mail"
#define _PATH_MAN       "/usr/share/man"
#define _PATH_MNTTAB    "/etc/fstab"
#define _PATH_MOUNTED   "/etc/mtab"
#define _PATH_PASSWD    "/etc/passwd"
#define _PATH_SHADOW    "/etc/shadow"
#define _PATH_GROUP     "/etc/group"
#define _PATH_GSHADOW   "/etc/gshadow"
#define _PATH_NSSWITCH_CONF "/etc/nsswitch.conf"
#define _PATH_SENDMAIL  "/usr/sbin/sendmail"

#endif /* _PATHS_H */
