import type { NetworkBridgeLike } from "./bridge.js";
import type { AcceptedConnection } from "./listener-registry.js";
import { ListenerRegistry } from "./listener-registry.js";

export type SocketHandle = number;
export type SocketListenerHandle = number;

export interface SocketPortMapping {
  sandboxHost: "0.0.0.0";
  sandboxPort: number;
  hostPort: number;
}

export interface SocketListenRequest {
  host: "127.0.0.1" | "localhost" | "0.0.0.0";
  port: number;
  backlog: number;
  mapping?: SocketPortMapping;
}

export interface SocketListenBackendRequest {
  host: "127.0.0.1" | "localhost" | "0.0.0.0";
  port: number;
  backlog: number;
  mapping?: SocketPortMapping;
}

export interface SocketListenPolicy {
  /**
   * Allow future sandbox-local loopback listeners. This does not expose host
   * ports and is still unsupported until the in-kernel listener registry exists.
   */
  allowLoopback?: boolean;
  /** Explicit host-exposed port mappings, Docker-style. */
  portMappings?: SocketPortMapping[];
  /**
   * Final authorization hook for a future listen() call. Current runtime code
   * stores the hook but still rejects listen because server sockets are deferred.
   */
  onListen?: (request: SocketListenRequest) => boolean | Promise<boolean>;
}

export type SocketBackendResult =
  | { ok: true; data?: string; bytes_sent?: number; data_b64?: string }
  | { ok: false; error: string };

export type SocketListenBackendResult =
  | { ok: true; listener: SocketListenerHandle; host: string; port: number }
  | { ok: false; error: string };

export type SocketAcceptBackendResult =
  | {
    ok: true;
    socket: SocketHandle;
    peerHost: string;
    peerPort: number;
    localHost: string;
    localPort: number;
  }
  | { ok: false; wouldBlock: true; error: "accept would block" }
  | { ok: false; error: string };

export interface SocketBackend {
  connect(
    req: { host: string; port: number; tls: boolean },
  ): { ok: true; socket: SocketHandle } | { ok: false; error: string };
  send(socket: SocketHandle, dataB64: string): SocketBackendResult;
  recv(
    socket: SocketHandle,
    maxBytes: number,
    opts?: { nonblocking?: boolean },
  ): SocketBackendResult;
  setNoDelay?(socket: SocketHandle, enabled: boolean): SocketBackendResult;
  listen?(req: SocketListenBackendRequest): SocketListenBackendResult;
  /** Polls for one accepted socket. Must not block the bridge request loop. */
  accept?(listener: SocketListenerHandle): SocketAcceptBackendResult;
  /**
   * Optional blocking accept path. Backends that omit this fall back to
   * accept(), preserving older connect-only/mock implementations.
   */
  acceptAsync?(
    listener: SocketListenerHandle,
  ): Promise<SocketAcceptBackendResult>;
  /**
   * Optional blocking recv path. Backends that omit this fall back to
   * recv(..., { nonblocking: false }).
   */
  recvAsync?(
    socket: SocketHandle,
    maxBytes: number,
  ): Promise<SocketBackendResult>;
  closeListener?(listener: SocketListenerHandle): SocketBackendResult;
  close(socket: SocketHandle): SocketBackendResult;
}

function parseAccept(
  result: { ok: boolean; [key: string]: unknown },
): SocketAcceptBackendResult {
  if (!result.ok && result.would_block === true) {
    return { ok: false, wouldBlock: true, error: "accept would block" };
  }
  if (!result.ok || typeof result.socket_id !== "number") {
    return {
      ok: false,
      error: typeof result.error === "string"
        ? result.error
        : "socket accept failed",
    };
  }
  return {
    ok: true,
    socket: result.socket_id,
    peerHost: typeof result.peer_host === "string"
      ? result.peer_host
      : "127.0.0.1",
    peerPort: typeof result.peer_port === "number" ? result.peer_port : 0,
    localHost: typeof result.local_host === "string"
      ? result.local_host
      : "127.0.0.1",
    localPort: typeof result.local_port === "number" ? result.local_port : 0,
  };
}

function socketResult(
  result: { ok: boolean; [key: string]: unknown },
): SocketBackendResult {
  if (result.ok) {
    const ok: {
      ok: true;
      data?: string;
      bytes_sent?: number;
      data_b64?: string;
    } = { ok: true };
    if (typeof result.data === "string") ok.data = result.data;
    if (typeof result.data_b64 === "string") ok.data_b64 = result.data_b64;
    if (typeof result.bytes_sent === "number") {
      ok.bytes_sent = result.bytes_sent;
    }
    return ok;
  }
  return {
    ok: false,
    error: typeof result.error === "string"
      ? result.error
      : "socket operation failed",
  };
}

export function recvSocketAsync(
  backend: SocketBackend,
  socket: SocketHandle,
  maxBytes: number,
): Promise<SocketBackendResult> {
  return backend.recvAsync?.(socket, maxBytes) ??
    Promise.resolve(backend.recv(socket, maxBytes, { nonblocking: false }));
}

export function acceptSocketAsync(
  backend: SocketBackend,
  listener: SocketListenerHandle,
): Promise<SocketAcceptBackendResult> {
  if (backend.acceptAsync) return backend.acceptAsync(listener);
  return Promise.resolve(
    backend.accept?.(listener) ??
      { ok: false, error: "accept: invalid listener" },
  );
}

/**
 * Loopback backend over a {@link ListenerRegistry}.
 *
 * Public socket and listener handles are negative integers so they never
 * collide with delegate-allocated positive handles (the network bridge
 * worker hands out positive ids). On every method, a negative handle
 * means "this is mine, route to the registry"; a non-negative handle
 * means "delegate". The optional registry argument lets `sandbox.net`
 * share the same registry instance the kernel sees.
 */
export function createLoopbackSocketBackend(
  delegate?: SocketBackend,
  registry: ListenerRegistry = new ListenerRegistry(),
): SocketBackend & { registry: ListenerRegistry } {
  const isLocal = (h: number) => h < 0;
  const pub = (h: number) => -h;
  const reg = (h: number) => -h;

  function bytesToBase64(data: Uint8Array): string {
    if (data.byteLength === 0) return "";
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(value: string): Uint8Array {
    if (value === "") return new Uint8Array(0);
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function publishAccepted(a: AcceptedConnection): SocketAcceptBackendResult {
    return {
      ok: true,
      socket: pub(a.socket),
      peerHost: a.peerHost,
      peerPort: a.peerPort,
      localHost: a.localHost,
      localPort: a.localPort,
    };
  }

  return {
    registry,

    connect(req) {
      const r = registry.connect({ host: req.host, port: req.port });
      if (r.ok) return { ok: true, socket: pub(r.socket) };
      return delegate?.connect(req) ?? { ok: false, error: r.error };
    },

    send(socket, dataB64) {
      if (isLocal(socket)) {
        const r = registry.send(reg(socket), base64ToBytes(dataB64));
        return r.ok
          ? { ok: true, bytes_sent: r.bytesSent }
          : { ok: false, error: r.error };
      }
      return delegate?.send(socket, dataB64) ??
        { ok: false, error: "send: invalid socket" };
    },

    recv(socket, maxBytes, opts) {
      if (isLocal(socket)) {
        const r = registry.recv(reg(socket), maxBytes, {
          nonblocking: true,
        });
        if (r.ok) return { ok: true, data_b64: bytesToBase64(r.bytes) };
        return { ok: false, error: r.error };
      }
      return delegate?.recv(socket, maxBytes, opts) ??
        { ok: false, error: "recv: invalid socket" };
    },

    async recvAsync(socket, maxBytes) {
      if (isLocal(socket)) {
        const r = await registry.recvAsync(reg(socket), maxBytes);
        return r.ok
          ? { ok: true, data_b64: bytesToBase64(r.bytes) }
          : { ok: false, error: r.error };
      }
      if (!delegate) return { ok: false, error: "recv: invalid socket" };
      return recvSocketAsync(delegate, socket, maxBytes);
    },

    setNoDelay(socket, enabled) {
      if (isLocal(socket)) return { ok: true };
      return delegate?.setNoDelay?.(socket, enabled) ?? { ok: true };
    },

    listen(req) {
      try {
        const r = registry.listen({
          host: req.host,
          port: req.port,
          backlog: req.backlog,
        });
        const publishedHost = req.host === "0.0.0.0" ? "10.0.2.15" : r.host;
        return {
          ok: true,
          listener: pub(r.handle),
          host: publishedHost,
          port: r.port,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    accept(listener) {
      if (isLocal(listener)) {
        const a = registry.acceptNow(reg(listener));
        return a
          ? publishAccepted(a)
          : { ok: false, wouldBlock: true, error: "accept would block" };
      }
      return delegate?.accept?.(listener) ??
        { ok: false, error: "accept: invalid listener" };
    },

    async acceptAsync(listener) {
      if (isLocal(listener)) {
        try {
          return publishAccepted(await registry.accept(reg(listener)));
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      if (!delegate) return { ok: false, error: "accept: invalid listener" };
      return acceptSocketAsync(delegate, listener);
    },

    closeListener(listener) {
      if (isLocal(listener)) {
        registry.closeListener(reg(listener));
        return { ok: true };
      }
      return delegate?.closeListener?.(listener) ??
        { ok: false, error: "close_listener: invalid listener" };
    },

    close(socket) {
      if (isLocal(socket)) {
        registry.closeSocket(reg(socket));
        return { ok: true };
      }
      return delegate?.close(socket) ?? { ok: true };
    },
  };
}

export function createNetworkBridgeSocketBackend(
  bridge: NetworkBridgeLike,
): SocketBackend {
  return {
    connect(req) {
      const result = bridge.requestSync({
        op: "connect",
        host: req.host,
        port: req.port,
        tls: req.tls,
      });
      if (!result.ok || typeof result.socket_id !== "number") {
        return {
          ok: false,
          error: typeof result.error === "string"
            ? result.error
            : "socket connect failed",
        };
      }
      return { ok: true, socket: result.socket_id };
    },

    send(socket, dataB64) {
      return socketResult(bridge.requestSync({
        op: "send",
        socket_id: socket,
        data_b64: dataB64,
      }));
    },

    recv(socket, maxBytes, opts) {
      return socketResult(bridge.requestSync({
        op: "recv",
        socket_id: socket,
        max_bytes: maxBytes,
        nonblocking: opts?.nonblocking === true,
      }));
    },

    setNoDelay(socket, enabled) {
      return socketResult(bridge.requestSync({
        op: "set_no_delay",
        socket_id: socket,
        enabled,
      }));
    },

    listen(req) {
      const result = bridge.requestSync({
        op: "listen",
        host: req.host,
        port: req.port,
        backlog: req.backlog,
        mapping: req.mapping,
      });
      if (!result.ok || typeof result.listener_id !== "number") {
        return {
          ok: false,
          error: typeof result.error === "string"
            ? result.error
            : "socket listen failed",
        };
      }
      return {
        ok: true,
        listener: result.listener_id,
        host: typeof result.host === "string" ? result.host : req.host,
        port: typeof result.port === "number" ? result.port : req.port,
      };
    },

    accept(listener) {
      return parseAccept(bridge.requestSync({
        op: "accept",
        listener_id: listener,
      }));
    },

    /**
     * The bridge worker serializes requests over the SAB; a long-running
     * accept on the worker side would deadlock against the connect that
     * feeds it. Poll instead, yielding the kernel-side event loop
     * between attempts so other host work can run. This is the
     * transport's only supported async pattern; the host-import handler
     * still sees a single `await acceptAsync`.
     */
    async acceptAsync(listener) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const r = parseAccept(bridge.requestSync({
          op: "accept",
          listener_id: listener,
        }));
        if (!(r.ok === false && "wouldBlock" in r && r.wouldBlock === true)) {
          return r;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { ok: false, error: "accept: timed out" };
    },

    recvAsync(socket, maxBytes) {
      return Promise.resolve(socketResult(bridge.requestSync({
        op: "recv",
        socket_id: socket,
        max_bytes: maxBytes,
        nonblocking: false,
      })));
    },

    closeListener(listener) {
      return socketResult(bridge.requestSync({
        op: "close_listener",
        listener_id: listener,
      }));
    },

    close(socket) {
      return socketResult(bridge.requestSync({
        op: "close",
        socket_id: socket,
      }));
    },
  };
}
