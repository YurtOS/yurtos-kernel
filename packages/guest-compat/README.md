# yurt Guest Compatibility Runtime

See
[`docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`](../../docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md)
for the normative design. Phase A provides a narrow, supported build path for
standalone C executables compiled with `wasi-sdk` against the shared runtime
archive `libyurt_guest_compat.a`. The same runtime will host the Rust
frontend in Phase A's later steps; the C frontend is what ships today.

Included in this package:

- a minimal public compatibility header for the Phase A build path
- a narrow scheduler-affinity compat layer for single-CPU guests
- narrow header overrides for selected POSIX APIs
- a private runtime header for host import declarations
- plain-WASI canaries for stdio/file I/O and sleep behavior
- a shared host-side toolchain (`yurt-cc`/`yurt-ar`/`yurt-ranlib`/`yurt-check`/`yurt-conf`)
  under `toolchain/yurt-cc/`, built as workspace release binaries
- a Make-driven entrypoint that can build the archive, the canaries, and
  copy canary fixtures into the kernel test directory

Later recipe tasks consume the same toolchain for larger C ports such as
BusyBox (see `packages/c-ports/busybox/`). This package only validates the
toolchain against the Phase A canaries.

Not included yet:

- full POSIX compatibility
- sockets as libc APIs
- shared libraries

## Build canaries

Build the archive and all canaries:

```bash
make -C packages/guest-compat all
```

Copy the resulting artifacts into the kernel fixture directory:

```bash
make -C packages/guest-compat copy-fixtures
```

Or run the full conformance flow end-to-end (toolchain build, archive,
canaries, signature checks, kernel behavioral suite):

```bash
./target/release/yurt-conf
```

Phase A C builds are host-side cross-compiles driven by `yurt-cc`, which
wraps `wasi-sdk`'s clang with the right `--target=wasm32-wasip1` /
`--sysroot=` / `--whole-archive` framing. Ports such as BusyBox invoke
`yurt-cc` / `yurt-ar` / `yurt-ranlib` as `CC` / `AR` / `RANLIB` directly; see
`packages/c-ports/busybox/Makefile`.

## Phase A delivered

- `stdio-canary`
- `sleep-canary`
- `system-canary`
- `popen-canary`
- `affinity-canary`
- `dup2-canary`
- host-side `clang` / `wasi-sdk` driver wrapper via `yurt-cc` (+ companions
  `yurt-ar` / `yurt-ranlib` / `yurt-check` / `yurt-conf`)
- BusyBox pilot recipe scaffolding for `grep`, `head`, and `seq`

## Compatibility headers

The shared runtime currently ships these public headers in
[`include/`](include):

- [`yurt_compat.h`](include/yurt_compat.h): yurt-specific extension APIs such as `yurt_system()` and `yurt_popen()`
- [`sched.h`](include/sched.h): single-visible-CPU affinity compatibility (`sched_getaffinity`, `sched_setaffinity`, `sched_getcpu`, `CPU_*`)
- [`unistd.h`](include/unistd.h): narrow POSIX fd and identity compatibility currently providing `dup2()` and `getgroups()`
- [`signal.h`](include/signal.h): narrow signal compatibility for `signal`, `sigaction`, `raise`, `alarm`, and basic signal-set helpers

These headers are intentionally narrow. They describe the guest compatibility
contract that yurt actually implements today, not a full libc replacement.

## Single-CPU affinity contract

The Phase A runtime exposes a Linux-like single visible CPU:

- `sched_getaffinity()` reports only CPU `0`
- `sched_setaffinity()` accepts only masks selecting CPU `0`
- masks that exclude CPU `0` or include any other CPU fail with `EINVAL`

## File descriptor compatibility

The Phase A runtime currently provides a narrow `dup2()` contract:

- `dup2(oldfd, newfd)` is supported for guest-visible fd renumbering
- `dup2(1, 2)` and similar stdio redirections operate on the guest's actual
  WASI I/O targets
- invalid descriptors fail with `EBADF`

## Identity compatibility

The Phase A runtime currently provides a narrow `getgroups()` contract:

- `getgroups(0, NULL)` reports a single visible group
- `getgroups(1, list)` stores the single visible guest group id `0` in `list[0]`
- larger buffers are accepted, but only one group is currently reported
- this is a portability shim for software that expects basic group membership
  inspection, not a full Unix credential model

## Signal compatibility

The Phase A runtime currently provides a narrow signal contract:

- `signal()` and `sigaction()` install process-local handlers
- `raise()` synchronously dispatches to installed handlers
- default handling terminates the process for `SIGINT`, `SIGTERM`, and `SIGALRM`
- `alarm()` currently supports cancellation/state tracking but does not yet
  promise wall-clock asynchronous delivery
- signal-set helpers (`sigemptyset`, `sigfillset`, `sigaddset`, `sigdelset`,
  `sigismember`, `sigprocmask`, `sigsuspend`) exist for source compatibility,
  with partial semantics suitable for current ports such as BusyBox

This contract is the shared platform rule for the C frontend today and for
the Rust-side libc surface when it lands. It is not a promise of full POSIX
signal semantics.

## Deferred

- socket libc shims
- `fork()` / `exec()` semantics
- portable `pthread` guarantees
- in-sandbox C compilation
- broad BusyBox or POSIX compatibility claims
