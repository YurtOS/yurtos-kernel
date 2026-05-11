#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

struct popen_entry {
  FILE *stream;
  pid_t pid;
  struct popen_entry *next;
};

static struct popen_entry *popen_streams = NULL;

static int wait_for_status(pid_t pid) {
  int status = 0;

  for (;;) {
    if (waitpid(pid, &status, 0) >= 0) {
      return status;
    }
    if (errno != EINTR) {
      return -1;
    }
  }
}

static int remember_popen_stream(FILE *stream, pid_t pid) {
  struct popen_entry *entry = malloc(sizeof(*entry));
  if (!entry) {
    errno = ENOMEM;
    return -1;
  }

  entry->stream = stream;
  entry->pid = pid;
  entry->next = popen_streams;
  popen_streams = entry;
  return 0;
}

static struct popen_entry *detach_popen_stream(FILE *stream) {
  struct popen_entry **cursor = &popen_streams;
  while (*cursor) {
    struct popen_entry *entry = *cursor;
    if (entry->stream == stream) {
      *cursor = entry->next;
      return entry;
    }
    cursor = &entry->next;
  }
  return NULL;
}

int system(const char *cmd) {
  pid_t pid;
  char *argv[] = { "sh", "-c", (char *)cmd, NULL };
  int rc;

  if (!cmd) {
    return 1;
  }

  rc = posix_spawn(&pid, "/bin/sh", NULL, NULL, argv, environ);
  if (rc != 0) {
    errno = rc;
    return -1;
  }

  return wait_for_status(pid);
}

FILE *popen(const char *cmd, const char *mode) {
  int fds[2] = { -1, -1 };
  posix_spawn_file_actions_t actions;
  int actions_initialized = 0;
  pid_t pid;
  char *argv[] = { "sh", "-c", (char *)cmd, NULL };
  FILE *stream;
  int rc;

  if (!cmd || !mode) {
    errno = EINVAL;
    return NULL;
  }
  if (strcmp(mode, "r") != 0) {
    errno = ENOTSUP;
    return NULL;
  }

  if (pipe(fds) != 0) {
    return NULL;
  }
  if (posix_spawn_file_actions_init(&actions) != 0) {
    goto fail;
  }
  actions_initialized = 1;

  if (
    posix_spawn_file_actions_addclose(&actions, fds[0]) != 0 ||
    posix_spawn_file_actions_adddup2(&actions, fds[1], STDOUT_FILENO) != 0 ||
    posix_spawn_file_actions_addclose(&actions, fds[1]) != 0
  ) {
    goto fail;
  }

  rc = posix_spawn(&pid, "/bin/sh", &actions, NULL, argv, environ);
  if (rc != 0) {
    errno = rc;
    goto fail;
  }

  close(fds[1]);
  fds[1] = -1;
  posix_spawn_file_actions_destroy(&actions);
  actions_initialized = 0;

  stream = fdopen(fds[0], "r");
  if (!stream) {
    close(fds[0]);
    wait_for_status(pid);
    return NULL;
  }
  fds[0] = -1;

  if (remember_popen_stream(stream, pid) != 0) {
    fclose(stream);
    wait_for_status(pid);
    return NULL;
  }

  return stream;

fail:
  if (actions_initialized) {
    posix_spawn_file_actions_destroy(&actions);
  }
  if (fds[0] >= 0) {
    close(fds[0]);
  }
  if (fds[1] >= 0) {
    close(fds[1]);
  }
  return NULL;
}

int pclose(FILE *stream) {
  struct popen_entry *entry;
  int close_rc;
  int status;
  pid_t pid;

  if (!stream) {
    errno = EINVAL;
    return -1;
  }

  entry = detach_popen_stream(stream);
  if (!entry) {
    errno = EINVAL;
    return -1;
  }

  pid = entry->pid;
  free(entry);

  close_rc = fclose(stream);
  if (close_rc != 0) {
    return -1;
  }
  status = wait_for_status(pid);
  if (status < 0) {
    return -1;
  }
  return status;
}
