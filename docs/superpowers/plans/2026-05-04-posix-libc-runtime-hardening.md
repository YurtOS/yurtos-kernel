# POSIX/Libc Runtime Hardening Plan

> **For Sunny:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Make the existing POSIX/Linux compatibility surface more honest and
behaviorally covered before adding broader APIs.

**Design:** `docs/superpowers/specs/2026-05-04-posix-libc-runtime-hardening-design.md`

## Tasks

- [x] Refresh kernel ABI docs to describe current `yurt-toolchain`,
      partial socket/exec/pthread support, and explicit fork/shared-library
      non-goals.
- [x] Add real compat symbols for `gethostname`, `if_nametoindex`,
      `if_indextoname`, and `sendfile`.
- [x] Add C canary coverage and TOML specs for the new deterministic behavior.
- [x] Synchronize yurt-toolchain signature coverage for the new symbols.
- [x] Run focused verification and document any environment-limited checks.
