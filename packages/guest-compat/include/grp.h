#ifndef YURT_COMPAT_GRP_H
#define YURT_COMPAT_GRP_H

/* wasi-libc has no <grp.h>.  Mirror pwd.h: synthesize a two-entry
 * table for gid=0 (root) and gid=1000 (user) backed by static
 * storage, and serve the standard POSIX lookups against it. */

#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <sys/types.h>

struct group {
    char *gr_name;
    char *gr_passwd;
    gid_t gr_gid;
    char **gr_mem;
};

/* Empty member list shared by both groups: we don't model
 * supplementary group membership, so each group has only its
 * primary member (which already shows up via gid). */
static char *yurt_gr_empty_mem[1] = { NULL };

static struct group yurt_gr_root = {
    (char *)"root", (char *)"x", 0, yurt_gr_empty_mem
};
static struct group yurt_gr_user = {
    (char *)"user", (char *)"x", 1000, yurt_gr_empty_mem
};

static int yurt_gr_iter = 0;

static inline void setgrent(void) { yurt_gr_iter = 0; }
static inline void endgrent(void) { yurt_gr_iter = 0; }

static inline struct group *getgrent(void) {
    switch (yurt_gr_iter++) {
        case 0: return &yurt_gr_root;
        case 1: return &yurt_gr_user;
        default: yurt_gr_iter = 2; return NULL;
    }
}

static inline struct group *getgrgid(gid_t gid) {
    if (gid == 0) return &yurt_gr_root;
    if (gid == 1000) return &yurt_gr_user;
    return NULL;
}

static inline struct group *getgrnam(const char *name) {
    if (!name) { errno = EINVAL; return NULL; }
    if (strcmp(name, "root") == 0) return &yurt_gr_root;
    if (strcmp(name, "user") == 0) return &yurt_gr_user;
    return NULL;
}

/* getgrouplist: report the primary group only (no supplementary
 * groups in the sandbox).  Returns the number written, or -1 with
 * *ngroups updated if the buffer is too small. */
static inline int getgrouplist(const char *user, gid_t group,
                               gid_t *groups, int *ngroups) {
    (void)user;
    if (!ngroups) return -1;
    int want = 1;
    if (*ngroups < want) {
        *ngroups = want;
        return -1;
    }
    if (groups) groups[0] = group;
    *ngroups = want;
    return want;
}

static inline int initgroups(const char *user, gid_t group) {
    (void)user; (void)group;
    /* No supplementary group state to load; succeed silently. */
    return 0;
}

/* setgroups — sandbox has no supplementary groups; silently accept
 * an empty list, reject anything else with EPERM. */
static inline int setgroups(int size, const gid_t *list) {
    (void)list;
    if (size == 0) return 0;
    errno = EPERM;
    return -1;
}

#endif /* YURT_COMPAT_GRP_H */
