/**
 * ListenerRegistry — in-memory paired-socket registry.
 *
 * Owns the host:port → listener map, the per-listener accept queue, and the
 * paired-socket allocation that backs sandbox-virtual TCP. Two callers can
 * both reach a listener:
 *
 *  - Inside the sandbox: a guest that calls connect(2) on a sandbox-bound
 *    port. Today this is the loopback path that lives inline in
 *    createLoopbackSocketBackend; that backend now delegates to this module.
 *  - From the host page (browser harness): the sibling repo's Service Worker
 *    receives a fetch/WebSocket aimed at 127.0.0.1:<port> and uses
 *    sandbox.net.connect to open a duplex stream into the same registry.
 *
 * The registry deals only in raw bytes. Any framing (HTTP, WebSocket) is the
 * caller's concern. recvAsync returns a Promise that resolves when bytes (or
 * EOF) arrive, so kernel host imports can be event-driven under both JSPI and
 * Asyncify without busy-polling.
 */

export type ListenerHandle = number;
export type SocketHandle = number;

// ── SOCK_DGRAM support ────────────────────────────────────────────────────────

export interface DgramMessage {
  bytes: Uint8Array;
  fromPath?: string;
  fromAbstract?: string;
}

interface DgramSocket {
  handle: SocketHandle;
  messages: DgramMessage[];
  recvWaiters: Array<{ resolve: (m: DgramMessage) => void; reject: (e: Error) => void }>;
  boundPath?: string;     // set after bindDgramToPath
  peerHandle?: SocketHandle; // set for socketpair DGRAM
  closed: boolean;
}

export type ListenHost = "127.0.0.1" | "localhost" | "0.0.0.0";

export interface ListenRequest {
  host: ListenHost;
  port: number;
  backlog: number;
}

export interface ListenerInfo {
  handle: ListenerHandle;
  host?: ListenHost;   // undefined for AF_UNIX listeners
  port: number;        // 0 for AF_UNIX listeners
  localPath?: string;  // set for AF_UNIX listeners
}

export interface AcceptedConnection {
  socket: SocketHandle;
  peerHost: string;
  peerPort: number;
  localHost: string;
  localPort: number;
}

export interface UnixListenRequest {
  path: string;
  backlog: number;
}

export interface UnixAcceptedConnection {
  socket: SocketHandle;
  peerPath?: string;
  localPath: string;
}

export type UnixConnectResult =
  | { ok: true; socket: SocketHandle; localPath: string; peerPath: string }
  | { ok: false; error: string };

export type ConnectResult =
  | {
    ok: true;
    socket: SocketHandle;
    peerHost: string;
    peerPort: number;
    localHost: string;
    localPort: number;
  }
  | { ok: false; error: string };

export type SendResult = { ok: true; bytesSent: number } | {
  ok: false;
  error: string;
};

export type RecvResult = { ok: true; bytes: Uint8Array } | {
  ok: false;
  error: string;
};

export interface RecvOptions {
  nonblocking?: boolean;
}

type RegistryEvent = "listen" | "unlisten";

/** Ancillary data entry for SCM_RIGHTS — carries intermediate fd numbers and
 *  the pid of the process whose fd table they live in, so recvmsg can dup
 *  across process boundaries. */
export interface AncEntry {
  fds: number[];
  senderPid: number;
}

interface PairedSocket {
  handle: SocketHandle;
  peerHandle: SocketHandle;
  rx: Uint8Array[];
  /** Parallel ancillary-fd array for SCM_RIGHTS (Slice 5).
   *  Each slot corresponds to the matching rx entry.
   *  undefined means no ancillary data for that message. */
  rxAnc: Array<AncEntry | undefined>;
  /** Holds anc for messages delivered directly to a parked rxWaiter (fast path
   *  in sendWithAnc). In this path the message bypasses rx/rxAnc entirely, so
   *  the receiver must read this field after recvAsync resolves. */
  pendingWaiterAnc?: AncEntry;
  rxWaiters: Array<{
    resolve: (r: RecvResult) => void;
    max: number;
  }>;
  closed: boolean;
  peerHost: string;
  peerPort: number;
  localHost: string;
  localPort: number;
  /** Set on the client side of openPair — the localPort was drawn from
   *  clientPorts and must be released back to the allocator on close. */
  ownsClientPort?: boolean;
  /** AF_UNIX path fields — only set for unix-domain connected sockets. */
  localPath?: string;
  peerPath?: string;
  /** SO_PEERCRED fields (Slice 6) */
  peerPid?: number;
  peerUid?: number;
  peerGid?: number;
}

interface ListenerState {
  handle: ListenerHandle;
  host?: ListenHost;     // undefined for AF_UNIX listeners
  port: number;
  backlog: number;
  pending: AcceptedConnection[];
  acceptWaiters: Array<{
    resolve: (a: AcceptedConnection) => void;
    reject: (e: Error) => void;
  }>;
  closed: boolean;
  /** AF_UNIX-specific fields — only set when isUnixListener is true. */
  isUnixListener?: boolean;
  localPath?: string;
  pendingUnix?: UnixAcceptedConnection[];
  unixAcceptWaiters?: Array<{
    resolve: (a: UnixAcceptedConnection) => void;
    reject: (e: Error) => void;
  }>;
}

const EPHEMERAL_PORT_START = 49152;
const EPHEMERAL_PORT_END = 65535;

function normalizeHost(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host;
}

export class ListenerRegistry {
  private listeners = new Map<ListenerHandle, ListenerState>();
  /** Routing key is `${normalizedHost}:${port}` and `0.0.0.0:${port}`. */
  private routes = new Map<string, ListenerHandle>();
  private sockets = new Map<SocketHandle, PairedSocket>();
  /** Ports currently held by listeners or in-flight client sockets. Used
   *  by allocEphemeralPort so two concurrent connect()s don't collide on
   *  a client localPort, and so the wildcard collision check is O(1). */
  private busyPorts = new Set<number>();
  /** Ports held by client-side ephemeral allocations only. Released when
   *  the client socket is closed. */
  private clientPorts = new Set<number>();
  private nextListenerHandle = 1;
  private nextSocketHandle = 1;
  private nextEphemeralPort = EPHEMERAL_PORT_START;
  private listeners_ev = new Set<(info: ListenerInfo) => void>();
  private unlisteners_ev = new Set<(info: ListenerInfo) => void>();
  /** SOCK_DGRAM sockets keyed by handle. */
  private dgramSockets = new Map<SocketHandle, DgramSocket>();
  /** Route key `DGRAM:${path}` → SocketHandle for bound dgram sockets. */
  private dgramRoutes = new Map<string, SocketHandle>();

  listen(req: ListenRequest): ListenerInfo {
    const port = req.port === 0 ? this.allocEphemeralPort() : req.port;
    const newHost = normalizeHost(req.host);
    const key = `${newHost}:${port}`;
    const wildcardKey = `0.0.0.0:${port}`;
    if (this.routes.has(key)) {
      throw new Error(`address ${req.host}:${port} already in use`);
    }
    // A wildcard bind covers every interface, so it must be exclusive on
    // its port: a new wildcard collides with any existing specific bind,
    // and a new specific bind collides with an existing wildcard.
    // busyPorts tracks listener-bound ports for an O(1) lookup on either
    // wildcard or specific binds.
    if (newHost === "0.0.0.0") {
      if (this.busyPorts.has(port)) {
        throw new Error(`address ${req.host}:${port} already in use`);
      }
    } else if (this.routes.has(wildcardKey)) {
      throw new Error(`address ${req.host}:${port} already in use`);
    }
    const handle = this.nextListenerHandle++;
    const state: ListenerState = {
      handle,
      host: req.host,
      port,
      backlog: req.backlog,
      pending: [],
      acceptWaiters: [],
      closed: false,
    };
    this.listeners.set(handle, state);
    this.routes.set(key, handle);
    this.busyPorts.add(port);
    // localhost ↔ 127.0.0.1 alias
    if (req.host === "localhost") this.routes.set(`127.0.0.1:${port}`, handle);
    if (req.host === "127.0.0.1") this.routes.set(`localhost:${port}`, handle);
    const info: ListenerInfo = { handle, host: req.host, port };
    this.emit("listen", info);
    return info;
  }

  /** Open a connection from inside the sandbox to a sandbox-bound listener. */
  connect(req: { host: string; port: number }): ConnectResult {
    return this.openPair(req);
  }

  /**
   * Host-page-initiated connect. Returns the host's socket handle and the
   * registry-side I/O methods the harness will use. Symmetric to connect();
   * the difference is purely a label for diagnostics.
   */
  connectFromHost(req: { host: string; port: number }): ConnectResult {
    return this.openPair(req);
  }

  private openPair(req: { host: string; port: number }): ConnectResult {
    const listenerHandle =
      this.routes.get(`${normalizeHost(req.host)}:${req.port}`) ??
        this.routes.get(`0.0.0.0:${req.port}`);
    const listener = listenerHandle !== undefined
      ? this.listeners.get(listenerHandle)
      : undefined;
    if (!listener || listener.closed) {
      return {
        ok: false,
        error: `connection refused: ${req.host}:${req.port}`,
      };
    }
    if (
      listener.acceptWaiters.length === 0 &&
      listener.pending.length >= listener.backlog
    ) {
      return {
        ok: false,
        error: `connection refused: listener backlog full`,
      };
    }

    const clientHandle = this.nextSocketHandle++;
    const serverHandle = this.nextSocketHandle++;
    const clientPort = this.allocClientPort();
    const serverLocalHost = listener.host === "0.0.0.0"
      ? "10.0.2.15"
      : "127.0.0.1";

    const clientSock: PairedSocket = {
      handle: clientHandle,
      peerHandle: serverHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: serverLocalHost,
      peerPort: listener.port,
      localHost: "127.0.0.1",
      localPort: clientPort,
      ownsClientPort: true,
    };
    const serverSock: PairedSocket = {
      handle: serverHandle,
      peerHandle: clientHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "127.0.0.1",
      peerPort: clientPort,
      localHost: serverLocalHost,
      localPort: listener.port,
    };
    this.sockets.set(clientHandle, clientSock);
    this.sockets.set(serverHandle, serverSock);

    const accepted: AcceptedConnection = {
      socket: serverHandle,
      peerHost: "127.0.0.1",
      peerPort: clientPort,
      localHost: serverLocalHost,
      localPort: listener.port,
    };
    // If a guest is already awaiting accept, hand it over immediately;
    // otherwise queue.
    const waiter = listener.acceptWaiters.shift();
    if (waiter) waiter.resolve(accepted);
    else listener.pending.push(accepted);

    return {
      ok: true,
      socket: clientHandle,
      peerHost: clientSock.peerHost,
      peerPort: clientSock.peerPort,
      localHost: clientSock.localHost,
      localPort: clientSock.localPort,
    };
  }

  accept(handle: ListenerHandle): Promise<AcceptedConnection> {
    const listener = this.listeners.get(handle);
    if (!listener || listener.closed) {
      return Promise.reject(new Error(`accept: listener closed`));
    }
    const ready = listener.pending.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise<AcceptedConnection>((resolve, reject) => {
      listener.acceptWaiters.push({ resolve, reject });
    });
  }

  /** Synchronous poll variant — for callers (loopback backend) that want
   *  EAGAIN/wouldBlock semantics without awaiting. */
  acceptNow(handle: ListenerHandle): AcceptedConnection | null {
    const listener = this.listeners.get(handle);
    if (!listener || listener.closed) return null;
    return listener.pending.shift() ?? null;
  }

  closeListener(handle: ListenerHandle): void {
    const listener = this.listeners.get(handle);
    if (!listener) return;
    listener.closed = true;
    const info: ListenerInfo = {
      handle,
      host: listener.host,
      port: listener.port,
      localPath: listener.localPath,
    };
    for (const [key, value] of this.routes) {
      if (value === handle) this.routes.delete(key);
    }
    this.listeners.delete(handle);
    // Release the listener's port unless another listener still holds it
    // (currently impossible since we reject collisions in listen(), but
    // keep this defensive in case alias bookkeeping changes).
    let stillBound = false;
    for (const other of this.listeners.values()) {
      if (other.port === listener.port) {
        stillBound = true;
        break;
      }
    }
    if (!stillBound) this.busyPorts.delete(listener.port);
    const err = new Error("accept: listener closed");
    for (const w of listener.acceptWaiters.splice(0)) w.reject(err);
    // Drain unclaimed accepts: close their server-side sockets so the
    // connected clients see EOF on the next recvAsync instead of
    // hanging forever waiting for a peer that will never read.
    for (const accepted of listener.pending.splice(0)) {
      this.closeSocket(accepted.socket);
    }
    // Also drain unix-specific queues.
    if (listener.unixAcceptWaiters) {
      for (const w of listener.unixAcceptWaiters.splice(0)) w.reject(err);
    }
    if (listener.pendingUnix) {
      for (const accepted of listener.pendingUnix.splice(0)) {
        this.closeSocket(accepted.socket);
      }
    }
    this.emit("unlisten", info);
  }

  // ── AF_UNIX path-namespace methods ────────────────────────────────────────

  /**
   * Bind a unix pathname socket. Creates a listener keyed by `AF_UNIX:<path>`.
   * Throws EADDRINUSE if path is already bound.
   */
  listenOnPath(path: string, backlog: number): ListenerHandle {
    const routeKey = `AF_UNIX:${path}`;
    if (this.routes.has(routeKey)) {
      throw new Error(`address ${path} already in use`);
    }
    const handle = this.nextListenerHandle++;
    const state: ListenerState = {
      handle,
      port: 0,
      backlog,
      pending: [],
      acceptWaiters: [],
      closed: false,
      isUnixListener: true,
      localPath: path,
      pendingUnix: [],
      unixAcceptWaiters: [],
    };
    this.listeners.set(handle, state);
    this.routes.set(routeKey, handle);
    return handle;
  }

  /**
   * Connect to a unix pathname listener. Creates a paired socket and either
   * hands it to a parked acceptUnix waiter or pushes it to pendingUnix.
   */
  connectToPath(path: string): UnixConnectResult {
    const routeKey = `AF_UNIX:${path}`;
    const listenerHandle = this.routes.get(routeKey);
    const listener = listenerHandle !== undefined
      ? this.listeners.get(listenerHandle)
      : undefined;
    if (!listener || listener.closed) {
      return { ok: false, error: `connection refused: ${path}` };
    }
    const pendingUnix = listener.pendingUnix!;
    const unixAcceptWaiters = listener.unixAcceptWaiters!;
    if (
      unixAcceptWaiters.length === 0 &&
      pendingUnix.length >= listener.backlog
    ) {
      return { ok: false, error: "connection refused: listener backlog full" };
    }

    const clientHandle = this.nextSocketHandle++;
    const serverHandle = this.nextSocketHandle++;

    const clientSock: PairedSocket = {
      handle: clientHandle,
      peerHandle: serverHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "",
      peerPort: 0,
      localHost: "",
      localPort: 0,
      localPath: path,
      peerPath: path,
    };
    const serverSock: PairedSocket = {
      handle: serverHandle,
      peerHandle: clientHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "",
      peerPort: 0,
      localHost: "",
      localPort: 0,
      localPath: path,
      peerPath: path,
    };
    this.sockets.set(clientHandle, clientSock);
    this.sockets.set(serverHandle, serverSock);

    const accepted: UnixAcceptedConnection = {
      socket: serverHandle,
      localPath: path,
      peerPath: path,
    };

    const waiter = unixAcceptWaiters.shift();
    if (waiter) waiter.resolve(accepted);
    else pendingUnix.push(accepted);

    return { ok: true, socket: clientHandle, localPath: path, peerPath: path };
  }

  /** Async accept for AF_UNIX listeners. */
  acceptUnix(handle: ListenerHandle): Promise<UnixAcceptedConnection> {
    const listener = this.listeners.get(handle);
    if (!listener || listener.closed) {
      return Promise.reject(new Error("accept: listener closed"));
    }
    if (!listener.isUnixListener) {
      return Promise.reject(
        new Error("acceptUnix: not a unix listener"),
      );
    }
    const ready = listener.pendingUnix!.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise<UnixAcceptedConnection>((resolve, reject) => {
      listener.unixAcceptWaiters!.push({ resolve, reject });
    });
  }

  /** Synchronous poll variant for AF_UNIX accept. */
  acceptNowUnix(handle: ListenerHandle): UnixAcceptedConnection | null {
    const listener = this.listeners.get(handle);
    if (!listener || listener.closed || !listener.isUnixListener) return null;
    return listener.pendingUnix!.shift() ?? null;
  }

  // ── AF_UNIX abstract namespace methods ────────────────────────────────────

  /**
   * Bind an abstract socket. Key: `AF_UNIX_ABSTRACT:<name>`.
   * Abstract sockets are filesystem-invisible: no VFS inode is ever created.
   */
  listenOnAbstract(name: string, backlog: number): ListenerHandle {
    const routeKey = `AF_UNIX_ABSTRACT:${name}`;
    if (this.routes.has(routeKey)) {
      throw new Error(`abstract address @${name} already in use`);
    }
    const handle = this.nextListenerHandle++;
    const state: ListenerState = {
      handle,
      port: 0,
      backlog,
      pending: [],
      acceptWaiters: [],
      closed: false,
      isUnixListener: true,
      localPath: `\0${name}`, // leading NUL marks abstract
      pendingUnix: [],
      unixAcceptWaiters: [],
    };
    this.listeners.set(handle, state);
    this.routes.set(routeKey, handle);
    return handle;
  }

  /**
   * Connect to an abstract socket listener. Creates a paired socket and
   * either hands it to a parked unixAcceptWaiters entry or queues it.
   */
  connectToAbstract(name: string): UnixConnectResult {
    const routeKey = `AF_UNIX_ABSTRACT:${name}`;
    const listenerHandle = this.routes.get(routeKey);
    const listener = listenerHandle !== undefined
      ? this.listeners.get(listenerHandle)
      : undefined;
    if (!listener || listener.closed) {
      return { ok: false, error: `connection refused: @${name}` };
    }
    const pendingUnix = listener.pendingUnix!;
    const unixAcceptWaiters = listener.unixAcceptWaiters!;
    if (
      unixAcceptWaiters.length === 0 &&
      pendingUnix.length >= listener.backlog
    ) {
      return { ok: false, error: "connection refused: listener backlog full" };
    }

    const clientHandle = this.nextSocketHandle++;
    const serverHandle = this.nextSocketHandle++;
    const abstractPath = `\0${name}`; // leading NUL for C-side reconstruction

    const clientSock: PairedSocket = {
      handle: clientHandle,
      peerHandle: serverHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "",
      peerPort: 0,
      localHost: "",
      localPort: 0,
      localPath: abstractPath,
      peerPath: abstractPath,
    };
    const serverSock: PairedSocket = {
      handle: serverHandle,
      peerHandle: clientHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "",
      peerPort: 0,
      localHost: "",
      localPort: 0,
      localPath: abstractPath,
      peerPath: abstractPath,
    };
    this.sockets.set(clientHandle, clientSock);
    this.sockets.set(serverHandle, serverSock);

    const accepted: UnixAcceptedConnection = {
      socket: serverHandle,
      localPath: abstractPath,
      peerPath: abstractPath,
    };

    const waiter = unixAcceptWaiters.shift();
    if (waiter) waiter.resolve(accepted);
    else pendingUnix.push(accepted);

    return {
      ok: true,
      socket: clientHandle,
      localPath: abstractPath,
      peerPath: abstractPath,
    };
  }

  /** Close an abstract socket listener by name. */
  closeAbstractListener(name: string): void {
    const routeKey = `AF_UNIX_ABSTRACT:${name}`;
    const listenerHandle = this.routes.get(routeKey);
    if (listenerHandle === undefined) return;
    // Remove the abstract-namespace route key before delegating cleanup.
    this.routes.delete(routeKey);
    this.closeListener(listenerHandle);
  }

  /** Close a unix pathname listener by path, removing the route key. */
  closePathListener(path: string): void {
    const routeKey = `AF_UNIX:${path}`;
    const listenerHandle = this.routes.get(routeKey);
    if (listenerHandle === undefined) return;
    // closeListener already removes all route keys for this handle and
    // drains waiters, but it doesn't know the AF_UNIX key — delete it
    // first so callers see it gone immediately, then delegate cleanup.
    this.routes.delete(routeKey);
    this.closeListener(listenerHandle);
  }

  /** Remove a DGRAM route for a pathname without closing the socket fd. */
  removeDgramRoute(path: string): void {
    this.dgramRoutes.delete(`DGRAM:${path}`);
  }

  /**
   * Create a socketpair() — two connected AF_UNIX sockets, no listener.
   * Returns raw registry handles (positive ints). Callers in kernel-imports
   * negate them for the loopback backend convention.
   */
  openUnixPair(type: "STREAM" = "STREAM"): { a: SocketHandle; b: SocketHandle } {
    if (type !== "STREAM") throw new Error(`openUnixPair: unsupported type ${type}`);
    const aHandle = this.nextSocketHandle++;
    const bHandle = this.nextSocketHandle++;
    const aSock: PairedSocket = {
      handle: aHandle,
      peerHandle: bHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "",
      peerPort: 0,
      localHost: "",
      localPort: 0,
    };
    const bSock: PairedSocket = {
      handle: bHandle,
      peerHandle: aHandle,
      rx: [],
      rxAnc: [],
      rxWaiters: [],
      closed: false,
      peerHost: "",
      peerPort: 0,
      localHost: "",
      localPort: 0,
    };
    this.sockets.set(aHandle, aSock);
    this.sockets.set(bHandle, bSock);
    return { a: aHandle, b: bHandle };
  }

  /** Query unix path address info for a socket handle. */
  socketUnixAddrInfo(
    handle: SocketHandle,
  ): { localPath?: string; peerPath?: string } | null {
    const s = this.sockets.get(handle);
    if (!s) return null;
    return { localPath: s.localPath, peerPath: s.peerPath };
  }

  // ── existing methods continue ──────────────────────────────────────────────

  send(handle: SocketHandle, bytes: Uint8Array): SendResult {
    return this.sendWithAnc(handle, bytes, undefined);
  }

  /** Internal: send bytes + optional ancillary fds to the peer. */
  sendWithAnc(
    handle: SocketHandle,
    bytes: Uint8Array,
    ancFds: number[] | undefined,
    senderPid?: number,
  ): SendResult {
    const local = this.sockets.get(handle);
    if (!local || local.closed) {
      return { ok: false, error: "send: invalid socket" };
    }
    const peer = this.sockets.get(local.peerHandle);
    if (!peer || peer.closed) return { ok: false, error: "send: peer closed" };
    if (bytes.length === 0 && !ancFds) return { ok: true, bytesSent: 0 };
    const ancEntry: AncEntry | undefined = ancFds && ancFds.length > 0
      ? { fds: ancFds, senderPid: senderPid ?? 0 }
      : undefined;
    const waiter = peer.rxWaiters.shift();
    if (waiter) {
      const slice = bytes.length <= waiter.max
        ? bytes
        : bytes.subarray(0, waiter.max);
      if (bytes.length > waiter.max) {
        peer.rx.unshift(bytes.subarray(waiter.max));
        peer.rxAnc.unshift(undefined);
      }
      // Store anc in pendingWaiterAnc so recvmsg can retrieve it after
      // recvAsync resolves (peekAnc runs before the await and sees nothing).
      peer.pendingWaiterAnc = ancEntry;
      waiter.resolve({ ok: true, bytes: copy(slice) });
    } else {
      peer.rx.push(copy(bytes));
      peer.rxAnc.push(ancEntry);
    }
    return { ok: true, bytesSent: bytes.length };
  }

  /** Peek at ancillary data for the next queued message (does not consume it).
   *  Returns undefined if no message is queued — use popWaiterAnc instead when
   *  recvAsync parks a waiter and the send arrives concurrently. */
  peekAnc(handle: SocketHandle): AncEntry | undefined {
    const local = this.sockets.get(handle);
    if (!local) return undefined;
    return local.rxAnc[0];
  }

  /** Consume ancillary data for the most recently received message. */
  popAnc(handle: SocketHandle): AncEntry | undefined {
    const local = this.sockets.get(handle);
    if (!local) return undefined;
    return local.rxAnc.shift();
  }

  /** Consume ancillary data that was delivered via the fast-path waiter route
   *  (sendWithAnc resolved a parked recvAsync waiter directly). Must be called
   *  at most once after each recvAsync completes, only when peekAnc was undefined. */
  popWaiterAnc(handle: SocketHandle): AncEntry | undefined {
    const local = this.sockets.get(handle);
    if (!local) return undefined;
    const anc = local.pendingWaiterAnc;
    local.pendingWaiterAnc = undefined;
    return anc;
  }

  recv(handle: SocketHandle, max: number, opts: RecvOptions = {}): RecvResult {
    const local = this.sockets.get(handle);
    if (!local) return { ok: false, error: "recv: invalid socket" };
    const first = local.rx.shift();
    if (first) {
      const result = takeFrom(first, max, local);
      // Shift the ancillary slot AFTER takeFrom so we can detect whether it
      // requeued a tail.  If the chunk was too large, takeFrom unshifted the
      // remainder back into local.rx; push an empty slot for that tail so
      // that the next read does not consume the following message's ancillary.
      local.rxAnc.shift();
      if (first.byteLength > max) local.rxAnc.unshift(undefined);
      return result;
    }
    if (this.peerClosed(local)) return { ok: true, bytes: new Uint8Array(0) };
    if (opts.nonblocking) return { ok: false, error: "EAGAIN" };
    // Synchronous blocking recv is not supported by this layer; callers
    // must use recvAsync.
    return { ok: false, error: "recv: would block (use recvAsync)" };
  }

  recvAsync(handle: SocketHandle, max: number): Promise<RecvResult> {
    const local = this.sockets.get(handle);
    if (!local) {
      return Promise.resolve({ ok: false, error: "recv: invalid socket" });
    }
    const first = local.rx.shift();
    if (first) {
      const result = takeFrom(first, max, local);
      local.rxAnc.shift();
      if (first.byteLength > max) local.rxAnc.unshift(undefined);
      return Promise.resolve(result);
    }
    if (this.peerClosed(local)) {
      return Promise.resolve({ ok: true, bytes: new Uint8Array(0) });
    }
    return new Promise<RecvResult>((resolve) => {
      local.rxWaiters.push({ resolve, max });
    });
  }

  private peerClosed(local: PairedSocket): boolean {
    const peer = this.sockets.get(local.peerHandle);
    return !peer || peer.closed;
  }

  closeSocket(handle: SocketHandle): void {
    const local = this.sockets.get(handle);
    if (!local) return;
    local.closed = true;
    this.sockets.delete(handle);
    if (local.ownsClientPort) this.releaseClientPort(local.localPort);
    // Wake our own waiters: a recvAsync in flight on a socket the
    // caller just closed must resolve, not leak. Report as error since
    // EOF would imply the peer closed.
    for (const w of local.rxWaiters.splice(0)) {
      w.resolve({ ok: false, error: "recv: socket closed" });
    }
    // Wake peer waiters with EOF — from the peer's perspective, we
    // are the closed end.
    const peer = this.sockets.get(local.peerHandle);
    if (peer) {
      for (const w of peer.rxWaiters.splice(0)) {
        w.resolve({ ok: true, bytes: new Uint8Array(0) });
      }
    }
  }

  socketAddrInfo(handle: SocketHandle): {
    peerHost: string;
    peerPort: number;
    localHost: string;
    localPort: number;
  } | null {
    const s = this.sockets.get(handle);
    if (!s) return null;
    return {
      peerHost: s.peerHost,
      peerPort: s.peerPort,
      localHost: s.localHost,
      localPort: s.localPort,
    };
  }

  listListeners(): ListenerInfo[] {
    return [...this.listeners.values()].map((l) => ({
      handle: l.handle,
      host: l.host,
      port: l.port,
      localPath: l.localPath,
    }));
  }

  on(event: RegistryEvent, cb: (info: ListenerInfo) => void): () => void {
    const set = event === "listen" ? this.listeners_ev : this.unlisteners_ev;
    set.add(cb);
    return () => set.delete(cb);
  }

  private emit(event: RegistryEvent, info: ListenerInfo): void {
    const set = event === "listen" ? this.listeners_ev : this.unlisteners_ev;
    for (const cb of set) {
      try {
        cb(info);
      } catch {
        // listener errors must not break the registry
      }
    }
  }

  private allocEphemeralPort(): number {
    // Inclusive range, so probe count is END - START + 1 (without this the
    // last port is never tried).
    const probeCount = EPHEMERAL_PORT_END - EPHEMERAL_PORT_START + 1;
    for (let i = 0; i < probeCount; i++) {
      const port = this.nextEphemeralPort++;
      if (this.nextEphemeralPort > EPHEMERAL_PORT_END) {
        this.nextEphemeralPort = EPHEMERAL_PORT_START;
      }
      // Listener-bound and in-flight client ephemeral ports both block
      // reuse so two concurrent connect()s don't share a localPort and
      // listen(0) can't recycle into a port a client already holds.
      if (this.busyPorts.has(port) || this.clientPorts.has(port)) continue;
      return port;
    }
    throw new Error("no ephemeral ports available");
  }

  private allocClientPort(): number {
    const port = this.allocEphemeralPort();
    this.clientPorts.add(port);
    return port;
  }

  private releaseClientPort(port: number): void {
    this.clientPorts.delete(port);
  }

  // ── SOCK_DGRAM methods (Slice 4) ──────────────────────────────────────────

  /** Allocate a new SOCK_DGRAM socket. Returns the raw handle. */
  openDgramSocket(): SocketHandle {
    const handle = this.nextSocketHandle++;
    const s: DgramSocket = {
      handle,
      messages: [],
      recvWaiters: [],
      closed: false,
    };
    this.dgramSockets.set(handle, s);
    return handle;
  }

  /** Create a connected SOCK_DGRAM socketpair. Returns two linked handles. */
  openDgramPair(): { a: SocketHandle; b: SocketHandle } {
    const aHandle = this.nextSocketHandle++;
    const bHandle = this.nextSocketHandle++;
    const aSock: DgramSocket = {
      handle: aHandle,
      messages: [],
      recvWaiters: [],
      peerHandle: bHandle,
      closed: false,
    };
    const bSock: DgramSocket = {
      handle: bHandle,
      messages: [],
      recvWaiters: [],
      peerHandle: aHandle,
      closed: false,
    };
    this.dgramSockets.set(aHandle, aSock);
    this.dgramSockets.set(bHandle, bSock);
    return { a: aHandle, b: bHandle };
  }

  /** Bind a SOCK_DGRAM socket to a filesystem path. */
  bindDgramToPath(handle: SocketHandle, path: string): void {
    const s = this.dgramSockets.get(handle);
    if (!s) throw new Error(`bindDgramToPath: unknown handle ${handle}`);
    const key = `DGRAM:${path}`;
    if (this.dgramRoutes.has(key)) throw new Error(`EADDRINUSE: ${path}`);
    s.boundPath = path;
    this.dgramRoutes.set(key, handle);
  }

  /** Deliver a datagram to the socket bound at `toPath`. */
  sendDgramToPath(
    toPath: string,
    bytes: Uint8Array,
    fromPath?: string,
  ): SendResult {
    const handle = this.dgramRoutes.get(`DGRAM:${toPath}`);
    if (handle === undefined) return { ok: false, error: `no dgram socket at ${toPath}` };
    const s = this.dgramSockets.get(handle);
    if (!s || s.closed) return { ok: false, error: `dgram socket closed: ${toPath}` };
    const msg: DgramMessage = { bytes: copy(bytes), fromPath };
    const waiter = s.recvWaiters.shift();
    if (waiter) waiter.resolve(msg);
    else s.messages.push(msg);
    return { ok: true, bytesSent: bytes.length };
  }

  /** Send a datagram to the peer of a socketpair DGRAM socket. */
  sendDgramToPeer(handle: SocketHandle, bytes: Uint8Array): SendResult {
    const s = this.dgramSockets.get(handle);
    if (!s || s.closed) return { ok: false, error: "send: invalid dgram socket" };
    if (s.peerHandle === undefined) return { ok: false, error: "send: no peer (unconnected)" };
    const peer = this.dgramSockets.get(s.peerHandle);
    if (!peer || peer.closed) return { ok: false, error: "send: dgram peer closed" };
    const msg: DgramMessage = { bytes: copy(bytes) };
    const waiter = peer.recvWaiters.shift();
    if (waiter) waiter.resolve(msg);
    else peer.messages.push(msg);
    return { ok: true, bytesSent: bytes.length };
  }

  /** Synchronous dgram recv — pops one message or returns EAGAIN.
   *  Truncates the payload to maxBytes per POSIX SOCK_DGRAM semantics. */
  recvDgram(
    handle: SocketHandle,
    maxBytes: number,
    nonblocking?: boolean,
  ): (RecvResult & { fromPath?: string; fromAbstract?: string }) | { ok: false; error: "EAGAIN" } {
    const s = this.dgramSockets.get(handle);
    if (!s || s.closed) return { ok: false, error: "EAGAIN" };
    const msg = s.messages.shift();
    if (!msg) {
      if (nonblocking) return { ok: false, error: "EAGAIN" };
      return { ok: false, error: "EAGAIN" };
    }
    const bytes = msg.bytes.length <= maxBytes ? msg.bytes : msg.bytes.subarray(0, maxBytes);
    return { ok: true, bytes, fromPath: msg.fromPath, fromAbstract: msg.fromAbstract };
  }

  /** Async dgram recv — resolves when a message arrives.
   *  Truncates the payload to maxBytes per POSIX SOCK_DGRAM semantics. */
  recvDgramAsync(
    handle: SocketHandle,
    maxBytes: number,
  ): Promise<RecvResult & { fromPath?: string; fromAbstract?: string }> {
    const s = this.dgramSockets.get(handle);
    if (!s || s.closed) {
      return Promise.resolve({ ok: false, error: "recv: invalid dgram socket" });
    }
    const msg = s.messages.shift();
    if (msg) {
      const bytes = msg.bytes.length <= maxBytes ? msg.bytes : msg.bytes.subarray(0, maxBytes);
      return Promise.resolve({
        ok: true,
        bytes,
        fromPath: msg.fromPath,
        fromAbstract: msg.fromAbstract,
      });
    }
    return new Promise<RecvResult & { fromPath?: string; fromAbstract?: string }>((resolve, reject) => {
      s.recvWaiters.push({
        resolve: (m: DgramMessage) => resolve({
          ok: true,
          bytes: m.bytes.length <= maxBytes ? m.bytes : m.bytes.subarray(0, maxBytes),
          fromPath: m.fromPath,
          fromAbstract: m.fromAbstract,
        }),
        reject,
      });
    });
  }

  /** Close a SOCK_DGRAM socket, removing route entries and rejecting waiters. */
  closeDgramSocket(handle: SocketHandle): void {
    const s = this.dgramSockets.get(handle);
    if (!s) return;
    s.closed = true;
    if (s.boundPath) this.dgramRoutes.delete(`DGRAM:${s.boundPath}`);
    this.dgramSockets.delete(handle);
    const err = new Error("recv: dgram socket closed");
    for (const w of s.recvWaiters.splice(0)) w.reject(err);
  }

  /** Get peerHandle for a dgram socket (used to detect socketpair dgram). */
  dgramSocketInfo(handle: SocketHandle): { boundPath?: string; peerHandle?: SocketHandle } | null {
    const s = this.dgramSockets.get(handle);
    if (!s) return null;
    return { boundPath: s.boundPath, peerHandle: s.peerHandle };
  }
}

function copy(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

function takeFrom(
  first: Uint8Array,
  max: number,
  sock: PairedSocket,
): RecvResult {
  if (first.byteLength <= max) return { ok: true, bytes: first };
  sock.rx.unshift(first.subarray(max));
  return { ok: true, bytes: first.subarray(0, max) };
}
