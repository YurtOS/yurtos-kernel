#ifndef YURT_COMPAT_H
#define YURT_COMPAT_H

#include <stdint.h>
#include <stdio.h>

/* Guest-compat ABI version — the major/minor of the host↔guest
 * protocol (host imports, signal numbers, etc.).  Separate from the
 * yurt product version below: a host running guest-compat ABI 2.x
 * still ships yurt 0.1.x. */
#define YURT_GUEST_COMPAT_VERSION_MAJOR 1u
#define YURT_GUEST_COMPAT_VERSION_MINOR 0u

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

extern uint32_t yurt_guest_compat_version;

/*
 * Narrow Phase A command-execution shim for yurt guests, part of the
 * yurt guest compatibility runtime (see
 * docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md).
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

#endif
