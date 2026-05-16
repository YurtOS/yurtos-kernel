/* posix_spawn(3) family — built on top of host_spawn.
 *
 * The yurt kernel's host_spawn primitive accepts a native
 * yurt_spawn_request_v1 with `prog`, `args`, `env`, `cwd`, `stdin_fd`,
 * `stdout_fd`, `stderr_fd`, and an optional `argv0` override.  The
 * file-action surface that POSIX exposes is richer (arbitrary
 * open/close/dup2 against arbitrary child fds).  We walk the
 * file_actions list, apply opens to *parent* fds (returning real
 * open fds for the duration of the spawn), simulate the child fd
 * map, pick out the parent fds that end up at child positions 0/1/2,
 * and send explicit parent-fd-to-child-fd mappings for non-stdio file
 * actions.  The kernel also receives a conservative pass_fds list so
 * non-CLOEXEC descriptors such as process-substitution fds can be inherited
 * by the spawned process.
 */

#include "spawn.h"
#include "yurt_abi.h"
#include "yurt_runtime.h"
#include "yurt_markers.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stddef.h>
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

static int child_fd_is_closed(const fa_state_t *s, int fd);

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

/* ─── Native spawn-request building ─── */

typedef struct {
  unsigned char *bytes;
  size_t len;
  size_t cap;
} spawn_record_builder_t;

typedef struct {
  int child_fd;
  int parent_fd;
  int open;
} child_fd_mapping_t;

static int spawn_record_align4(spawn_record_builder_t *b) {
  while ((b->len % 4) != 0) {
    if (b->len >= b->cap) return -1;
    b->bytes[b->len++] = 0;
  }
  return 0;
}

static int spawn_record_append(spawn_record_builder_t *b, const void *data, size_t len,
                               uint32_t *off_out) {
  if (spawn_record_align4(b) != 0) return -1;
  if (b->len > UINT32_MAX || len > UINT32_MAX || b->len + len > b->cap) return -1;
  *off_out = (uint32_t)b->len;
  memcpy(b->bytes + b->len, data, len);
  b->len += len;
  return 0;
}

static int spawn_record_span(spawn_record_builder_t *b, yurt_abi_span_v1 *span,
                             const char *value) {
  uint32_t off;
  size_t len;
  if (!value || value[0] == '\0') {
    span->off = 0;
    span->len = 0;
    return 0;
  }
  len = strlen(value);
  if (spawn_record_append(b, value, len, &off) != 0) return -1;
  span->off = off;
  span->len = (uint32_t)len;
  return 0;
}

static int spawn_record_span_allow_empty(spawn_record_builder_t *b, yurt_abi_span_v1 *span,
                                         const char *value) {
  uint32_t off;
  size_t len = value ? strlen(value) : 0;
  if (spawn_record_append(b, value ? value : "", len, &off) != 0) return -1;
  span->off = off;
  span->len = (uint32_t)len;
  return 0;
}

static int spawn_record_args(spawn_record_builder_t *b, yurt_spawn_request_v1 *req,
                             char *const argv[]) {
  int count = 0;
  uint32_t off;
  yurt_abi_span_v1 *spans;
  if (argv) {
    while (argv[count + 1]) count++;
  }
  if (count == 0) return 0;
  if (spawn_record_align4(b) != 0) return -1;
  if (b->len + sizeof(yurt_abi_span_v1) * (size_t)count > b->cap) return -1;
  off = (uint32_t)b->len;
  b->len += sizeof(yurt_abi_span_v1) * (size_t)count;
  spans = (yurt_abi_span_v1 *)(void *)(b->bytes + off);
  memset(spans, 0, sizeof(yurt_abi_span_v1) * (size_t)count);
  req->args_off = off;
  req->args_count = (uint32_t)count;
  for (int i = 0; i < count; i++) {
    if (spawn_record_span_allow_empty(b, &spans[i], argv[i + 1]) != 0) return -1;
  }
  return 0;
}

static int spawn_record_env(spawn_record_builder_t *b, yurt_spawn_request_v1 *req,
                            char *const env[]) {
  int count = 0;
  uint32_t off;
  yurt_abi_env_pair_v1 *pairs;
  if (env) {
    for (int i = 0; env[i]; i++) {
      if (strchr(env[i], '=')) count++;
    }
  }
  if (count == 0) return 0;
  if (spawn_record_align4(b) != 0) return -1;
  if (b->len + sizeof(yurt_abi_env_pair_v1) * (size_t)count > b->cap) return -1;
  off = (uint32_t)b->len;
  b->len += sizeof(yurt_abi_env_pair_v1) * (size_t)count;
  pairs = (yurt_abi_env_pair_v1 *)(void *)(b->bytes + off);
  memset(pairs, 0, sizeof(yurt_abi_env_pair_v1) * (size_t)count);
  req->env_off = off;
  req->env_count = (uint32_t)count;
  count = 0;
  for (int i = 0; env[i]; i++) {
    const char *eq = strchr(env[i], '=');
    if (!eq) continue;
    size_t key_len = (size_t)(eq - env[i]);
    uint32_t key_off;
    yurt_abi_span_v1 value_span;
    if (spawn_record_append(b, env[i], key_len, &key_off) != 0) return -1;
    pairs[count].key_off = key_off;
    pairs[count].key_len = (uint32_t)key_len;
    if (spawn_record_span_allow_empty(b, &value_span, eq + 1) != 0) return -1;
    pairs[count].value_off = value_span.off;
    pairs[count].value_len = value_span.len;
    count++;
  }
  return 0;
}

static int child_fd_is_explicitly_mapped(const child_fd_mapping_t *maps, int count, int fd) {
  for (int i = 0; i < count; i++) {
    if (maps[i].child_fd == fd) return maps[i].open;
  }
  return 0;
}

static int spawn_record_pass_fds(spawn_record_builder_t *b, yurt_spawn_request_v1 *req,
                                 const fa_state_t *fa,
                                 const child_fd_mapping_t *maps, int map_count) {
  uint32_t off;
  uint32_t count = 0;
  int32_t *fds;
  for (int fd = 3; fd < 2048; fd++) {
    if (!child_fd_is_closed(fa, fd) &&
        !child_fd_is_explicitly_mapped(maps, map_count, fd)) {
      count++;
    }
  }
  if (count == 0) return 0;
  if (spawn_record_align4(b) != 0) return -1;
  if (b->len + sizeof(int32_t) * (size_t)count > b->cap) return -1;
  off = (uint32_t)b->len;
  b->len += sizeof(int32_t) * (size_t)count;
  fds = (int32_t *)(void *)(b->bytes + off);
  count = 0;
  for (int fd = 3; fd < 2048; fd++) {
    if (!child_fd_is_closed(fa, fd) && !child_fd_is_explicitly_mapped(maps, map_count, fd)) {
      fds[count++] = fd;
    }
  }
  req->pass_fds_off = off;
  req->pass_fds_count = count;
  return 0;
}

static int spawn_record_fd_map(spawn_record_builder_t *b, yurt_spawn_request_v1 *req,
                               const child_fd_mapping_t *maps, int map_count) {
  uint32_t count = 0;
  for (int i = 0; i < map_count; i++) {
    if (maps[i].open && maps[i].child_fd >= 3) count++;
  }
  if (count == 0) return 0;
  if (spawn_record_align4(b) != 0) return -1;
  if (b->len + sizeof(yurt_spawn_fd_map_v1) * (size_t)count > b->cap) return -1;
  uint32_t off = (uint32_t)b->len;
  b->len += sizeof(yurt_spawn_fd_map_v1) * (size_t)count;
  yurt_spawn_fd_map_v1 *pairs = (yurt_spawn_fd_map_v1 *)(void *)(b->bytes + off);
  count = 0;
  for (int i = 0; i < map_count; i++) {
    if (!maps[i].open || maps[i].child_fd < 3) continue;
    pairs[count].parent_fd = maps[i].parent_fd;
    pairs[count].child_fd = maps[i].child_fd;
    count++;
  }
  req->fd_map_off = off;
  req->fd_map_count = count;
  return 0;
}

/* ─── posix_spawn core ─── */

extern char **environ;

/* Resolve the parent fds that should appear in the child after applying
 * file_actions in POSIX order.  A dup2 action observes earlier actions in the
 * child fd table: `>file 2>&1` must route both fd 1 and fd 2 to the opened
 * file, not to the parent's original stdout. */
static int set_child_mapping(child_fd_mapping_t *maps, int *map_count, int max_maps,
                             int child_fd, int parent_fd, int open) {
  if (child_fd < 0) {
    errno = EBADF;
    return -1;
  }
  for (int i = 0; i < *map_count; i++) {
    if (maps[i].child_fd == child_fd) {
      maps[i].parent_fd = parent_fd;
      maps[i].open = open;
      return 0;
    }
  }
  if (*map_count >= max_maps) {
    errno = ENOMEM;
    return -1;
  }
  maps[*map_count].child_fd = child_fd;
  maps[*map_count].parent_fd = parent_fd;
  maps[*map_count].open = open;
  (*map_count)++;
  return 0;
}

static int resolve_child_parent_fd(const child_fd_mapping_t *maps, int map_count,
                                   int child_fd, int *parent_fd) {
  if (child_fd < 0) {
    errno = EBADF;
    return -1;
  }
  for (int i = 0; i < map_count; i++) {
    if (maps[i].child_fd != child_fd) continue;
    if (!maps[i].open) {
      errno = EBADF;
      return -1;
    }
    *parent_fd = maps[i].parent_fd;
    return 0;
  }
  *parent_fd = child_fd;
  return 0;
}

static int resolve_spawn_fds(const fa_state_t *s, int stdio_fds[3],
                             child_fd_mapping_t *maps, int *map_count, int max_maps,
                             int *opened_fds, int *opened_count, int max_opened) {
  stdio_fds[0] = 0;
  stdio_fds[1] = 1;
  stdio_fds[2] = 2;
  *map_count = 0;

  if (!s) return 0;

  for (int i = 0; i < s->count; i++) {
    const action_t *a = &s->items[i];
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
        if (*opened_count >= max_opened) {
          close(new_fd);
          errno = ENOMEM;
          return -1;
        }
        opened_fds[(*opened_count)++] = new_fd;
        if (set_child_mapping(maps, map_count, max_maps, a->fd, new_fd, 1) != 0) return -1;
        if (a->fd >= 0 && a->fd <= 2) stdio_fds[a->fd] = new_fd;
        break;
      }
      case ACTION_CLOSE:
        if (set_child_mapping(maps, map_count, max_maps, a->fd, -1, 0) != 0) return -1;
        /* Mark child fd as closed.  We model this as "no source",
         * but our SpawnRequest can't represent a closed stdio fd
         * — skip it and let the runtime use the default (parent's
         * matching fd).  Programs that *really* need a closed fd
         * 0/1/2 in the child are rare. */
        if (a->fd >= 0 && a->fd <= 2) stdio_fds[a->fd] = -1;
        break;
      case ACTION_DUP2: {
        /* Child fd N := current child dup_src.  No actual dup happens
         * on the parent side; SpawnRequest routes the resolved source. */
        int parent_fd = -1;
        if (resolve_child_parent_fd(maps, *map_count, a->dup_src, &parent_fd) != 0) return -1;
        if (set_child_mapping(maps, map_count, max_maps, a->fd, parent_fd, 1) != 0) return -1;
        if (a->fd >= 0 && a->fd <= 2) stdio_fds[a->fd] = parent_fd;
        break;
      }
      case ACTION_CHDIR:
        /* Chdir doesn't affect fd resolution. */
        break;
    }
  }
  return 0;
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

static int child_fd_is_closed(const fa_state_t *s, int fd) {
  if (!s) return 0;
  int closed = 0;
  for (int i = 0; i < s->count; i++) {
    const action_t *a = &s->items[i];
    if (a->fd != fd) continue;
    if (a->kind == ACTION_CLOSE) {
      closed = 1;
    } else if (a->kind == ACTION_OPEN || a->kind == ACTION_DUP2) {
      closed = 0;
    }
  }
  return closed;
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
  int action_cap = fa && fa->count > 0 ? fa->count : 1;
  int *opened_fds = (int *)calloc((size_t)action_cap, sizeof(int));
  child_fd_mapping_t *fd_maps = (child_fd_mapping_t *)calloc((size_t)action_cap, sizeof(*fd_maps));
  if (!opened_fds || !fd_maps) {
    free(opened_fds);
    free(fd_maps);
    errno = ENOMEM;
    return ENOMEM;
  }
  int opened_count = 0;
  int fd_map_count = 0;

  int stdio_fds[3];
  if (resolve_spawn_fds(fa, stdio_fds, fd_maps, &fd_map_count, action_cap,
                        opened_fds, &opened_count, action_cap) != 0) goto fail_open;
  int stdin_fd  = stdio_fds[0];
  int stdout_fd = stdio_fds[1];
  int stderr_fd = stdio_fds[2];
  if (stdin_fd < 0 && stdin_fd != -1) goto fail_open;
  if (stdout_fd < 0 && stdout_fd != -1) goto fail_open;
  if (stderr_fd < 0 && stderr_fd != -1) goto fail_open;
  /* Keep "closed" stdio as -1. SpawnRequest consumers model that as
   * no child fd entry instead of silently inheriting the parent's
   * matching fd. */

  const char *cwd = resolve_chdir(fa);
  unsigned char *record = (unsigned char *)calloc(1, 65536);
  if (!record) {
    errno = ENOMEM;
    goto fail_open;
  }
  spawn_record_builder_t builder = {
    .bytes = record,
    .len = sizeof(yurt_spawn_request_v1),
    .cap = 65536,
  };
  yurt_spawn_request_v1 *req = (yurt_spawn_request_v1 *)(void *)record;
  req->header.version = YURT_ABI_RECORD_VERSION_1;
  req->stdin_fd = stdin_fd;
  req->stdout_fd = stdout_fd;
  req->stderr_fd = stderr_fd;

  if (spawn_record_span(&builder, &req->prog, prog) != 0) goto fail_record;
  if (argv && argv[0] && spawn_record_span_allow_empty(&builder, &req->argv0, argv[0]) != 0) goto fail_record;
  if (spawn_record_args(&builder, req, argv) != 0) goto fail_record;
  char *const *env = envp ? envp : environ;
  if (spawn_record_env(&builder, req, env) != 0) goto fail_record;
  if (cwd && spawn_record_span(&builder, &req->cwd, cwd) != 0) goto fail_record;
  if (spawn_record_pass_fds(&builder, req, fa, fd_maps, fd_map_count) != 0) goto fail_record;
  if (spawn_record_fd_map(&builder, req, fd_maps, fd_map_count) != 0) goto fail_record;
  req->header.size = (uint32_t)builder.len;

  yurt_spawn_result_v1 spawn_result = { .pid = -1 };
  int written = yurt_host_spawn((int)(intptr_t)record, (int)builder.len,
                                (int)(intptr_t)&spawn_result, (int)sizeof(spawn_result));
  free(record);

  /* Whether the spawn succeeded or not, drop the fds we opened
   * on the child's behalf — the kernel duplicated them into the
   * child's table during host_spawn. */
  for (int i = 0; i < opened_count; i++) close(opened_fds[i]);
  free(opened_fds);
  free(fd_maps);

  if (written != (int)sizeof(spawn_result) || spawn_result.pid < 0) {
    int err = EAGAIN;
    int code = written < 0 ? written : spawn_result.pid;
    if (code == -1) err = ENOENT;
    else if (code == -2) err = EACCES;
    else if (code == -22) err = EINVAL;
    else if (code == -38) err = ENOSYS;
    errno = err;
    return err;
  }

  if (pid_out) *pid_out = (pid_t)spawn_result.pid;
  return 0;

fail_record:
  free(record);
fail_open:
  {
    int saved_errno = errno ? errno : ENOMEM;
    for (int i = 0; i < opened_count; i++) close(opened_fds[i]);
    free(opened_fds);
    free(fd_maps);
    errno = saved_errno;
    return saved_errno;
  }
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
