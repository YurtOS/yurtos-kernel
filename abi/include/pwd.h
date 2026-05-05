#ifndef YURT_COMPAT_PWD_H
#define YURT_COMPAT_PWD_H

/* wasi-libc has no <pwd.h>.  Provide the POSIX struct and lookup
 * functions backed by a synthesized two-entry table:
 *
 *   uid=0    root  (kept so callers that special-case root see what
 *                   they expect — but our processes always run as user)
 *   uid=1000 user  (the canonical sandbox identity; matches the
 *                   `id` applet output and getuid()/getegid())
 *
 * No /etc/passwd parsing today: the sandbox has a fixed identity, so
 * a static table is honest and avoids file-IO during early init.
 * If callers later need a fuller table they can layer one on top. */

#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

struct passwd {
    char *pw_name;
    char *pw_passwd;
    uid_t pw_uid;
    gid_t pw_gid;
    char *pw_gecos;
    char *pw_dir;
    char *pw_shell;
};

/* Storage for the two synthesized entries.  Inline-static so each TU
 * gets its own copy — pw_name etc. point into static string literals
 * shared by all copies, so addresses are still stable for the
 * lifetime of the program. */
static struct passwd yurt_pw_root = {
    (char *)"root", (char *)"x", 0, 0,
    (char *)"root", (char *)"/root", (char *)"/bin/sh"
};
static struct passwd yurt_pw_user = {
    (char *)"user", (char *)"x", 1000, 1000,
    (char *)"user", (char *)"/home/user", (char *)"/bin/sh"
};

/* getpwent() iterator state.  `yurt_pw_iter` runs 0,1,2(=done). */
static int yurt_pw_iter = 0;

static inline void setpwent(void) { yurt_pw_iter = 0; }
static inline void endpwent(void) { yurt_pw_iter = 0; }

static inline struct passwd *getpwent(void) {
    switch (yurt_pw_iter++) {
        case 0: return &yurt_pw_root;
        case 1: return &yurt_pw_user;
        default: yurt_pw_iter = 2; return NULL;
    }
}

static inline struct passwd *getpwuid(uid_t uid) {
    if (uid == 0) return &yurt_pw_root;
    if (uid == 1000) return &yurt_pw_user;
    errno = 0;  /* "no such entry" — POSIX: errno not set on miss */
    return NULL;
}

static inline struct passwd *getpwnam(const char *name) {
    if (!name) { errno = EINVAL; return NULL; }
    if (strcmp(name, "root") == 0) return &yurt_pw_root;
    if (strcmp(name, "user") == 0) return &yurt_pw_user;
    errno = 0;
    return NULL;
}

/* getpwuid_r / getpwnam_r: copy the entry's strings into the
 * caller-provided buffer.  Returns 0 on success, errno on failure;
 * *result is set to &pwd on hit, NULL on miss. */
static inline int yurt_pw_copy(const struct passwd *src,
                                  struct passwd *pwd,
                                  char *buf, size_t buflen) {
    const char *fields[5] = {
        src->pw_name, src->pw_passwd, src->pw_gecos,
        src->pw_dir, src->pw_shell
    };
    size_t needed = 0;
    for (int i = 0; i < 5; i++) needed += strlen(fields[i]) + 1;
    if (needed > buflen) return ERANGE;
    char *p = buf;
    char **dst[5] = {
        &pwd->pw_name, &pwd->pw_passwd, &pwd->pw_gecos,
        &pwd->pw_dir, &pwd->pw_shell
    };
    for (int i = 0; i < 5; i++) {
        size_t n = strlen(fields[i]) + 1;
        memcpy(p, fields[i], n);
        *dst[i] = p;
        p += n;
    }
    pwd->pw_uid = src->pw_uid;
    pwd->pw_gid = src->pw_gid;
    return 0;
}

static inline int getpwuid_r(uid_t uid, struct passwd *pwd,
                             char *buf, size_t buflen,
                             struct passwd **result) {
    if (!pwd || !buf || !result) { if (result) *result = NULL; return EINVAL; }
    const struct passwd *src =
        (uid == 0) ? &yurt_pw_root :
        (uid == 1000) ? &yurt_pw_user : NULL;
    if (!src) { *result = NULL; return 0; }
    int rc = yurt_pw_copy(src, pwd, buf, buflen);
    *result = (rc == 0) ? pwd : NULL;
    return rc;
}

static inline int getpwnam_r(const char *name, struct passwd *pwd,
                             char *buf, size_t buflen,
                             struct passwd **result) {
    if (!name || !pwd || !buf || !result) {
        if (result) *result = NULL;
        return EINVAL;
    }
    const struct passwd *src =
        (strcmp(name, "root") == 0) ? &yurt_pw_root :
        (strcmp(name, "user") == 0) ? &yurt_pw_user : NULL;
    if (!src) { *result = NULL; return 0; }
    int rc = yurt_pw_copy(src, pwd, buf, buflen);
    *result = (rc == 0) ? pwd : NULL;
    return rc;
}

#endif /* YURT_COMPAT_PWD_H */
