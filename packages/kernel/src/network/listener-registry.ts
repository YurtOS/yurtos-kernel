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
  private nextListenerHandle = 1;
  private nextSocketHandle = 1;
  private nextEphemeralPort = EPHEMERAL_PORT_START;
  private listeners_ev = new Set<(info: ListenerInfo) => void>();
  private unlisteners_ev = new Set<(info: ListenerInfo) => void>();

  listen(req: ListenRequest): ListenerInfo {
    const port = req.port === 0 ? this.allocEphemeralPort() : req.port;
    const key = `${normalizeHost(req.host)}:${port}`;
    if (this.routes.has(key)) {
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

    const clientHandle = this.nextSocketHandle++;
    const serverHandle = this.nextSocketHandle++;
    const clientPort = this.allocEphemeralPort();
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
    const err = new Error("accept: listener closed");
    for (const w of listener.acceptWaiters.splice(0)) w.reject(err);
    this.emit("unlisten", info);
  }

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
    // Wake any peer waiters with EOF.
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
    for (let i = 0; i < EPHEMERAL_PORT_END - EPHEMERAL_PORT_START; i++) {
      const port = this.nextEphemeralPort++;
      if (this.nextEphemeralPort > EPHEMERAL_PORT_END) {
        this.nextEphemeralPort = EPHEMERAL_PORT_START;
      }
      const inUse = this.routes.has(`127.0.0.1:${port}`) ||
        this.routes.has(`0.0.0.0:${port}`);
      if (!inUse) return port;
    }
    throw new Error("no ephemeral ports available");
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
