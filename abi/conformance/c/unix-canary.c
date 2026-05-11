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
#include <sys/un.h>
#include <unistd.h>

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

static int case_pair_basic(void)                 { return pending("pair_basic"); }
static int case_bind_listen_accept(void)         { return pending("bind_listen_accept"); }
static int case_stat_socket_inode(void)          { return pending("stat_socket_inode"); }
static int case_unlink_removes(void)             { return pending("unlink_removes"); }
static int case_connect_refused(void)            { return pending("connect_refused"); }
static int case_abstract_bind_connect(void)      { return pending("abstract_bind_connect"); }
static int case_abstract_invisible_to_stat(void) { return pending("abstract_invisible_to_stat"); }
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
