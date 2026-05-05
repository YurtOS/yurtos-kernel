# POSIX/Libc Runtime Hardening Design

## Goal

Make the currently advertised POSIX/Linux compatibility surface honest,
specified, and covered before widening it. The first slice targets APIs that are
small enough to implement inside `libyurt_guest_compat.a` without new kernel
architecture: hostname, loopback interface lookup, `sendfile`, and stale
documentation around sockets, exec, fork, pthreads, and the renamed toolchain.

## Non-Goals

- No broad "full POSIX" claim.
- No fork/vfork implementation.
- No shared library or dynamic linker support.
- No new network device model beyond a deterministic loopback interface.
- No Rust standard library rebuild in this slice.

## Runtime Contract

- Host identity:
  - `uname().sysname` remains `yurt`.
  - `uname().nodename` and `gethostname()` both report `yurt`.
  - `sethostname()` remains unsupported and returns `-1/ENOSYS`.
- Network interfaces:
  - A single visible loopback interface exists for lookup APIs.
  - `if_nametoindex("lo") == 1`.
  - `if_indextoname(1, buf)` returns `buf` containing `lo`.
  - Unknown names/indices fail using Linux-compatible errno where practical.
- File transfer:
  - `sendfile(out_fd, in_fd, offset, count)` is implemented as a bounded
    read/write loop.
  - When `offset != NULL`, the input file position is restored and `*offset`
    advances by bytes copied.
  - When `offset == NULL`, the input file position advances naturally.
  - Short reads/writes and zero-count requests follow POSIX-style behavior.
- Process/resource surface:
  - Existing single-session/single-process-group behavior remains explicit in
    docs and specs.
  - Unsupported process creation APIs remain explicit failures rather than
    silent success.

## Verification

- Add TOML specs and C canary cases for the new deterministic behavior.
- Keep signature coverage in `canary_symbol_map()` synchronized with new real
  symbols.
- Run `cargo test -p yurt-toolchain` after conformance/toolchain edits.
- Run the guest compat build/spec path when the local WASI/wasmtime toolchain is
  available.
