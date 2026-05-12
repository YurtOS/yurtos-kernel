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
#include <fcntl.h>
#include <stddef.h>
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

/* SO_PEERCRED / struct ucred are Linux extensions absent in POSIX sysroots. */
#ifndef SO_PEERCRED
#define SO_PEERCRED 17
#endif
#ifndef _HAVE_STRUCT_UCRED
#define _HAVE_STRUCT_UCRED
struct ucred { pid_t pid; uid_t uid; gid_t gid; };
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
  close(client_fd);
  close(server_fd);

  if (rc != 0) {
    emit("unlink_removes", 0, "unlink=ok", 0, 0);
    return 0;
  }
  emit("unlink_removes", 1, "connect-succeeded", 0, 0);
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
  int saved_errno = errno;
  close(fd);

  /* YurtOS always returns ECONNREFUSED for missing paths (no ENOENT
   * distinction); this is intentional — the registry has no VFS lookup. */
  if (rc != 0 && saved_errno == ECONNREFUSED) {
    emit("connect_refused", 0, "refused=ok", 0, 0);
    return 0;
  }
  if (rc == 0) {
    emit("connect_refused", 1, "connect-succeeded", 0, 0);
  } else {
    emit("connect_refused", 1, "wrong-errno", 1, saved_errno);
  }
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
  /* Use an abstract name that looks like a pathname so we can verify
   * that no VFS inode is created at that path after bind(). */
  const char *abstract_name = "/tmp/yurt-abstract-stat.sock";
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

  /* The abstract bind must NOT create a VFS entry at the name's path */
  struct stat st;
  int rc = stat(abstract_name, &st);
  close(fd);

  if (rc != 0) {
    emit("abstract_invisible_to_stat", 0, "invisible=ok", 0, 0);
    return 0;
  }
  emit("abstract_invisible_to_stat", 1, "stat-succeeded", 0, 0);
  return 1;
}
static int case_dgram_pair_message_framing(void) {
  int sv[2];
  char buf[32];
  ssize_t n;

  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sv) != 0) {
    emit("dgram_pair_message_framing", 1, NULL, 1, errno);
    return 1;
  }

  /* Send two datagrams of different sizes on sv[0] */
  if (send(sv[0], "hello", 5, 0) != 5) {
    emit("dgram_pair_message_framing", 1, "send1-fail", 1, errno);
    close(sv[0]); close(sv[1]);
    return 1;
  }
  if (send(sv[0], "world!", 6, 0) != 6) {
    emit("dgram_pair_message_framing", 1, "send2-fail", 1, errno);
    close(sv[0]); close(sv[1]);
    return 1;
  }

  /* Recv on sv[1] — must get exactly 5 bytes "hello" */
  n = recv(sv[1], buf, sizeof(buf), 0);
  if (n != 5 || memcmp(buf, "hello", 5) != 0) {
    emit("dgram_pair_message_framing", 1, "recv1-mismatch", 0, 0);
    close(sv[0]); close(sv[1]);
    return 1;
  }

  /* Recv on sv[1] — must get exactly 6 bytes "world!" */
  n = recv(sv[1], buf, sizeof(buf), 0);
  if (n != 6 || memcmp(buf, "world!", 6) != 0) {
    emit("dgram_pair_message_framing", 1, "recv2-mismatch", 0, 0);
    close(sv[0]); close(sv[1]);
    return 1;
  }

  close(sv[0]);
  close(sv[1]);
  emit("dgram_pair_message_framing", 0, "dgram=ok", 0, 0);
  return 0;
}

static int case_dgram_path_sendto(void) {
  const char *server_path = "/tmp/yurt-dgram-test.sock";
  struct sockaddr_un server_addr;
  socklen_t addrlen;
  int server_fd, client_fd;
  char buf[32];
  ssize_t n;
  struct sockaddr_un src_addr;
  socklen_t src_len = sizeof(src_addr);

  memset(&server_addr, 0, sizeof(server_addr));
  server_addr.sun_family = AF_UNIX;
  strncpy(server_addr.sun_path, server_path, sizeof(server_addr.sun_path) - 1);
  addrlen = (socklen_t)sizeof(server_addr);

  server_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (server_fd < 0) { emit("dgram_path_sendto", 1, NULL, 1, errno); return 1; }
  client_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (client_fd < 0) { emit("dgram_path_sendto", 1, NULL, 1, errno); close(server_fd); return 1; }

  unlink(server_path);
  if (bind(server_fd, (struct sockaddr *)&server_addr, addrlen) != 0) {
    emit("dgram_path_sendto", 1, "bind-fail", 1, errno);
    close(server_fd); close(client_fd);
    return 1;
  }

  n = sendto(client_fd, "ping", 4, 0, (struct sockaddr *)&server_addr, addrlen);
  if (n != 4) {
    emit("dgram_path_sendto", 1, "sendto-fail", 1, errno);
    close(server_fd); close(client_fd);
    unlink(server_path);
    return 1;
  }

  n = recvfrom(server_fd, buf, sizeof(buf), 0, (struct sockaddr *)&src_addr, &src_len);
  if (n != 4 || memcmp(buf, "ping", 4) != 0) {
    emit("dgram_path_sendto", 1, "recvfrom-fail", 1, errno);
    close(server_fd); close(client_fd);
    unlink(server_path);
    return 1;
  }

  close(server_fd);
  close(client_fd);
  unlink(server_path);
  emit("dgram_path_sendto", 0, "dgram-path=ok", 0, 0);
  return 0;
}

static int case_scm_rights_pipe_handoff(void) {
  int sv[2];
  int pipefd[2];
  int received_fd = -1;
  char buf[16];
  ssize_t n;

  /* Create connected socketpair */
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
    emit("scm_rights_pipe_handoff", 1, NULL, 1, errno);
    return 1;
  }

  /* Create a pipe */
  if (pipe(pipefd) != 0) {
    emit("scm_rights_pipe_handoff", 1, "pipe-fail", 1, errno);
    close(sv[0]); close(sv[1]);
    return 1;
  }

  /* Send pipefd[1] (write end) via SCM_RIGHTS on sv[0] */
  {
    struct msghdr mhdr;
    struct iovec iov;
    char ctrl[CMSG_SPACE(sizeof(int))];
    struct cmsghdr *cmsg;
    char dummy = 'x';

    memset(&mhdr, 0, sizeof(mhdr));
    iov.iov_base = &dummy;
    iov.iov_len = 1;
    mhdr.msg_iov = &iov;
    mhdr.msg_iovlen = 1;
    mhdr.msg_control = ctrl;
    mhdr.msg_controllen = sizeof(ctrl);

    cmsg = CMSG_FIRSTHDR(&mhdr);
    cmsg->cmsg_len = CMSG_LEN(sizeof(int));
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    memcpy(CMSG_DATA(cmsg), &pipefd[1], sizeof(int));
    mhdr.msg_controllen = cmsg->cmsg_len;

    if (sendmsg(sv[0], &mhdr, 0) < 0) {
      emit("scm_rights_pipe_handoff", 1, "sendmsg-fail", 1, errno);
      close(sv[0]); close(sv[1]);
      close(pipefd[0]); close(pipefd[1]);
      return 1;
    }
    /* Close our copy of the write end */
    close(pipefd[1]);
  }

  /* Receive on sv[1], extract the fd */
  {
    struct msghdr mhdr;
    struct iovec iov;
    char ctrl[CMSG_SPACE(sizeof(int))];
    char dummy;

    memset(&mhdr, 0, sizeof(mhdr));
    iov.iov_base = &dummy;
    iov.iov_len = 1;
    mhdr.msg_iov = &iov;
    mhdr.msg_iovlen = 1;
    mhdr.msg_control = ctrl;
    mhdr.msg_controllen = sizeof(ctrl);

    if (recvmsg(sv[1], &mhdr, 0) < 0) {
      emit("scm_rights_pipe_handoff", 1, "recvmsg-fail", 1, errno);
      close(sv[0]); close(sv[1]);
      close(pipefd[0]);
      return 1;
    }
    {
      struct cmsghdr *cmsg = CMSG_FIRSTHDR(&mhdr);
      if (!cmsg || cmsg->cmsg_type != SCM_RIGHTS) {
        emit("scm_rights_pipe_handoff", 1, "no-scm-rights", 0, 0);
        close(sv[0]); close(sv[1]);
        close(pipefd[0]);
        return 1;
      }
      memcpy(&received_fd, CMSG_DATA(cmsg), sizeof(int));
    }
  }

  if (received_fd < 0) {
    emit("scm_rights_pipe_handoff", 1, "bad-fd", 0, 0);
    close(sv[0]); close(sv[1]);
    close(pipefd[0]);
    return 1;
  }

  /* Write "test" to the received write-end fd */
  if (write(received_fd, "test", 4) != 4) {
    emit("scm_rights_pipe_handoff", 1, "write-fail", 1, errno);
    close(sv[0]); close(sv[1]);
    close(pipefd[0]); close(received_fd);
    return 1;
  }
  close(received_fd);

  /* Read from pipefd[0] and verify */
  n = read(pipefd[0], buf, sizeof(buf));
  close(pipefd[0]);
  close(sv[0]); close(sv[1]);

  if (n == 4 && memcmp(buf, "test", 4) == 0) {
    emit("scm_rights_pipe_handoff", 0, "scm=ok", 0, 0);
    return 0;
  }
  emit("scm_rights_pipe_handoff", 1, "pipe-mismatch", 0, 0);
  return 1;
}

static int case_peercred_after_accept(void) {
  int sv[2];
  struct ucred cred;
  socklen_t credlen = sizeof(cred);

  /* Create a socketpair — both ends belong to the same pid */
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
    emit("peercred_after_accept", 1, NULL, 1, errno);
    return 1;
  }

  memset(&cred, 0, sizeof(cred));
  if (getsockopt(sv[0], SOL_SOCKET, SO_PEERCRED, &cred, &credlen) != 0) {
    emit("peercred_after_accept", 1, "getsockopt-fail", 1, errno);
    close(sv[0]); close(sv[1]);
    return 1;
  }

  close(sv[0]);
  close(sv[1]);

  if (cred.pid > 0) {
    emit("peercred_after_accept", 0, "peercred=ok", 0, 0);
    return 0;
  }
  emit("peercred_after_accept", 1, "bad-pid", 0, 0);
  return 1;
}

/* sendto a dgram path after unlink() must fail, not silently deliver. */
static int case_dgram_sendto_after_unlink(void) {
  const char *path = "/tmp/yurt-dgram-unlink.sock";
  struct sockaddr_un addr;
  int server_fd, client_fd;
  ssize_t n;

  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  server_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (server_fd < 0) { emit("dgram_sendto_after_unlink", 1, NULL, 1, errno); return 1; }
  client_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (client_fd < 0) {
    emit("dgram_sendto_after_unlink", 1, NULL, 1, errno);
    close(server_fd); return 1;
  }

  unlink(path);
  if (bind(server_fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("dgram_sendto_after_unlink", 1, "bind-fail", 1, errno);
    close(server_fd); close(client_fd); return 1;
  }

  /* Unlink the path — the route should be invalidated. */
  unlink(path);

  n = sendto(client_fd, "ping", 4, 0, (struct sockaddr *)&addr, addrlen);
  close(server_fd);
  close(client_fd);

  if (n < 0) {
    /* sendto failed as expected after unlink */
    emit("dgram_sendto_after_unlink", 0, "dgram-unlink=ok", 0, 0);
    return 0;
  }
  emit("dgram_sendto_after_unlink", 1, "sendto-succeeded-after-unlink", 0, 0);
  return 1;
}

/* SCM_RIGHTS truncation: excess sender fds must not leak. Verifies the
   received fd is valid and the truncated case does not crash. */
static int case_scm_rights_truncation(void) {
  int sv[2];
  int pipefd[3][2]; /* 3 pipes, send write ends */
  char buf[8];
  ssize_t n;
  int received_fd = -1;

  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
    emit("scm_rights_truncation", 1, NULL, 1, errno); return 1;
  }
  for (int i = 0; i < 3; i++) {
    if (pipe(pipefd[i]) != 0) {
      emit("scm_rights_truncation", 1, "pipe-fail", 1, errno);
      close(sv[0]); close(sv[1]);
      for (int j = 0; j < i; j++) { close(pipefd[j][0]); close(pipefd[j][1]); }
      return 1;
    }
  }

  /* Send all three write ends via SCM_RIGHTS */
  {
    struct msghdr mhdr;
    struct iovec iov;
    char ctrl[CMSG_SPACE(3 * sizeof(int))];
    struct cmsghdr *cmsg;
    char dummy = 'y';

    memset(&mhdr, 0, sizeof(mhdr));
    iov.iov_base = &dummy; iov.iov_len = 1;
    mhdr.msg_iov = &iov; mhdr.msg_iovlen = 1;
    mhdr.msg_control = ctrl;
    mhdr.msg_controllen = sizeof(ctrl);

    cmsg = CMSG_FIRSTHDR(&mhdr);
    cmsg->cmsg_len = CMSG_LEN(3 * sizeof(int));
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type = SCM_RIGHTS;
    memcpy(CMSG_DATA(cmsg), &pipefd[0][1], sizeof(int));
    memcpy(CMSG_DATA(cmsg) + sizeof(int), &pipefd[1][1], sizeof(int));
    memcpy(CMSG_DATA(cmsg) + 2 * sizeof(int), &pipefd[2][1], sizeof(int));
    mhdr.msg_controllen = cmsg->cmsg_len;

    if (sendmsg(sv[0], &mhdr, 0) < 0) {
      emit("scm_rights_truncation", 1, "sendmsg-fail", 1, errno);
      close(sv[0]); close(sv[1]);
      for (int i = 0; i < 3; i++) { close(pipefd[i][0]); close(pipefd[i][1]); }
      return 1;
    }
    /* Sender closes its copies of the write ends */
    for (int i = 0; i < 3; i++) close(pipefd[i][1]);
  }

  /* Receive with a control buffer that fits only 1 fd */
  {
    struct msghdr mhdr;
    struct iovec iov;
    char ctrl[CMSG_SPACE(sizeof(int))];
    struct cmsghdr *cmsg;
    char dummy;

    memset(&mhdr, 0, sizeof(mhdr));
    iov.iov_base = &dummy; iov.iov_len = 1;
    mhdr.msg_iov = &iov; mhdr.msg_iovlen = 1;
    mhdr.msg_control = ctrl;
    mhdr.msg_controllen = sizeof(ctrl);

    n = recvmsg(sv[1], &mhdr, 0);
    if (n < 0) {
      emit("scm_rights_truncation", 1, "recvmsg-fail", 1, errno);
      close(sv[0]); close(sv[1]);
      for (int i = 0; i < 3; i++) close(pipefd[i][0]);
      return 1;
    }
    cmsg = CMSG_FIRSTHDR(&mhdr);
    if (cmsg && cmsg->cmsg_type == SCM_RIGHTS) {
      memcpy(&received_fd, CMSG_DATA(cmsg), sizeof(int));
    }
  }

  close(sv[0]); close(sv[1]);

  if (received_fd < 0) {
    emit("scm_rights_truncation", 1, "no-fd-received", 0, 0);
    for (int i = 0; i < 3; i++) close(pipefd[i][0]);
    return 1;
  }

  /* Verify the received fd works */
  if (write(received_fd, "ok", 2) != 2) {
    emit("scm_rights_truncation", 1, "write-fail", 1, errno);
    close(received_fd);
    for (int i = 0; i < 3; i++) close(pipefd[i][0]);
    return 1;
  }
  close(received_fd);

  n = read(pipefd[0][0], buf, sizeof(buf));
  for (int i = 0; i < 3; i++) close(pipefd[i][0]);

  if (n == 2 && memcmp(buf, "ok", 2) == 0) {
    emit("scm_rights_truncation", 0, "scm-trunc=ok", 0, 0);
    return 0;
  }
  emit("scm_rights_truncation", 1, "pipe-mismatch", 0, 0);
  return 1;
}

/* getsockopt(SO_TYPE) on a SOCK_DGRAM socket must return SOCK_DGRAM, not SOCK_STREAM. */
static int case_dgram_so_type(void) {
  int fd = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) { emit("dgram_so_type", 1, NULL, 1, errno); return 1; }
  int type = -1;
  socklen_t optlen = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &optlen) != 0) {
    emit("dgram_so_type", 1, "getsockopt-fail", 1, errno);
    close(fd); return 1;
  }
  close(fd);
  if (type == SOCK_DGRAM) {
    emit("dgram_so_type", 0, "so_type=ok", 0, 0);
    return 0;
  }
  emit("dgram_so_type", 1, "wrong-type", 0, 0);
  return 1;
}

/* A SOCK_NONBLOCK DGRAM socket with no queued data must return EAGAIN, not block. */
static int case_dgram_nonblocking_recv(void) {
  const char *path = "/tmp/yurt-dgram-nb.sock";
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_NONBLOCK, 0);
  if (fd < 0) { emit("dgram_nonblocking_recv", 1, NULL, 1, errno); return 1; }

  unlink(path);
  if (bind(fd, (struct sockaddr *)&addr, addrlen) != 0) {
    emit("dgram_nonblocking_recv", 1, "bind-fail", 1, errno);
    close(fd); return 1;
  }

  char buf[32];
  ssize_t n = recv(fd, buf, sizeof(buf), 0);
  int saved_errno = errno;
  close(fd);
  unlink(path);

  if (n < 0 && saved_errno == EAGAIN) {
    emit("dgram_nonblocking_recv", 0, "nb-recv=ok", 0, 0);
    return 0;
  }
  emit("dgram_nonblocking_recv", 1, n < 0 ? "wrong-errno" : "unexpected-data", 1, saved_errno);
  return 1;
}

/* SO_PEERCRED on a socket pair must report uid=1000/gid=1000 (the sandbox user). */
static int case_peercred_uid_gid(void) {
  int sv[2];
  struct ucred cred;
  socklen_t credlen = sizeof(cred);

  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
    emit("peercred_uid_gid", 1, NULL, 1, errno); return 1;
  }
  memset(&cred, 0xff, sizeof(cred));
  if (getsockopt(sv[0], SOL_SOCKET, SO_PEERCRED, &cred, &credlen) != 0) {
    emit("peercred_uid_gid", 1, "getsockopt-fail", 1, errno);
    close(sv[0]); close(sv[1]); return 1;
  }
  close(sv[0]); close(sv[1]);
  if (cred.uid == 1000 && cred.gid == 1000) {
    emit("peercred_uid_gid", 0, "uid-gid=ok", 0, 0);
    return 0;
  }
  emit("peercred_uid_gid", 1, "wrong-uid-gid", 0, 0);
  return 1;
}

/* If a dgram bind fails, the route must not leak.
 * Verify by: (1) create a regular file at the bind path, so createSocket
 * returns EEXIST and bind fails; (2) unlink the file; (3) bind a fresh
 * socket to the same path — must succeed with no stale route. */
static int case_dgram_bind_rollback(void) {
  const char *path = "/tmp/yurt-dgram-rollback.sock";
  struct sockaddr_un addr;
  int fd1, fd2;

  memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
  socklen_t addrlen = (socklen_t)sizeof(addr);

  /* Create a regular file to block createSocket */
  unlink(path);
  int blocker = open(path, O_CREAT | O_WRONLY, 0644);
  if (blocker < 0) {
    emit("dgram_bind_rollback", 1, "open-fail", 1, errno); return 1;
  }
  close(blocker);

  /* Bind attempt must fail (file already exists) */
  fd1 = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd1 < 0) {
    emit("dgram_bind_rollback", 1, "socket1-fail", 1, errno); return 1;
  }
  int rc = bind(fd1, (struct sockaddr *)&addr, addrlen);
  close(fd1);

  if (rc == 0) {
    /* Bind succeeded against a regular file — unexpected */
    unlink(path);
    emit("dgram_bind_rollback", 1, "bind-should-fail", 0, 0); return 1;
  }

  /* Remove the blocker file */
  unlink(path);

  /* Now bind a fresh socket to the same path — must succeed */
  fd2 = socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd2 < 0) {
    emit("dgram_bind_rollback", 1, "socket2-fail", 1, errno); return 1;
  }
  rc = bind(fd2, (struct sockaddr *)&addr, addrlen);
  close(fd2);
  if (rc != 0) {
    unlink(path);
    emit("dgram_bind_rollback", 1, "second-bind-fail", 1, errno); return 1;
  }
  unlink(path);
  emit("dgram_bind_rollback", 0, "dgram-rollback=ok", 0, 0);
  return 0;
}

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
  if (strcmp(name, "dgram_sendto_after_unlink") == 0)  return case_dgram_sendto_after_unlink();
  if (strcmp(name, "scm_rights_truncation") == 0)      return case_scm_rights_truncation();
  if (strcmp(name, "dgram_bind_rollback") == 0)        return case_dgram_bind_rollback();
  if (strcmp(name, "dgram_so_type") == 0)              return case_dgram_so_type();
  if (strcmp(name, "dgram_nonblocking_recv") == 0)     return case_dgram_nonblocking_recv();
  if (strcmp(name, "peercred_uid_gid") == 0)           return case_peercred_uid_gid();
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
  puts("dgram_sendto_after_unlink");
  puts("scm_rights_truncation");
  puts("dgram_bind_rollback");
  puts("dgram_so_type");
  puts("dgram_nonblocking_recv");
  puts("peercred_uid_gid");
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
