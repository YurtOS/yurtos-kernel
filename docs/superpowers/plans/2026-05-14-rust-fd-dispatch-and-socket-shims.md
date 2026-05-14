# Rust FD Dispatch And Socket Shims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rust kernel own process-local descriptor lookup and descriptor dispatch for files, pipes, stdio, and sockets, while shrinking `abi/src/yurt_socket.c` to thin POSIX entry points.

**Architecture:** Every app-visible fd is resolved in the caller process fd table inside `packages/kernel-wasm`. The fd table stores an `FdEntry`, and syscall dispatch narrows from that common descriptor interface before calling file, pipe, Unix socket, or IPv4 socket behavior. Common operations (`read`, `write`, `poll`, `close`) dispatch across descriptor classes; socket-only operations first perform the same process-local lookup, then return `-EBADF` for an invalid fd or `-ENOTSOCK` for a valid non-socket fd before applying socket-specific rules. C wrappers only marshal POSIX arguments into typed syscall imports; buffer handling and descriptor semantics move to safe Rust.

**Tech Stack:** Rust `packages/kernel-wasm`, C ABI wrappers under `abi/src`, Wasmtime and JS syscall shims, Deno TypeScript type-checks.

---

## File Structure

- Modify `packages/kernel-wasm/src/kernel.rs`: add opened but unconnected socket state to `SocketKind`, keep the process-local fd table as the source of truth, and provide small socket constructors/transitions.
- Modify `packages/kernel-wasm/src/dispatch.rs`: add a common descriptor dispatch layer over `FdEntry`, keep `read/write/poll/close` descriptor-generic, and change `sys_socket_open/connect/bind/listen/accept/send/recv/sendto/sendmsg/recvmsg/addr/close` to resolve the caller fd once before narrowing to `SocketKind`.
- Modify `abi/contract/yurt_abi.toml` and `packages/kernel-wasm/src/abi.rs`: add `ENOTSOCK = 88` so socket-only operations can distinguish valid non-socket descriptors from invalid descriptors.
- Modify `abi/src/yurt_socket.c`: remove socket backend tables and pending socket records; leave POSIX wrappers that parse POSIX structs enough to call Rust-owned syscalls.
- Modify or add Rust shim code under `abi/rust/yurt-wasi-shims/src/`: move iovec and SCM_RIGHTS request construction out of C when the C ABI can safely pass raw pointer spans to Rust wrappers.
- Modify `abi/src/yurt_runtime.h`: expose any new Rust-shim entry points or syscall import signatures.
- Modify `packages/kernel-host-interface-js/sys_shim.ts` and `packages/runtime-wasmtime/src/kernel_host_interface.rs`: keep import signatures aligned with the contract.
- Test in `packages/kernel-wasm/src/dispatch.rs`, `packages/runtime-wasmtime/tests/kernel_wasm_trampoline.rs`, and `abi/conformance/c/unix-canary.c`.

## Task 1: Kernel-Owned `socket()` FD Allocation

**Files:**
- Modify: `packages/kernel-wasm/src/kernel.rs`
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `abi/src/yurt_socket.c`
- Test: `packages/kernel-wasm/src/dispatch.rs`

- [ ] **Step 1: Write failing Rust tests for opened socket fd identity**

Add tests in `dispatch::tests`:

```rust
#[test]
fn sys_socket_open_creates_process_local_ipv4_stream_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    let req = socket_open_req(2, 1, 0);
    assert_eq!(dispatch(METHOD_SYS_SOCKET_OPEN, 1, &req, &mut []), 3);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SEND, 2, &socket_send_req(3, b"x"), &mut []),
        -(abi::EBADF as i64)
    );
}

#[test]
fn sys_socket_connect_operates_on_existing_fd() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    crate::kh::test_support::push_socket_connect_result(91);

    let fd = dispatch(METHOD_SYS_SOCKET_OPEN, 1, &socket_open_req(2, 1, 0), &mut []);
    assert_eq!(fd, 3);
    let req = socket_connect_existing_req(3, b"127.0.0.1:6001");
    assert_eq!(dispatch(METHOD_SYS_SOCKET_CONNECT, 1, &req, &mut []), 0);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SEND, 1, &socket_send_req(3, b"ping"), &mut []),
        4
    );
    assert_eq!(
        crate::kh::test_support::socket_send_calls(),
        vec![(91, b"ping".to_vec())]
    );
}
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
cargo test -p yurt-kernel-wasm sys_socket_open_creates_process_local_ipv4_stream_fd sys_socket_connect_operates_on_existing_fd -- --nocapture
```

Expected: fail because `sys_socket_open` does not create IPv4 stream fds and `sys_socket_connect` currently returns a new fd instead of mutating the opened fd.

- [ ] **Step 3: Add opened socket state**

In `packages/kernel-wasm/src/kernel.rs`, add:

```rust
pub enum SocketKind {
    Open {
        flags: u32,
    },
    Host {
        handle: i32,
    },
    UnixListener {
        path: Vec<u8>,
        backlog: u32,
        pending: VecDeque<u64>,
    },
    UnixStream {
        peer_id: u64,
        rx: VecDeque<u8>,
        rights: VecDeque<Vec<FdEntry>>,
        peer_open: bool,
    },
    UnixDatagram {
        peer_id: Option<u64>,
        bound_path: Option<Vec<u8>>,
        rx: VecDeque<Vec<u8>>,
        rights: VecDeque<Vec<FdEntry>>,
        peer_open: bool,
    },
}
```

Add:

```rust
pub fn create_open_socket(&mut self, domain: u8, sock_type: u8, flags: u32) -> u64 {
    let id = self.next_socket_id;
    self.next_socket_id += 1;
    self.sockets.insert(
        id,
        SocketEntry {
            refs: 1,
            domain,
            sock_type,
            kind: SocketKind::Open { flags },
        },
    );
    id
}
```

- [ ] **Step 4: Change socket open/connect to mutate fd state**

Change `sys_socket_open` to install `SocketKind::Open` for AF_INET stream, AF_UNIX stream, and AF_UNIX datagram. Change `sys_socket_connect` request layout to:

```text
u32 fd LE + addr bytes
```

For AF_INET `SocketKind::Open`, call `kh::socket_connect(addr, flags)` and replace the socket kind with `SocketKind::Host { handle }`. For AF_UNIX stream, call `connect_unix_stream(path)` and replace the fd table entry with the returned connected stream socket id.

- [ ] **Step 5: Update C `connect()`**

In `abi/src/yurt_socket.c`, remove guest-side pending socket adoption. `socket()` calls `yurt_sys_socket_open(domain, base_type, status_flags)` and returns that fd. `connect()` calls:

```c
int rc = yurt_sys_socket_connect(sockfd, addr_bytes, addr_len);
if (rc < 0) {
  errno = yurt_errno_from_host(rc, ECONNREFUSED);
  return -1;
}
return 0;
```

- [ ] **Step 6: Verify**

Run:

```bash
cargo test -p yurt-kernel-wasm sys_socket_open_creates_process_local_ipv4_stream_fd sys_socket_connect_operates_on_existing_fd -- --nocapture
make -C abi
```

Expected: tests pass; ABI builds.

## Task 2: Common Descriptor Dispatch Helpers

**Files:**
- Modify: `packages/kernel-wasm/src/dispatch.rs`
- Modify: `packages/kernel-wasm/src/abi.rs`
- Modify: `abi/contract/yurt_abi.toml`
- Test: `packages/kernel-wasm/src/dispatch.rs`

- [x] **Step 1: Add `ENOTSOCK` and tests for valid non-socket descriptors**

POSIX and Linux distinguish invalid descriptors from valid non-socket descriptors: `listen()` returns `EBADF` when the fd is invalid and `ENOTSOCK` when the fd does not refer to a socket. Apply that to all socket-only syscalls.

Added `ENOTSOCK = 88` to the kernel ABI mirror and contract, plus the C errno mapper.

Add or update tests in `dispatch::tests`:

```rust
#[test]
fn socket_operations_reject_non_socket_fds_with_enotsock() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();

    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SEND, 1, &socket_send_req(1, b"x"), &mut []),
        -(abi::ENOTSOCK as i64)
    );
    let mut buf = [0u8; 4];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(1, 0), &mut buf),
        -(abi::ENOTSOCK as i64)
    );
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_ACCEPT, 1, &socket_accept_req(1, 0), &mut []),
        -(abi::ENOTSOCK as i64)
    );
}
```

- [x] **Step 2: Verify red, then green for existing socket-only fd narrowing**

Run:

```bash
cargo test -p yurt-kernel-wasm socket_operations_reject_non_socket_fds_with_enotsock -- --nocapture
```

Observed red first because `abi::ENOTSOCK` did not exist. After adding `ENOTSOCK` and updating socket fd narrowing, the test passed.

- [ ] **Step 3: Add tests for no cross-backend fallback**

Add tests:

```rust
#[test]
fn socket_send_on_file_fd_is_not_a_host_socket_probe() {
    let _g = crate::kernel::TestGuard::acquire();
    crate::kh::test_support::reset_socket_mock();
    register_file(b"/file.txt", b"data");
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(b"/file.txt", 0), &mut []);
    assert_eq!(fd, 3);
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_SEND, 1, &socket_send_req(3, b"x"), &mut []),
        -(abi::ENOTSOCK as i64)
    );
    assert!(crate::kh::test_support::socket_send_calls().is_empty());
}

#[test]
fn socket_recv_dispatches_by_socket_kind() {
    let _g = crate::kernel::TestGuard::acquire();
    let mut fds = [0u8; 8];
    assert_eq!(
        dispatch(METHOD_SYS_SOCKETPAIR, 1, &socketpair_req(1, 1, 0), &mut fds),
        0
    );
    let left = u32::from_le_bytes(fds[0..4].try_into().unwrap());
    let right = u32::from_le_bytes(fds[4..8].try_into().unwrap());
    assert_eq!(dispatch(METHOD_SYS_SOCKET_SEND, 1, &socket_send_req(left, b"a"), &mut []), 1);
    let mut out = [0u8; 1];
    assert_eq!(dispatch(METHOD_SYS_SOCKET_RECV, 1, &socket_recv_req(right, 0), &mut out), 1);
    assert_eq!(&out, b"a");
}
```

- [ ] **Step 4: Add one descriptor lookup helper**

In `dispatch.rs`, replace scattered helpers with a common descriptor reference. Keep this match-based initially instead of storing trait objects; it gives us the Rust-interface shape without borrow/lifetime churn inside the global `Kernel` lock.

```rust
enum DescriptorRef {
    Socket(u64),
    File(u64),
    Pipe { id: u64, end: PipeEnd },
    Stdin,
    Stdout,
    Stderr,
    Directory { ofd_id: u64 },
}

fn resolve_descriptor(k: &Kernel, caller_pid: u32, fd: u32) -> Result<DescriptorRef, i64> {
    match k.process(caller_pid).fd_table.entry(fd).cloned() {
        Some(FdEntry::Socket { id }) => Ok(DescriptorRef::Socket(id)),
        Some(FdEntry::File { ofd_id }) => Ok(DescriptorRef::File(ofd_id)),
        Some(FdEntry::Pipe { id, end }) => Ok(DescriptorRef::Pipe { id, end }),
        Some(FdEntry::Stdin) => Ok(DescriptorRef::Stdin),
        Some(FdEntry::Stdout) => Ok(DescriptorRef::Stdout),
        Some(FdEntry::Stderr) => Ok(DescriptorRef::Stderr),
        Some(FdEntry::Directory { ofd_id }) => Ok(DescriptorRef::Directory { ofd_id }),
        None => Err(-(abi::EBADF as i64)),
    }
}
```

If `Kernel::process` does not exist, add an immutable accessor in `kernel.rs`.

- [ ] **Step 5: Route common and socket-only operations through descriptor dispatch**

For `read`, `write`, `poll`, and `close`, dispatch on `DescriptorRef` and call the appropriate file, pipe, stdio, or socket behavior.

For each socket-only syscall, use:

```rust
let id = match resolve_descriptor(k, caller_pid, fd)? {
    DescriptorRef::Socket(id) => id,
    _ => return -(abi::ENOTSOCK as i64),
};
```

Then match `SocketKind` directly. Do not call any host operation unless the matched kind is `SocketKind::Host`.

- [ ] **Step 6: Move `listen()` to fd-based descriptor lookup**

Change `sys_socket_listen` from open+bind+listen to an fd-mutating operation:

```text
u32 fd LE + u32 backlog LE
```

`listen(fd, backlog)` should:

- return `-EBADF` when the process fd table does not contain `fd`;
- return `-ENOTSOCK` when `fd` exists but is not a socket;
- return `-EOPNOTSUPP` for datagram sockets or other socket types that cannot listen;
- transition an opened/bound AF_UNIX stream socket to `SocketKind::UnixListener`;
- transition an opened/bound AF_INET stream socket to `SocketKind::Host { handle }` after `kh::socket_listen_at`.

Add a Rust test before implementation:

```rust
#[test]
fn socket_listen_on_file_fd_is_enotsock() {
    let _g = crate::kernel::TestGuard::acquire();
    register_file(/* path + content request */);
    let fd = dispatch(METHOD_SYS_OPEN, 1, &open_req(0, b"/file.txt"), &mut []);
    assert_eq!(fd, 3);

    let mut req = fd.to_le_bytes().to_vec();
    req.extend_from_slice(&4_u32.to_le_bytes());
    assert_eq!(
        dispatch(METHOD_SYS_SOCKET_LISTEN, 1, &req, &mut []),
        -(abi::ENOTSOCK as i64)
    );
}
```

Update `abi/src/yurt_socket.c`, `abi/src/yurt_runtime.h`, `packages/kernel-host-interface-js/sys_shim.ts`, and `packages/runtime-wasmtime/src/kernel_host_interface.rs` so C `listen(sockfd, backlog)` passes the app fd to Rust. C should not decide whether the fd is a file or socket; it should map the returned errno.

- [ ] **Step 7: Verify**

Run:

```bash
cargo test -p yurt-kernel-wasm socket_operations_reject_non_socket_fds_with_enotsock socket_send_on_file_fd_is_not_a_host_socket_probe socket_recv_dispatches_by_socket_kind socket_listen_on_file_fd_is_enotsock -- --nocapture
```

Expected: pass.

## Task 3: Move POSIX Socket Buffer Logic To Rust

**Files:**
- Modify: `abi/src/yurt_socket.c`
- Modify: `abi/src/yurt_runtime.h`
- Modify: `abi/rust/yurt-wasi-shims/src/lib.rs`
- Test: `abi/conformance/c/unix-canary.c`

- [ ] **Step 1: Add Rust unsafe boundary functions with safe internals**

In `abi/rust/yurt-wasi-shims/src/lib.rs`, add exported functions:

```rust
#[no_mangle]
pub extern "C" fn yurt_rs_sendmsg(sockfd: i32, msg: *const core::ffi::c_void, flags: i32) -> isize {
    socket::sendmsg(sockfd, msg.cast(), flags)
}

#[no_mangle]
pub extern "C" fn yurt_rs_recvmsg(sockfd: i32, msg: *mut core::ffi::c_void, flags: i32) -> isize {
    socket::recvmsg(sockfd, msg.cast(), flags)
}
```

Implement `socket::sendmsg` and `socket::recvmsg` so all pointer reads are copied into Rust `Vec<u8>` / `Vec<i32>` before request construction. Keep each unsafe block limited to reading C structs and slice spans, with `// SAFETY:` comments.

- [ ] **Step 2: Replace C `sendmsg` and `recvmsg` bodies**

In `abi/src/yurt_socket.c`, replace the current gather/scatter code with:

```c
ssize_t sendmsg(int sockfd, const struct msghdr *msg, int flags) {
  YURT_MARKER_CALL(sendmsg);
  return yurt_rs_sendmsg(sockfd, msg, flags);
}

ssize_t recvmsg(int sockfd, struct msghdr *msg, int flags) {
  YURT_MARKER_CALL(recvmsg);
  return yurt_rs_recvmsg(sockfd, msg, flags);
}
```

- [ ] **Step 3: Move sockaddr helpers incrementally**

Add Rust helpers for:

```rust
pub fn encode_sockaddr_un(addr: *const libc_sockaddr, len: u32) -> Result<Vec<u8>, Errno>;
pub fn encode_sockaddr_in(addr: *const libc_sockaddr, len: u32) -> Result<Vec<u8>, Errno>;
```

Expose C-callable wrappers for `connect`, `bind`, and `sendto` request construction. Leave direct POSIX symbol definitions in C.

- [ ] **Step 4: Verify Unix canaries**

Run:

```bash
make -C abi
```

Then run the Wasmtime user-process socket tests:

```bash
cargo test -p yurt-runtime-wasmtime user_process_socketpair --test kernel_wasm_trampoline
cargo test -p yurt-runtime-wasmtime user_process_af_unix_path_stream_round_trips_through_kernel --test kernel_wasm_trampoline
```

Expected: pass.

## Task 4: Remove C Socket Backend Tables

**Files:**
- Modify: `abi/src/yurt_socket.c`
- Test: `abi/conformance/c/unix-canary.c`

- [ ] **Step 1: Delete C-side backend state**

Remove:

```c
typedef struct yurt_socket_entry { ... } yurt_socket_entry;
static yurt_socket_entry yurt_sockets[YURT_SOCKET_MAX_TRACKED];
static int yurt_next_guest_fd = YURT_SOCKET_FIRST_GUEST_FD;
#define YURT_SOCKET_BACKEND_HOST ...
#define YURT_SOCKET_BACKEND_KERNEL ...
#define YURT_SOCKET_BACKEND_PENDING ...
```

Keep only direct flag arrays if needed for fcntl compatibility, or move them to Rust if fcntl already routes through Rust-owned shims.

- [ ] **Step 2: Make C fd operations syscall-only**

`socket`, `connect`, `bind`, `listen`, `accept`, `send`, `recv`, `sendto`, `recvfrom`, `sendmsg`, `recvmsg`, `shutdown`, and `close` call the `sys_*` imports or Rust shim functions. None of them calls `host_socket_*`.

- [ ] **Step 3: Security grep**

Run:

```bash
rg -n "host_socket_(connect_unix|bind_unix|listen_unix|accept_unix|recv_unix|recvfrom_unix|sendto_unix|socketpair|is_dgram)|goto legacy|debug sys_socket|syscallFallbacks" abi/src/yurt_socket.c packages/kernel/src/process/loader.ts
```

Expected: no output.

## Task 5: Full Verification And Push

**Files:**
- All files touched above.

- [ ] **Step 1: Run local gates**

Run:

```bash
cargo fmt --all -- --check
cargo test -p yurt-kernel-wasm --tests
cargo check --all-targets
cargo clippy --all-targets -- -D warnings
/Users/sunny/.deno/bin/deno check 'packages/**/*.ts'
make -C abi
```

Expected: all pass. If repo-wide clippy finds unrelated existing warnings, isolate and run the package-level clippy for touched Rust packages, then record the unrelated blocker.

- [ ] **Step 2: Run socket integration tests**

Run:

```bash
cargo test -p yurt-runtime-wasmtime user_process_socketpair --test kernel_wasm_trampoline
cargo test -p yurt-runtime-wasmtime user_process_af_unix_path_stream_round_trips_through_kernel --test kernel_wasm_trampoline
cargo test -p yurt-runtime-wasmtime sys_socket_connect_send_recv_through_local_echo_server --test kernel_wasm_trampoline
```

Expected: pass.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add abi packages docs/superpowers/plans/2026-05-14-rust-fd-dispatch-and-socket-shims.md
git commit -m "refactor: move socket fd dispatch into rust kernel"
git push origin HEAD:worktree-kernel-as-wasm-guest
gh pr checks 16
```

Expected: push succeeds; PR checks start or pass.

## Self-Review

- Spec coverage: covers process-local fd lookup, Rust dispatch by descriptor type, moving C buffer logic into safe Rust, and removing fallback/probe security risks.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: plan uses current `FdEntry`, `SocketKind`, `METHOD_SYS_SOCKET_*`, and syscall import naming already present in PR16.
