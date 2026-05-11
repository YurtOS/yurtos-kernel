/*
 * unix-canary — exercises the AF_UNIX socket contract.
 *
 * Spec: docs/superpowers/specs/2026-05-11-af-unix-design.md
 * Plan: docs/superpowers/plans/2026-05-11-af-unix.md
 *
 * Slice 1 ships this source plus the test-side `describe.skip` block
 * that pins the contract in code. Each case stays in `it.skip` until
 * its owning slice lands the backing implementation. The canary itself
 * is intentionally pessimistic at this point: every case emits
 *
 *     {"case":"...","exit":99,"stdout":"pending-impl"}
 *
 * and returns 99, so the C source compiles cleanly against the current
 * libyurt (which still rejects AF_UNIX with EAFNOSUPPORT) and CI stays
 * green. Cases get real bodies as their slices land — slice 2 wires the
 * five core SOCK_STREAM cases, slice 3 the two abstract cases, etc.
 */

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/* S_IFSOCK / S_ISSOCK may be absent in some wasi-sdk sysroots. */
#ifndef S_IFMT
#define S_IFMT 0170000
#endif
#ifndef S_IFSOCK
#define S_IFSOCK 0140000
#endif
#ifndef S_ISSOCK
#define S_ISSOCK(m) (((m) & S_IFMT) == S_IFSOCK)
#endif

/* Print one JSONL trace line. Same convention as dup2-canary.c. */
static void emit(const char *case_name,
                 int exit_code,
                 const char *stdout_line,
                 int has_errno,
                 int errno_value) {
  printf("{\"case\":\"%s\",\"exit\":%d", case_name, exit_code);
  if (stdout_line) {
    printf(",\"stdout\":\"%s\"", stdout_line);
  }
  if (has_errno) {
    printf(",\"errno\":%d", errno_value);
  }
  printf("}\n");
}

/* All cases share this body until their slice lands.
 *
 * Reading the case-implementation slices upstream:
 *   slice 2 — pair_basic, bind_listen_accept, stat_socket_inode,
 *             unlink_removes, connect_refused
 *   slice 3 — abstract_bind_connect, abstract_invisible_to_stat
 *   slice 4 — dgram_pair_message_framing, dgram_path_sendto
 *   slice 5 — scm_rights_pipe_handoff
 *   slice 6 — peercred_after_accept
 */
static int pending(const char *case_name) {
  emit(case_name, 99, "pending-impl", 0, 0);
  return 99;
}

static int case_pair_basic(void) {
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
    emit("pair_basic", 1, NULL, 1, errno);
    return 1;
  }
  send(sv[1], "hello", 5, 0);
  char buf[16];
  ssize_t n = recv(sv[0], buf, 16, 0);
  close(sv[0]);
  close(sv[1]);
  if (n == 5 && memcmp(buf, "hello", 5) == 0) {
    emit("pair_basic", 0, "pair=ok", 0, 0);
    return 0;
  }
  emit("pair_basic", 1, "mismatch", 0, 0);
  return 1;
}

static int case_bind_listen_accept(void) {
  const char *path = "/tmp/yurt-test-unix.sock";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server_fd < 0) { emit("bind_listen_accept", 1, NULL, 1, errno); return 1; }
  unlink(path); /* clean up any leftover */
  if (bind(server_fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("bind_listen_accept", 1, NULL, 1, errno);
    close(server_fd);
    return 1;
  }
  if (listen(server_fd, 1) != 0) {
    emit("bind_listen_accept", 1, NULL, 1, errno);
    close(server_fd);
    unlink(path);
    return 1;
  }

  int client_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (client_fd < 0) {
    emit("bind_listen_accept", 1, NULL, 1, errno);
    close(server_fd);
    unlink(path);
    return 1;
  }
  if (connect(client_fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("bind_listen_accept", 1, NULL, 1, errno);
    close(client_fd);
    close(server_fd);
    unlink(path);
    return 1;
  }

  int accepted_fd = accept(server_fd, NULL, NULL);
  if (accepted_fd < 0) {
    emit("bind_listen_accept", 1, NULL, 1, errno);
    close(client_fd);
    close(server_fd);
    unlink(path);
    return 1;
  }

  send(accepted_fd, "world", 5, 0);
  char buf[16];
  ssize_t n = recv(client_fd, buf, 16, 0);
  close(accepted_fd);
  close(client_fd);
  close(server_fd);
  unlink(path);

  if (n == 5 && memcmp(buf, "world", 5) == 0) {
    emit("bind_listen_accept", 0, "bla=ok", 0, 0);
    return 0;
  }
  emit("bind_listen_accept", 1, "mismatch", 0, 0);
  return 1;
}

static int case_stat_socket_inode(void) {
  const char *path = "/tmp/yurt-test-stat.sock";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { emit("stat_socket_inode", 1, NULL, 1, errno); return 1; }
  unlink(path);
  if (bind(fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("stat_socket_inode", 1, NULL, 1, errno);
    close(fd);
    return 1;
  }

  struct stat st;
  if (stat(path, &st) != 0) {
    emit("stat_socket_inode", 1, NULL, 1, errno);
    close(fd);
    unlink(path);
    return 1;
  }

  close(fd);
  unlink(path);

  if (S_ISSOCK(st.st_mode)) {
    emit("stat_socket_inode", 0, "ifsock=ok", 0, 0);
    return 0;
  }
  emit("stat_socket_inode", 1, "not-ifsock", 0, 0);
  return 1;
}

static int case_unlink_removes(void) {
  const char *path = "/tmp/yurt-test-unlink.sock";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server_fd < 0) { emit("unlink_removes", 1, NULL, 1, errno); return 1; }
  unlink(path);
  if (bind(server_fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("unlink_removes", 1, NULL, 1, errno);
    close(server_fd);
    return 1;
  }
  listen(server_fd, 1);

  unlink(path);

  int client_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (client_fd < 0) {
    emit("unlink_removes", 1, NULL, 1, errno);
    close(server_fd);
    return 1;
  }
  int rc = connect(client_fd, (struct sockaddr *)&addr, addrlen);
  int saved_errno = errno;
  close(client_fd);
  close(server_fd);

  if (rc != 0) {
    emit("unlink_removes", 0, "unlink=ok", 0, 0);
    return 0;
  }
  emit("unlink_removes", 1, "connect-succeeded", 0, 0);
  (void)saved_errno;
  return 1;
}

static int case_connect_refused(void) {
  const char *path = "/tmp/yurt-test-noexist-9999.sock";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { emit("connect_refused", 1, NULL, 1, errno); return 1; }
  int rc = connect(fd, (struct sockaddr *)&addr, addrlen);
  close(fd);

  if (rc != 0) {
    emit("connect_refused", 0, "refused=ok", 0, 0);
    return 0;
  }
  emit("connect_refused", 1, "connect-succeeded", 0, 0);
  return 1;
}
static int case_abstract_bind_connect(void) {
  const char *abstract_name = "yurt-test";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  /* abstract address: sun_path[0] = '\0', name follows */
  strncpy(addr.sun_path + 1, abstract_name, sizeof(addr.sun_path) - 2);
  socklen_t addrlen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(abstract_name));

  int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server_fd < 0) { emit("abstract_bind_connect", 1, NULL, 1, errno); return 1; }
  if (bind(server_fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("abstract_bind_connect", 1, NULL, 1, errno);
    close(server_fd);
    return 1;
  }
  if (listen(server_fd, 1) != 0) {
    emit("abstract_bind_connect", 1, NULL, 1, errno);
    close(server_fd);
    return 1;
  }

  int client_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (client_fd < 0) {
    emit("abstract_bind_connect", 1, NULL, 1, errno);
    close(server_fd);
    return 1;
  }
  if (connect(client_fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("abstract_bind_connect", 1, NULL, 1, errno);
    close(client_fd);
    close(server_fd);
    return 1;
  }

  int accepted_fd = accept(server_fd, NULL, NULL);
  if (accepted_fd < 0) {
    emit("abstract_bind_connect", 1, NULL, 1, errno);
    close(client_fd);
    close(server_fd);
    return 1;
  }

  send(accepted_fd, "hello", 5, 0);
  char buf[16];
  ssize_t n = recv(client_fd, buf, 16, 0);
  close(accepted_fd);
  close(client_fd);
  close(server_fd);

  if (n == 5 && memcmp(buf, "hello", 5) == 0) {
    emit("abstract_bind_connect", 0, "abstract=ok", 0, 0);
    return 0;
  }
  emit("abstract_bind_connect", 1, "mismatch", 0, 0);
  return 1;
}

static int case_abstract_invisible_to_stat(void) {
  const char *abstract_name = "yurt-stat-test";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path + 1, abstract_name, sizeof(addr.sun_path) - 2);
  socklen_t addrlen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(abstract_name));

  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) { emit("abstract_invisible_to_stat", 1, NULL, 1, errno); return 1; }
  if (bind(fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("abstract_invisible_to_stat", 1, NULL, 1, errno);
    close(fd);
    return 1;
  }

  /* The abstract name must NOT appear in the VFS — stat should fail */
  char vfs_path[128];
  snprintf(vfs_path, sizeof(vfs_path), "/%s", abstract_name);
  struct stat st;
  int rc = stat(vfs_path, &st);
  close(fd);

  if (rc != 0) {
    /* stat failed as expected — abstract socket is invisible */
    emit("abstract_invisible_to_stat", 0, "invisible=ok", 0, 0);
    return 0;
  }
  emit("abstract_invisible_to_stat", 1, "stat-succeeded", 0, 0);
  return 1;
}
static int case_dgram_pair_message_framing(void) { return pending("dgram_pair_message_framing"); }
static int case_dgram_path_sendto(void)          { return pending("dgram_path_sendto"); }
static int case_scm_rights_pipe_handoff(void)    { return pending("scm_rights_pipe_handoff"); }
static int case_peercred_after_accept(void)      { return pending("peercred_after_accept"); }

static int run_case(const char *name) {
  if (strcmp(name, "pair_basic") == 0)                 return case_pair_basic();
  if (strcmp(name, "bind_listen_accept") == 0)         return case_bind_listen_accept();
  if (strcmp(name, "stat_socket_inode") == 0)          return case_stat_socket_inode();
  if (strcmp(name, "unlink_removes") == 0)             return case_unlink_removes();
  if (strcmp(name, "connect_refused") == 0)            return case_connect_refused();
  if (strcmp(name, "abstract_bind_connect") == 0)      return case_abstract_bind_connect();
  if (strcmp(name, "abstract_invisible_to_stat") == 0) return case_abstract_invisible_to_stat();
  if (strcmp(name, "dgram_pair_message_framing") == 0) return case_dgram_pair_message_framing();
  if (strcmp(name, "dgram_path_sendto") == 0)          return case_dgram_path_sendto();
  if (strcmp(name, "scm_rights_pipe_handoff") == 0)    return case_scm_rights_pipe_handoff();
  if (strcmp(name, "peercred_after_accept") == 0)      return case_peercred_after_accept();
  fprintf(stderr, "unix-canary: unknown case %s\n", name);
  return 2;
}

static int list_cases(void) {
  puts("pair_basic");
  puts("bind_listen_accept");
  puts("stat_socket_inode");
  puts("unlink_removes");
  puts("connect_refused");
  puts("abstract_bind_connect");
  puts("abstract_invisible_to_stat");
  puts("dgram_pair_message_framing");
  puts("dgram_path_sendto");
  puts("scm_rights_pipe_handoff");
  puts("peercred_after_accept");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 1) {
    /* Smoke mode — runs pair_basic, which is the first case slice 2
     * will wire up. Until then it returns 99 like everything else. */
    return case_pair_basic();
  }
  if (argc == 2 && strcmp(argv[1], "--list-cases") == 0) {
    return list_cases();
  }
  if (argc == 3 && strcmp(argv[1], "--case") == 0) {
    return run_case(argv[2]);
  }
  fprintf(stderr, "usage: unix-canary [--case <name> | --list-cases]\n");
  return 2;
}
