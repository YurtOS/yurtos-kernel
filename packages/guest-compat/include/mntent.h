#ifndef YURT_COMPAT_MNTENT_H
#define YURT_COMPAT_MNTENT_H

/* mntent — Linux/glibc /etc/mtab parser surface (set/get/endmntent,
 * struct mntent).  wasi-libc doesn't ship it.  Yurt's /proc
 * provider exposes /proc/mounts, so we *can* serve a real iterator
 * here: setmntent() fopens the path, getmntent() parses one line
 * at a time, endmntent() closes.
 *
 * Field storage is static (the canonical glibc behavior — getmntent
 * is documented as not thread-safe and overwrites between calls), so
 * the returned struct mntent points into shared buffers; callers
 * must copy fields they need to keep across iterations. */

#include <errno.h>
#include <stdio.h>
#include <string.h>

struct mntent {
    char *mnt_fsname;   /* device or server */
    char *mnt_dir;      /* mount point */
    char *mnt_type;     /* file system type */
    char *mnt_opts;     /* mount options */
    int   mnt_freq;     /* dump frequency, in days */
    int   mnt_passno;   /* pass number on parallel fsck */
};

#define MOUNTED  "/proc/mounts"
#ifndef _PATH_MOUNTED
#define _PATH_MOUNTED "/proc/mounts"
#endif

static inline FILE *setmntent(const char *filename, const char *type) {
    if (!filename || !type) { errno = EINVAL; return NULL; }
    /* Plain fopen — /proc/mounts is a real VFS-backed file in yurt;
     * if a caller passes a different path that doesn't exist they get
     * the usual ENOENT, which is the right answer. */
    return fopen(filename, type);
}

static inline struct mntent *getmntent(FILE *fp) {
    /* Per-call static buffers — glibc's getmntent has the same
     * not-thread-safe semantics, so callers already know to copy
     * before the next call. */
    static char yurt_mnt_line[512];
    static char yurt_mnt_fsname[128];
    static char yurt_mnt_dir[128];
    static char yurt_mnt_type[64];
    static char yurt_mnt_opts[128];
    static struct mntent yurt_mnt_ent;

    if (!fp) { errno = EINVAL; return NULL; }

    /* Skip blank lines and comments (`#` at column 0).  /proc/mounts
     * shouldn't produce either, but real /etc/fstab does. */
    for (;;) {
        if (!fgets(yurt_mnt_line, sizeof(yurt_mnt_line), fp)) return NULL;
        char *s = yurt_mnt_line;
        while (*s == ' ' || *s == '\t') s++;
        if (*s == '\0' || *s == '\n' || *s == '#') continue;
        break;
    }

    int freq = 0, passno = 0;
    int n = sscanf(yurt_mnt_line, "%127s %127s %63s %127s %d %d",
                   yurt_mnt_fsname, yurt_mnt_dir, yurt_mnt_type,
                   yurt_mnt_opts, &freq, &passno);
    if (n < 4) return NULL;  /* malformed line */

    yurt_mnt_ent.mnt_fsname = yurt_mnt_fsname;
    yurt_mnt_ent.mnt_dir    = yurt_mnt_dir;
    yurt_mnt_ent.mnt_type   = yurt_mnt_type;
    yurt_mnt_ent.mnt_opts   = yurt_mnt_opts;
    yurt_mnt_ent.mnt_freq   = (n >= 5) ? freq : 0;
    yurt_mnt_ent.mnt_passno = (n >= 6) ? passno : 0;
    return &yurt_mnt_ent;
}

static inline int endmntent(FILE *fp) {
    if (fp) fclose(fp);
    return 1;  /* glibc convention: always 1 */
}

/* getmntent_r — reentrant GNU extension; uses caller-supplied buffer.
 * Delegates to getmntent (which uses its own static buffers), then
 * copies results into the caller's struct and strbuf. */
static inline struct mntent *getmntent_r(FILE *fp, struct mntent *result,
                                          char *buf, int buflen) {
    struct mntent *e = getmntent(fp);
    if (!e || !result || !buf || buflen <= 0) return NULL;
    /* Pack all strings end-to-end into buf; fail if it won't fit. */
    int need = (int)(strlen(e->mnt_fsname) + strlen(e->mnt_dir) +
                     strlen(e->mnt_type) + strlen(e->mnt_opts) + 4);
    if (need > buflen) return NULL;
    char *p = buf;
#define _COPY(field) \
    result->field = p; \
    while ((*p++ = *e->field++)) {} \
    e->field -= (p - result->field); /* restore pointer for reuse */
    _COPY(mnt_fsname)
    _COPY(mnt_dir)
    _COPY(mnt_type)
    _COPY(mnt_opts)
#undef _COPY
    result->mnt_freq   = e->mnt_freq;
    result->mnt_passno = e->mnt_passno;
    return result;
}

static inline char *hasmntopt(const struct mntent *mnt, const char *opt) {
    if (!mnt || !mnt->mnt_opts || !opt) return NULL;
    size_t optlen = strlen(opt);
    char *p = mnt->mnt_opts;
    while (p && *p) {
        char *next = strchr(p, ',');
        size_t span = next ? (size_t)(next - p) : strlen(p);
        /* Match either `opt` exactly or `opt=...`. */
        if (span >= optlen && memcmp(p, opt, optlen) == 0
            && (span == optlen || p[optlen] == '='))
            return p;
        p = next ? next + 1 : NULL;
    }
    return NULL;
}

#endif /* YURT_COMPAT_MNTENT_H */
