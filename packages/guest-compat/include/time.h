#ifndef YURT_COMPAT_TIME_H
#define YURT_COMPAT_TIME_H

/* Pull in wasi-sdk's time.h first, then re-expose the timezone APIs
 * that wasi-libc gates behind __wasilibc_unmodified_upstream.  Yurt
 * is a single timezone (UTC, mirroring host Date.now()), so tzset()
 * is a no-op and the tzname/timezone/daylight globals carry their
 * "C" locale defaults.  Exposing these symbols lets POSIX-portable
 * upstream code (file/libmagic, GNU coreutils, etc.) link without
 * having to ifdef out timezone handling. */
#include_next <time.h>

#ifndef __wasilibc_unmodified_upstream

#ifdef __cplusplus
extern "C" {
#endif

/* Re-read the TZ environment variable and refresh tzname/timezone/
 * daylight.  Yurt has no timezone database; tzset is a no-op and
 * the globals stay at their UTC/"C"-locale defaults. */
void tzset(void);

/* tzname[0] = standard time abbreviation, tzname[1] = DST.  Both
 * point to "GMT" since the sandbox lives in UTC. */
extern char *tzname[2];

/* timezone: seconds west of UTC.  daylight: 1 if DST active in the
 * current zone (always 0 for us). */
extern long timezone;
extern int daylight;

#ifdef __cplusplus
}
#endif

#endif /* !__wasilibc_unmodified_upstream */

#endif
