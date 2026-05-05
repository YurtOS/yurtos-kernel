/* posix_spawn(3) family — built on top of host_spawn.
 *
 * The yurt kernel's host_spawn primitive accepts a JSON
 * SpawnRequest with `prog`, `args`, `env`, `cwd`, `stdin_fd`,
 * `stdout_fd`, `stderr_fd`, and an optional `argv0` override.  The
 * file-action surface that POSIX exposes is richer (arbitrary
 * open/close/dup2 against arbitrary child fds), but the only file-
 * action effects that survive across our spawn boundary are the
 * three stdio fds — every other child fd is independent.  So we
 * walk the file_actions list, apply opens to *parent* fds
 * (returning real open fds for the duration of the spawn), simulate
 * the child fd map, and pick out the parent fds that end up at
 * child positions 0/1/2.  Anything the actions do to non-stdio child
 * fds is silently ignored — POSIX programs that need this should
 * use a real pipe()/dup2() pattern in the parent before spawning.
 */

#include "spawn.h"
#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

YURT_DECLARE_MARKER(posix_spawn);
YURT_DECLARE_MARKER(posix_spawnp);
YURT_DECLARE_MARKER(posix_spawn_file_actions_init);
YURT_DECLARE_MARKER(posix_spawnattr_init);

YURT_DEFINE_MARKER(posix_spawn,                    0x70737077u) /* "pspw" */
YURT_DEFINE_MARKER(posix_spawnp,                   0x70737070u) /* "pspp" */
YURT_DEFINE_MARKER(posix_spawn_file_actions_init,  0x70736661u) /* "psfa" */
YURT_DEFINE_MARKER(posix_spawnattr_init,           0x70736174u) /* "psat" */

/* ─── Internal state ─── */

enum action_kind {
  ACTION_OPEN  = 1,
  ACTION_CLOSE = 2,
  ACTION_DUP2  = 3,
  ACTION_CHDIR = 4,
};

typedef struct {
  int   kind;
  int   fd;       /* OPEN/CLOSE: child fd; DUP2: dest child fd */
  int   dup_src;  /* DUP2: source parent fd */
  int   oflag;    /* OPEN: open flags */
  int   mode;     /* OPEN: open mode */
  char *path;     /* OPEN: file path; CHDIR: chdir path; owned by us */
} action_t;

typedef struct {
  int       count;
  int       cap;
  action_t *items;
} fa_state_t;

typedef struct {
  short flags;
  pid_t pgroup;
  sigset_t sigmask;
  sigset_t sigdefault;
  int schedpolicy;
  struct sched_param schedparam;
} attr_state_t;

/* ─── File-actions ─── */

int posix_spawn_file_actions_init(posix_spawn_file_actions_t *fa) {
  YURT_MARKER_CALL(posix_spawn_file_actions_init);
  if (!fa) { errno = EINVAL; return EINVAL; }
  fa_state_t *s = (fa_state_t *)calloc(1, sizeof(*s));
  if (!s) return ENOMEM;
  fa->__priv = s;
  return 0;
}

int posix_spawn_file_actions_destroy(posix_spawn_file_actions_t *fa) {
  if (!fa || !fa->__priv) return 0;
  fa_state_t *s = (fa_state_t *)fa->__priv;
  for (int i = 0; i < s->count; i++) free(s->items[i].path);
  free(s->items);
  free(s);
  fa->__priv = NULL;
  return 0;
}

static int fa_push(posix_spawn_file_actions_t *fa, action_t a) {
  if (!fa || !fa->__priv) return EINVAL;
  fa_state_t *s = (fa_state_t *)fa->__priv;
  if (s->count == s->cap) {
    int new_cap = s->cap == 0 ? 4 : s->cap * 2;
    action_t *new_items = (action_t *)realloc(s->items, sizeof(action_t) * new_cap);
    if (!new_items) return ENOMEM;
    s->items = new_items;
    s->cap = new_cap;
  }
  s->items[s->count++] = a;
  return 0;
}

int posix_spawn_file_actions_addopen(posix_spawn_file_actions_t *fa,
                                     int fd, const char *path,
                                     int oflag, mode_t mode) {
  if (!path) return EINVAL;
  char *path_copy = strdup(path);
  if (!path_copy) return ENOMEM;
  action_t a = { .kind = ACTION_OPEN, .fd = fd, .oflag = oflag,
                 .mode = (int)mode, .path = path_copy };
  int rc = fa_push(fa, a);
  if (rc != 0) free(path_copy);
  return rc;
}

int posix_spawn_file_actions_addclose(posix_spawn_file_actions_t *fa, int fd) {
  action_t a = { .kind = ACTION_CLOSE, .fd = fd };
  return fa_push(fa, a);
}

int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t *fa,
                                     int fd, int newfd) {
  action_t a = { .kind = ACTION_DUP2, .dup_src = fd, .fd = newfd };
  return fa_push(fa, a);
}

int posix_spawn_file_actions_addchdir_np(posix_spawn_file_actions_t *fa,
                                         const char *path) {
  if (!path) return EINVAL;
  char *path_copy = strdup(path);
  if (!path_copy) return ENOMEM;
  action_t a = { .kind = ACTION_CHDIR, .path = path_copy };
  int rc = fa_push(fa, a);
  if (rc != 0) free(path_copy);
  return rc;
}

/* ─── Attributes ─── */

int posix_spawnattr_init(posix_spawnattr_t *attr) {
  YURT_MARKER_CALL(posix_spawnattr_init);
  if (!attr) { errno = EINVAL; return EINVAL; }
  attr_state_t *s = (attr_state_t *)calloc(1, sizeof(*s));
  if (!s) return ENOMEM;
  attr->__priv = s;
  return 0;
}

int posix_spawnattr_destroy(posix_spawnattr_t *attr) {
  if (!attr || !attr->__priv) return 0;
  free(attr->__priv);
  attr->__priv = NULL;
  return 0;
}

#define ATTR(attr, field, ret) do { \
    if (!(attr) || !(attr)->__priv) return EINVAL; \
    *(ret) = ((attr_state_t *)(attr)->__priv)->field; \
    return 0; \
  } while (0)
#define ATTR_SET(attr, field, val) do { \
    if (!(attr) || !(attr)->__priv) return EINVAL; \
    ((attr_state_t *)(attr)->__priv)->field = (val); \
    return 0; \
  } while (0)

int posix_spawnattr_getflags(const posix_spawnattr_t *attr, short *flags)
  { ATTR(attr, flags, flags); }
int posix_spawnattr_setflags(posix_spawnattr_t *attr, short flags)
  { ATTR_SET(attr, flags, flags); }
int posix_spawnattr_getpgroup(const posix_spawnattr_t *attr, pid_t *pgroup)
  { ATTR(attr, pgroup, pgroup); }
int posix_spawnattr_setpgroup(posix_spawnattr_t *attr, pid_t pgroup)
  { ATTR_SET(attr, pgroup, pgroup); }
int posix_spawnattr_getschedpolicy(const posix_spawnattr_t *attr, int *p)
  { ATTR(attr, schedpolicy, p); }
int posix_spawnattr_setschedpolicy(posix_spawnattr_t *attr, int p)
  { ATTR_SET(attr, schedpolicy, p); }

int posix_spawnattr_getsigmask(const posix_spawnattr_t *__restrict attr,
                               sigset_t *__restrict m) {
  if (!attr || !attr->__priv || !m) return EINVAL;
  *m = ((attr_state_t *)attr->__priv)->sigmask;
  return 0;
}
int posix_spawnattr_setsigmask(posix_spawnattr_t *__restrict attr,
                               const sigset_t *__restrict m) {
  if (!attr || !attr->__priv || !m) return EINVAL;
  ((attr_state_t *)attr->__priv)->sigmask = *m;
  return 0;
}
int posix_spawnattr_getsigdefault(const posix_spawnattr_t *__restrict attr,
                                  sigset_t *__restrict m) {
  if (!attr || !attr->__priv || !m) return EINVAL;
  *m = ((attr_state_t *)attr->__priv)->sigdefault;
  return 0;
}
int posix_spawnattr_setsigdefault(posix_spawnattr_t *__restrict attr,
                                  const sigset_t *__restrict m) {
  if (!attr || !attr->__priv || !m) return EINVAL;
  ((attr_state_t *)attr->__priv)->sigdefault = *m;
  return 0;
}
int posix_spawnattr_getschedparam(const posix_spawnattr_t *__restrict attr,
                                  struct sched_param *__restrict p) {
  if (!attr || !attr->__priv || !p) return EINVAL;
  *p = ((attr_state_t *)attr->__priv)->schedparam;
  return 0;
}
int posix_spawnattr_setschedparam(posix_spawnattr_t *__restrict attr,
                                  const struct sched_param *__restrict p) {
  if (!attr || !attr->__priv || !p) return EINVAL;
  ((attr_state_t *)attr->__priv)->schedparam = *p;
  return 0;
}

/* ─── JSON building ─── */

/* Append a JSON-quoted string into buf at *pos.  Returns 0 on success
 * or -1 if buf would overflow.  Escapes: backslash, dquote, control
 * chars (\b \f \n \r \t and \uXXXX for the rest). */
static int json_emit_string(char *buf, size_t cap, size_t *pos, const char *s) {
  size_t p = *pos;
  if (p + 1 >= cap) return -1;
  buf[p++] = '"';
  for (const unsigned char *u = (const unsigned char *)s; *u; u++) {
    if (p + 6 >= cap) return -1;
    unsigned char c = *u;
    if (c == '"' || c == '\\') {
      buf[p++] = '\\';
      buf[p++] = (char)c;
    } else if (c == '\b') { buf[p++] = '\\'; buf[p++] = 'b'; }
    else if (c == '\f') { buf[p++] = '\\'; buf[p++] = 'f'; }
    else if (c == '\n') { buf[p++] = '\\'; buf[p++] = 'n'; }
    else if (c == '\r') { buf[p++] = '\\'; buf[p++] = 'r'; }
    else if (c == '\t') { buf[p++] = '\\'; buf[p++] = 't'; }
    else if (c < 0x20) {
      int n = snprintf(buf + p, cap - p, "\\u%04x", c);
      if (n < 0 || (size_t)n >= cap - p) return -1;
      p += (size_t)n;
    } else {
      buf[p++] = (char)c;
    }
  }
  if (p + 1 >= cap) return -1;
  buf[p++] = '"';
  *pos = p;
  return 0;
}

static int json_emit_lit(char *buf, size_t cap, size_t *pos, const char *lit) {
  size_t n = strlen(lit);
  if (*pos + n + 1 >= cap) return -1;
  memcpy(buf + *pos, lit, n);
  *pos += n;
  return 0;
}

static int json_emit_int(char *buf, size_t cap, size_t *pos, long long v) {
  int n = snprintf(buf + *pos, cap - *pos, "%lld", v);
  if (n < 0 || (size_t)n >= cap - *pos) return -1;
  *pos += (size_t)n;
  return 0;
}

/* ─── posix_spawn core ─── */

extern char **environ;

/* Resolve the parent fd that should appear at child position
 * `child_fd` after applying file_actions in order.  Initially the
 * child inherits the same fd targets as the parent (so child_fd
 * starts pointing at parent_fd == child_fd).  Each action mutates
 * the simulated child mapping. */
static int resolve_child_fd(const fa_state_t *s, int child_fd,
                            int *opened_fds, int *opened_count, int max_opened) {
  /* Start with default: child fd N comes from parent fd N. */
  int parent_fd = child_fd;

  if (!s) return parent_fd;

  for (int i = 0; i < s->count; i++) {
    const action_t *a = &s->items[i];
    if (a->fd != child_fd) continue;
    switch (a->kind) {
      case ACTION_OPEN: {
        /* Open the file in the parent now; the spawn call will
         * dup it onto the child position.  Store the opened fd so
         * we can close it after the spawn returns. */
        int new_fd = open(a->path, a->oflag, a->mode);
        if (new_fd < 0) {
          /* Bubble open failure up by returning -1. */
          return -1;
        }
        if (*opened_count < max_opened) {
          opened_fds[(*opened_count)++] = new_fd;
        }
        parent_fd = new_fd;
        break;
      }
      case ACTION_CLOSE:
        /* Mark child fd as closed.  We model this as "no source",
         * but our SpawnRequest can't represent a closed stdio fd
         * — skip it and let the runtime use the default (parent's
         * matching fd).  Programs that *really* need a closed fd
         * 0/1/2 in the child are rare. */
        parent_fd = -1;
        break;
      case ACTION_DUP2:
        /* Child fd N := parent's dup_src.  No actual dup happens
         * on the parent side — the SpawnRequest will route the
         * source directly. */
        parent_fd = a->dup_src;
        break;
      case ACTION_CHDIR:
        /* Chdir doesn't affect fd resolution. */
        break;
    }
  }
  return parent_fd;
}

/* Find the most recent ACTION_CHDIR in the file_actions list, or
 * NULL if there isn't one.  The last chdir wins (POSIX-style). */
static const char *resolve_chdir(const fa_state_t *s) {
  if (!s) return NULL;
  const char *last = NULL;
  for (int i = 0; i < s->count; i++) {
    if (s->items[i].kind == ACTION_CHDIR) last = s->items[i].path;
  }
  return last;
}

static int do_posix_spawn(pid_t *pid_out, const char *prog,
                          const posix_spawn_file_actions_t *file_actions,
                          const posix_spawnattr_t *attrp,
                          char *const argv[], char *const envp[]) {
  if (!prog) { errno = EINVAL; return EINVAL; }
  (void)attrp; /* attrs are stored but not honored — see header */

  const fa_state_t *fa = file_actions ? (const fa_state_t *)file_actions->__priv : NULL;

  /* Track parent fds we opened on the child's behalf so we can close
   * them after host_spawn returns. */
  int opened_fds[8];
  int opened_count = 0;

  int stdin_fd  = resolve_child_fd(fa, 0, opened_fds, &opened_count, 8);
  int stdout_fd = resolve_child_fd(fa, 1, opened_fds, &opened_count, 8);
  int stderr_fd = resolve_child_fd(fa, 2, opened_fds, &opened_count, 8);
  if (stdin_fd < 0 && stdin_fd != -1) goto fail_open;
  if (stdout_fd < 0 && stdout_fd != -1) goto fail_open;
  if (stderr_fd < 0 && stderr_fd != -1) goto fail_open;
  /* Treat "closed" (stdin_fd == -1) as inheriting parent fd 0/1/2 —
   * see resolve_child_fd above. */
  if (stdin_fd  == -1) stdin_fd  = 0;
  if (stdout_fd == -1) stdout_fd = 1;
  if (stderr_fd == -1) stderr_fd = 2;

  const char *cwd = resolve_chdir(fa);
  /* Build the SpawnRequest JSON.  64 KB upper bound — anything past
   * that is a degenerate argv/env. */
  char *json = (char *)malloc(65536);
  if (!json) {
    errno = ENOMEM;
    goto fail_open;
  }
  size_t pos = 0;
  size_t cap = 65536;
  if (json_emit_lit(json, cap, &pos, "{\"prog\":") != 0) goto fail_json;
  if (json_emit_string(json, cap, &pos, prog) != 0) goto fail_json;
  if (json_emit_lit(json, cap, &pos, ",\"args\":[") != 0) goto fail_json;
  if (argv) {
    for (int i = 1; argv[i]; i++) {
      if (i > 1 && json_emit_lit(json, cap, &pos, ",") != 0) goto fail_json;
      if (json_emit_string(json, cap, &pos, argv[i]) != 0) goto fail_json;
    }
  }
  if (json_emit_lit(json, cap, &pos, "],\"env\":[") != 0) goto fail_json;
  char *const *env = envp ? envp : environ;
  if (env) {
    int written = 0;
    for (int i = 0; env[i]; i++) {
      const char *eq = strchr(env[i], '=');
      if (!eq) continue;
      if (written > 0 && json_emit_lit(json, cap, &pos, ",") != 0) goto fail_json;
      if (json_emit_lit(json, cap, &pos, "[") != 0) goto fail_json;
      char key[256];
      size_t key_len = (size_t)(eq - env[i]);
      if (key_len >= sizeof(key)) continue;
      memcpy(key, env[i], key_len);
      key[key_len] = '\0';
      if (json_emit_string(json, cap, &pos, key) != 0) goto fail_json;
      if (json_emit_lit(json, cap, &pos, ",") != 0) goto fail_json;
      if (json_emit_string(json, cap, &pos, eq + 1) != 0) goto fail_json;
      if (json_emit_lit(json, cap, &pos, "]") != 0) goto fail_json;
      written++;
    }
  }
  if (json_emit_lit(json, cap, &pos, "]") != 0) goto fail_json;
  if (cwd) {
    if (json_emit_lit(json, cap, &pos, ",\"cwd\":") != 0) goto fail_json;
    if (json_emit_string(json, cap, &pos, cwd) != 0) goto fail_json;
  }
  if (json_emit_lit(json, cap, &pos, ",\"stdin_fd\":") != 0) goto fail_json;
  if (json_emit_int(json, cap, &pos, stdin_fd) != 0) goto fail_json;
  if (json_emit_lit(json, cap, &pos, ",\"stdout_fd\":") != 0) goto fail_json;
  if (json_emit_int(json, cap, &pos, stdout_fd) != 0) goto fail_json;
  if (json_emit_lit(json, cap, &pos, ",\"stderr_fd\":") != 0) goto fail_json;
  if (json_emit_int(json, cap, &pos, stderr_fd) != 0) goto fail_json;
  if (pos + 1 >= cap) goto fail_json;
  json[pos++] = '}';

  int new_pid = yurt_host_spawn((int)(intptr_t)json, (int)pos);
  free(json);

  /* Whether the spawn succeeded or not, drop the fds we opened
   * on the child's behalf — the kernel duplicated them into the
   * child's table during host_spawn. */
  for (int i = 0; i < opened_count; i++) close(opened_fds[i]);

  if (new_pid < 0) {
    errno = EAGAIN;
    return EAGAIN;
  }

  if (pid_out) *pid_out = (pid_t)new_pid;
  return 0;

fail_json:
  free(json);
fail_open:
  for (int i = 0; i < opened_count; i++) close(opened_fds[i]);
  errno = ENOMEM;
  return ENOMEM;
}

int posix_spawn(pid_t *__restrict pid, const char *__restrict path,
                const posix_spawn_file_actions_t *file_actions,
                const posix_spawnattr_t *__restrict attrp,
                char *const argv[__restrict], char *const envp[__restrict]) {
  YURT_MARKER_CALL(posix_spawn);
  /* posix_spawn takes an absolute or relative path — we hand it
   * directly to host_spawn as the program identifier.  The kernel's
   * resolveTool() then maps it to a registered .wasm.  Same logical
   * behavior as posix_spawnp for our purposes since the kernel's
   * tool registry is the only "PATH" the sandbox has. */
  return do_posix_spawn(pid, path, file_actions, attrp, argv, envp);
}

int posix_spawnp(pid_t *__restrict pid, const char *__restrict file,
                 const posix_spawn_file_actions_t *file_actions,
                 const posix_spawnattr_t *__restrict attrp,
                 char *const argv[__restrict], char *const envp[__restrict]) {
  YURT_MARKER_CALL(posix_spawnp);
  return do_posix_spawn(pid, file, file_actions, attrp, argv, envp);
}
