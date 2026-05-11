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

export type ListenHost = "127.0.0.1" | "localhost" | "0.0.0.0";

export interface ListenRequest {
  host: ListenHost;
  port: number;
  backlog: number;
}

export interface ListenerInfo {
  handle: ListenerHandle;
  host: ListenHost;
  port: number;
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

interface PairedSocket {
  handle: SocketHandle;
  peerHandle: SocketHandle;
  rx: Uint8Array[];
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
}

interface ListenerState {
  handle: ListenerHandle;
  host: ListenHost;
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
      // AF_UNIX listeners still need host/port fields to satisfy the type;
      // use sentinel values that are clearly not AF_INET.
      host: "127.0.0.1" as ListenHost,
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

  /**
   * Create a socketpair() — two connected AF_UNIX sockets, no listener.
   * Returns raw registry handles (positive ints). Callers in kernel-imports
   * negate them for the loopback backend convention.
   */
  openUnixPair(_type: "STREAM" = "STREAM"): { a: SocketHandle; b: SocketHandle } {
    const aHandle = this.nextSocketHandle++;
    const bHandle = this.nextSocketHandle++;
    const aSock: PairedSocket = {
      handle: aHandle,
      peerHandle: bHandle,
      rx: [],
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
    const local = this.sockets.get(handle);
    if (!local || local.closed) {
      return { ok: false, error: "send: invalid socket" };
    }
    const peer = this.sockets.get(local.peerHandle);
    if (!peer || peer.closed) return { ok: false, error: "send: peer closed" };
    if (bytes.length === 0) return { ok: true, bytesSent: 0 };
    const waiter = peer.rxWaiters.shift();
    if (waiter) {
      const slice = bytes.length <= waiter.max
        ? bytes
        : bytes.subarray(0, waiter.max);
      if (bytes.length > waiter.max) {
        peer.rx.unshift(bytes.subarray(waiter.max));
      }
      waiter.resolve({ ok: true, bytes: copy(slice) });
    } else {
      peer.rx.push(copy(bytes));
    }
    return { ok: true, bytesSent: bytes.length };
  }

  recv(handle: SocketHandle, max: number, opts: RecvOptions = {}): RecvResult {
    const local = this.sockets.get(handle);
    if (!local) return { ok: false, error: "recv: invalid socket" };
    const first = local.rx.shift();
    if (first) return takeFrom(first, max, local);
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
    if (first) return Promise.resolve(takeFrom(first, max, local));
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
