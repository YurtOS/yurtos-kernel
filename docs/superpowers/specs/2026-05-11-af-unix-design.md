# AF_UNIX Sockets Design (Full POSIX, In-Kernel Registry)

**Status:** Draft
**Date:** 2026-05-11
**Scope:** Define the guest-visible AF_UNIX socket contract for YurtOS and
the in-kernel registry that implements it. Covers SOCK_STREAM and
SOCK_DGRAM, pathname and abstract addresses, SCM_RIGHTS fd passing,
SO_PEERCRED peer credentials, and `socketpair()`. Replaces PR #22's
TCP-loopback `socketpair()` emulation.

## Problem

YurtOS today has no AF_UNIX support. The `socket(AF_UNIX, ...)` path
returns `EAFNOSUPPORT`, and `socketpair(AF_UNIX, SOCK_STREAM, 0, sv)`
is emulated by binding a TCP listener on `127.0.0.1:0` and threading
the connector + acceptor halves through
([abi/src/yurt_socket.c:825-888](../../../abi/src/yurt_socket.c)).

The TCP-loopback emulation is functionally correct for libzmq's
signaler (an opaque byte pipe used to wake a polling thread) but holds
real ports back:

- **No fd passing.** `sendmsg(... SCM_RIGHTS ...)` cannot transmit a
  file descriptor through TCP. systemd-style socket activation,
  browser-style fd transfer, libvirt's listener handoff, and Docker
  socket proxying all rely on AF_UNIX semantics.
- **No SOCK_DGRAM.** Message-framed pairs return `EPROTOTYPE`. syslog
  ports and many smaller IPC libraries can't run.
- **No pathname semantics.** `bind("/tmp/foo.sock")` fails outright;
  daemons that expose a control socket cannot do so. Worse, clients
  that probe with `stat("/tmp/foo.sock")` before connecting see
  `ENOENT` and bail.
- **No abstract namespace.** `bind("\0name")` cannot be routed. dbus,
  systemd's notify socket, and a number of Linux-specific tools rely on
  it.
- **No `SO_PEERCRED`.** Daemons that authenticate clients by uid/pid
  (the standard pattern on Linux) cannot.
- **Resource cost.** Each pair burns three transient fds + an ephemeral
  port + a listener registration; anything in the sandbox enumerating
  loopback sockets sees the pair.

The right shape is an in-kernel `UnixSocketRegistry` that mirrors the
existing `ListenerRegistry`
([`packages/kernel/src/network/listener-registry.ts`](../../../packages/kernel/src/network/listener-registry.ts))
— paired-socket model, rx queues, async/sync rendezvous, refcounted
fd-table integration — but keyed by pathname / abstract address instead
of `host:port`. The browser microkernel inherits AF_UNIX for free
because it already shares the `ListenerRegistry` instance with
`BrowserNetworkBridge`
([`packages/kernel/src/network/browser-bridge.ts:26-46`](../../../packages/kernel/src/network/browser-bridge.ts)).

## Goals

- Pin a guest-visible AF_UNIX contract that is observably identical on
  Wasmtime, Deno/Node, and browser WebAssembly.
- Cover the full POSIX surface: `socket`/`bind`/`listen`/`accept`/`connect`/
  `socketpair` for SOCK_STREAM and SOCK_DGRAM, both pathname and
  abstract addresses; `sendmsg`/`recvmsg` with `SCM_RIGHTS`;
  `getsockopt(SO_PEERCRED)`.
- Make pathname sockets visible to the VFS as `S_IFSOCK` inodes so that
  `stat("/tmp/foo.sock")`, `ls`, and `unlink` behave correctly.
- Keep the AF_INET contract (and its existing hostcalls and tests)
  unchanged. AF_UNIX is layered on top of the same `host_socket_*`
  hostcalls; the request shape carries optional `path` instead of
  `host:port`.
- Replace PR #22's TCP-loopback `socketpair()` once the AF_UNIX path is
  ready.

## Non-Goals

- **Host AF_UNIX bridging.** Connecting a guest to a real Unix socket
  on the host (e.g., `/var/run/docker.sock`) is a separate, opt-in
  embedder feature and not covered here.
- **`SO_PASSCRED` / `SCM_CREDENTIALS`.** Linux-specific in-band credential
  passing; `SO_PEERCRED` covers the canonical use case.
- **`SOCK_SEQPACKET`.** Rarely needed outside DRBD/SCTP; add when a port
  asks.
- **Fd-passing across the host/sandbox boundary.** A guest sending an
  fd to the host would require the microkernel to expose host fds as
  guest fds. Out of scope.
- **Filesystem-permission gating of AF_UNIX paths.** POSIX gates
  `connect()` on the socket file's mode bits; YurtOS routes the check
  through the embedder's `serverSockets.unixPathAllowlist` policy
  instead. Mode bits on the inode are advisory only in this phase.

## Architecture

### Registry data model

`packages/kernel/src/network/listener-registry.ts` already owns the
authoritative state for sandbox sockets: paired sockets, listener
queues, ephemeral port allocation, async waiters. AF_UNIX extends the
existing `routes: Map<string, ListenerHandle>` with two additional key
namespaces:

```
AF_UNIX:<canonical-path>    → ListenerHandle    (pathname)
AF_UNIX_ABSTRACT:<name>     → ListenerHandle    (abstract; no NUL)
```

The existing `<host>:<port>` namespace is unchanged. Path canonicalization
follows POSIX rules: absolute path, no `..`, symlinks resolved at bind
time (not connect time). Abstract names are stored verbatim (matching Linux kernel behavior) —
the leading NUL byte that marks the abstract namespace in `sun_path`
is stripped at the ABI boundary and never appears in the registry key.

`PairedSocket`, the per-half state for connected sockets, gains optional
`family`, `peerPath`, `localPath`, `peerUid`, `peerGid`, `peerPid` fields.
For STREAM sockets the existing rx queue and waiter machinery is reused
verbatim — bytes flow through the same path that AF_INET loopback uses.

For DGRAM sockets each bound endpoint owns a single message queue; a
`sendto(path, bytes)` looks up the bound listener at `path` and pushes
`{ bytes, fromPath, fromAbstract }` onto its queue. The receiver's
`recvfrom` drains the queue. No accept queue, no paired-socket
allocation.

For SCM_RIGHTS, the per-message ancillary buffer carries an optional
`{ type: "SCM_RIGHTS", fds: number[] }` payload. On receive, the kernel
looks up each `FdTarget` in the sender's pid, allocates a new fd in the
receiver's pid via `kernel.allocFd()`, and bumps `target.refs` — the
same refcounted-share pattern that `buildFdTableForSpawn/Fork`
([`packages/kernel/src/process/kernel.ts:512-587`](../../../packages/kernel/src/process/kernel.ts))
uses for inheritance.

### Hostcall surface

Five existing hostcalls extend with `path` request fields:

- `host_socket_bind(req)` — `req = { fd, path }` for AF_UNIX, or
  `{ fd, host, port }` for AF_INET. Family inferred from request shape.
- `host_socket_connect(req)` — same.
- `host_socket_addr(req)` — response includes `local_path`, `peer_path`
  when family is AF_UNIX.
- `host_socket_listen(req)` — unchanged signature; AF_UNIX-ness
  inherited from the prior `bind` on the fd.
- `host_socket_accept(req)` — response includes `peer_path` when
  applicable.

Three new hostcalls land for SCM_RIGHTS:

- `host_socket_socketpair(req)` — `req = { family, type }` →
  `{ ok, fds: [int, int] }`. Replaces PR #22's TCP-loopback emulation.
- `host_socket_sendmsg(req)` — `req = { fd, data_b64,
  ancillary?: { type: "SCM_RIGHTS", fds: [int] } }` →
  `{ ok, bytes_sent }`.
- `host_socket_recvmsg(req)` — `req = { fd, max_bytes,
  ancillary_cap?: int }` →
  `{ ok, data_b64, ancillary?: { type: "SCM_RIGHTS", fds: [int] },
     truncated_data, truncated_ancillary, from_path? }`.

`SocketBackend`
([`packages/kernel/src/network/socket-backend.ts`](../../../packages/kernel/src/network/socket-backend.ts))
gains the matching optional method signatures. The interface is already
protocol-agnostic; AF_UNIX is an additive feature.

### VFS integration

A new inode kind, `SocketInode`, lives alongside `FileInode` and
`DirInode` in the VFS. Its metadata holds:

- standard mode bits with `S_IFSOCK` in the type bits;
- a back-pointer to the registry listener handle bound at this path
  (set on `bind`, cleared on `close` of the bound fd or `unlink` of
  the path).

`stat()` reports the type as `S_IFSOCK`; `open()` returns
`EOPNOTSUPP` (POSIX rejects `open` on socket inodes); `unlink()`
deletes the inode and notifies the registry to drop the listener so
subsequent `connect()` returns `ECONNREFUSED`. Abstract addresses do
not appear in the VFS — that is the POSIX contract.

> **`unlink()` drops the listener (YurtOS deviation):** On Linux,
> `unlink()` removes the directory entry but the listener stays alive
> until the bound fd is closed — clients can still `connect()` as long
> as the server holds the fd. YurtOS eagerly drops the listener on
> `unlink` because the registry keys by path: once the VFS inode is
> gone the route key is removed too. Ports that rely on the Linux
> guarantee (bind → listen → unlink → clients still connect until
> close) will not work without holding the fd open across the unlink.

> **ECONNREFUSED for missing paths (YurtOS deviation):** POSIX requires
> `ENOENT` when `connect()` targets a path that has no socket file, and
> `ECONNREFUSED` only when the file exists but no listener is open.
> YurtOS returns `ECONNREFUSED` in both cases because the registry does
> not perform a VFS lookup during connect — it routes by registry key
> only. This is intentional for the current in-kernel socket model; a
> future VFS-backed connect path could restore the POSIX distinction.

### Security boundary

A new policy block on `Sandbox.create`:

```ts
serverSockets: {
  allowUnixDomain?: boolean,
  unixPathAllowlist?: RegExp[],
  unixAbstractAllowlist?: RegExp[],
  onUnixListen?: (path: string, abstract: boolean) => boolean | Promise<boolean>,  // deferred; see below
}
```

> **`onUnixListen` deferred:** The hook field is declared in `SocketListenPolicy` but is
> not yet invoked by `authorizeUnixListen`. The synchronous allowlist check is
> sufficient for current use cases. The async hook will be wired in a later slice
> when cross-sandbox or embedder-controlled policy is needed.

`authorizeListen()`
([`packages/kernel/src/host-imports/kernel-imports.ts:835-878`](../../../packages/kernel/src/host-imports/kernel-imports.ts))
extends with an AF_UNIX branch. Defaults are restrictive: AF_UNIX is
disabled unless the embedder opts in.

`SO_PEERCRED` returns the kernel-tracked sandbox pid/uid/gid of the peer
process. Inside a single sandbox this is identical to the local
sandbox credentials; future cross-sandbox embedders will see distinct
values.

### Contract surface (guest-visible)

The guest sees standard POSIX AF_UNIX as exposed by
`<sys/socket.h>` + `<sys/un.h>`:

```c
int sd = socket(AF_UNIX, SOCK_STREAM, 0);
struct sockaddr_un addr = { .sun_family = AF_UNIX };
strncpy(addr.sun_path, "/tmp/foo.sock", sizeof addr.sun_path - 1);
bind(sd, (struct sockaddr *)&addr, sizeof addr);
listen(sd, 8);
int peer = accept(sd, NULL, NULL);

struct ucred cred;
socklen_t cred_len = sizeof cred;
getsockopt(peer, SOL_SOCKET, SO_PEERCRED, &cred, &cred_len);

struct msghdr msg = { ... };
struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
cmsg->cmsg_level = SOL_SOCKET;
cmsg->cmsg_type  = SCM_RIGHTS;
cmsg->cmsg_len   = CMSG_LEN(sizeof(int));
memcpy(CMSG_DATA(cmsg), &fd_to_pass, sizeof(int));
sendmsg(peer, &msg, 0);
```

All standard headers (`<sys/socket.h>`, `<sys/un.h>`, `struct ucred`,
`struct msghdr`, `struct cmsghdr`, `CMSG_*` macros) are provided by
[abi/include/](../../../abi/include/). The C ABI gains `AF_UNIX`,
`AF_LOCAL`, `PF_UNIX`, `SCM_RIGHTS`, `SO_PEERCRED` constants in
[`abi/include/sys/socket.h`](../../../abi/include/sys/socket.h). The
`struct sockaddr_un` and `SUN_LEN` macro in
[`abi/include/sys/un.h`](../../../abi/include/sys/un.h) are already in
place.

## Out of band — the existing TCP-loopback shim

`socketpair(AF_UNIX, SOCK_STREAM, 0, sv)` continues to work throughout
the slice rollout. The TCP-loopback emulation in
[`abi/src/yurt_socket.c:825-888`](../../../abi/src/yurt_socket.c) stays
in place until slice 2 lands an in-registry replacement; the final
slice (7) deletes it. Tests that exercise it (the
header-surface test in
[`packages/kernel/src/__tests__/abi_test.ts:562-579`](../../../packages/kernel/src/__tests__/abi_test.ts))
swap from `serverSockets: { allowLoopback: true }` to
`serverSockets: { allowUnixDomain: true }` in slice 2.

## Open questions

- Should pathname socket inodes participate in `chmod` / `chown`?
  POSIX says yes; for this phase we accept `chmod`/`chown` but do not
  consult the result during `connect()`. Embedder policy is the gating
  layer. Future work can wire the bits into a `connect`-time check.
- Path length: `sun_path` is 108 bytes. The VFS path limit (PATH_MAX)
  is larger. Bind silently truncates to 107 bytes (NUL-terminated),
  matching Linux behavior.
- `umask` of the created socket inode: defaults to `0666 & ~umask`
  per POSIX, using the sandbox-tracked umask.
