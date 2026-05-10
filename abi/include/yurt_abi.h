#ifndef YURT_ABI_H
#define YURT_ABI_H

#include <stdint.h>
#include <stdio.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Kernel ABI version — the major/minor of the host/guest
 * protocol (host imports, signal numbers, etc.).  Separate from the
 * yurt product version below: a host running kernel ABI 2.x
 * still ships yurt 0.1.x. */
#define YURT_ABI_VERSION_MAJOR 1u
#define YURT_ABI_VERSION_MINOR 0u

/* Yurt product version — surfaced through uname utsname.release
 * / .version, /proc/version, and banner output.  Sourced from the
 * top-level VERSION file by scripts/sync-version.sh — DO NOT edit
 * by hand; bump VERSION and re-run the script.  String form is what
 * the C side uses; the numeric form below covers any callers that
 * need to compare versions programmatically. */
#define YURT_VERSION_STR    "0.1.0"
#define YURT_VERSION_MAJOR  0u
#define YURT_VERSION_MINOR  1u
#define YURT_VERSION_PATCH  0u

#define YURT_WAIT_NOHANG 1u
#define YURT_ABI_RECORD_VERSION_1 1u

typedef struct {
  uint32_t size;
  uint16_t version;
  uint16_t flags;
} yurt_abi_record_header;

typedef struct {
  uint32_t off;
  uint32_t len;
} yurt_abi_span_v1;

typedef struct {
  uint32_t key_off;
  uint32_t key_len;
  uint32_t value_off;
  uint32_t value_len;
} yurt_abi_env_pair_v1;

typedef struct {
  int32_t parent_fd;
  int32_t child_fd;
} yurt_spawn_fd_map_v1;

typedef struct {
  yurt_abi_record_header header;
  yurt_abi_span_v1 prog;
  yurt_abi_span_v1 argv0;
  uint32_t args_off;
  uint32_t args_count;
  uint32_t env_off;
  uint32_t env_count;
  yurt_abi_span_v1 cwd;
  int32_t stdin_fd;
  int32_t stdout_fd;
  int32_t stderr_fd;
  uint32_t pass_fds_off;
  uint32_t pass_fds_count;
  yurt_abi_span_v1 stdin_data;
  int32_t nice;
  uint32_t fd_map_off;
  uint32_t fd_map_count;
} yurt_spawn_request_v1;

typedef struct {
  int32_t pid;
  int32_t exit_code;
  int32_t signal;
  int32_t flags;
} yurt_wait_result_v1;

typedef struct {
  int32_t read_fd;
  int32_t write_fd;
} yurt_pipe_result_v1;

typedef struct {
  int32_t pid;
} yurt_spawn_result_v1;

extern uint32_t yurt_abi_version;

/*
 * Narrow Phase A command-execution shim for yurt guests, part of the
 * yurt kernel ABI runtime (see
 * docs/superpowers/specs/2026-04-19-ABI-runtime-design.md).
 *
 * This is a yurt extension layer on top of wasi-libc, not a POSIX process
 * API. Only read-mode popen is supported, and yurt_pclose() returns the
 * captured raw exit code from the completed command.
 */
int yurt_system(const char *cmd);
FILE *yurt_popen(const char *cmd, const char *mode);
int yurt_pclose(FILE *stream);

int yurt_fetch_text(
  const char *url,
  const char *method,
  const char *headers_json,
  const char *body,
  char **out_body
);

#ifdef __cplusplus
}
#endif

#endif
