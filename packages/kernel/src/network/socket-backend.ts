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
  /** Allow AF_UNIX pathname and abstract domain sockets. */
  allowUnixDomain?: boolean;
  /** If set, only allow bind() on paths matching one of these patterns. */
  unixPathAllowlist?: RegExp[];
  /** If set, only allow abstract-namespace bind() on names matching one of these patterns. */
  unixAbstractAllowlist?: RegExp[];
}

export type SocketBackendResult =
  | { ok: true; data?: Uint8Array; bytes_sent?: number }
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

/**
 * Method return type that lets backends pick the cheapest shape. Loopback
 * stays sync (pure in-process registry calls); the network-bridge backend
 * returns Promises because the bridge is itself async on main (see
 * `NetworkBridge.requestSync`). Callers must `await` to handle both.
 */
export type Awaitable<T> = T | Promise<T>;

export interface SocketBackend {
  connect(
    req: { host: string; port: number; tls: boolean },
  ): Awaitable<
    | {
      ok: true;
      socket: SocketHandle;
      /** Peer/local addresses observed by the backend. Optional so
       *  long-lived test backends without registry-style bookkeeping
       *  remain valid; loopback and bridge backends always populate them. */
      peerHost?: string;
      peerPort?: number;
      localHost?: string;
      localPort?: number;
    }
    | { ok: false; error: string }
  >;
  send(socket: SocketHandle, data: Uint8Array): Awaitable<SocketBackendResult>;
  recv(
    socket: SocketHandle,
    maxBytes: number,
    opts?: { nonblocking?: boolean },
  ): Awaitable<SocketBackendResult>;
  setNoDelay?(
    socket: SocketHandle,
    enabled: boolean,
  ): Awaitable<SocketBackendResult>;
  /**
   * Begin listening for inbound connections.
   *
   * **Cross-process atomicity contract (#125 audit, 2026-05-18):** any
   * mutation of process-global state — ephemeral-port assignment,
   * loopback-route/registry insertion, listener-table writes — MUST
   * happen **only** in this method's resolved continuation (i.e.
   * synchronously inside the Promise's resolve path). Backends MUST
   * NOT mutate shared route/port state *before* their internal await
   * and finalize it *after*: that would let two concurrent listen()
   * calls from different processes interleave their global writes
   * across the worker-host dispatcher's per-process serializer
   * boundary. The in-tree loopback + bridge backends already satisfy
   * this; new backends inheriting this interface must too.
   *
   * See
   * `docs/superpowers/specs/2026-05-17-125-worker-host-cross-process-mutation-audit-design.md`
   * for the full rationale.
   */
  listen?(
    req: SocketListenBackendRequest,
  ): Awaitable<SocketListenBackendResult>;
  /** Polls for one accepted socket. Must not block the bridge request loop. */
  accept?(
    listener: SocketListenerHandle,
  ): Awaitable<SocketAcceptBackendResult>;
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
  closeListener?(
    listener: SocketListenerHandle,
  ): Awaitable<SocketBackendResult>;
  close(socket: SocketHandle): Awaitable<SocketBackendResult>;
  /**
   * Loopback backends expose their underlying ListenerRegistry so the host
   * can build a SandboxNet over the same routing tables the kernel sees.
   * Bridge / mock backends that don't have a registry leave this undefined.
   */
  registry?: ListenerRegistry;
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
      data?: Uint8Array;
      bytes_sent?: number;
    } = { ok: true };
    if (result.data instanceof Uint8Array) ok.data = result.data;
    if (Array.isArray(result.data)) {
      // The SAB bridge serializes worker responses through JSON, so byte
      // payloads arrive here as number arrays instead of typed arrays.
      ok.data = Uint8Array.from(result.data as number[]);
    }
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
  return Promise.resolve(
    backend.recvAsync?.(socket, maxBytes) ??
      backend.recv(socket, maxBytes, { nonblocking: false }),
  );
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
  // Registry handles are positive ints; we expose them as negative ints
  // through this backend so they can't collide with bridge-allocated
  // positive handles. Negation is self-inverse, so the same flip works
  // in both directions; the two aliases stay for caller-side intent.
  const isLocal = (h: number) => h < 0;
  const pub = (h: number) => -h;
  const reg = pub;

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
      if (r.ok) {
        return {
          ok: true,
          socket: pub(r.socket),
          peerHost: r.peerHost,
          peerPort: r.peerPort,
          localHost: r.localHost,
          localPort: r.localPort,
        };
      }
      return delegate?.connect(req) ?? { ok: false, error: r.error };
    },

    send(socket, data) {
      if (isLocal(socket)) {
        const r = registry.send(reg(socket), data);
        return r.ok
          ? { ok: true, bytes_sent: r.bytesSent }
          : { ok: false, error: r.error };
      }
      return delegate?.send(socket, data) ??
        { ok: false, error: "send: invalid socket" };
    },

    recv(socket, maxBytes, opts) {
      if (isLocal(socket)) {
        const r = registry.recv(reg(socket), maxBytes, {
          nonblocking: true,
        });
        if (r.ok) return { ok: true, data: r.bytes };
        return { ok: false, error: r.error };
      }
      return delegate?.recv(socket, maxBytes, opts) ??
        { ok: false, error: "recv: invalid socket" };
    },

    async recvAsync(socket, maxBytes) {
      if (isLocal(socket)) {
        const r = await registry.recvAsync(reg(socket), maxBytes);
        return r.ok
          ? { ok: true, data: r.bytes }
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
        const publishedHost = req.host === "0.0.0.0"
          ? "10.0.2.15"
          : (r.host ?? req.host);
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
    async connect(req) {
      const result = await bridge.requestSync({
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
      return {
        ok: true,
        socket: result.socket_id,
        ...(typeof result.peer_host === "string"
          ? { peerHost: result.peer_host }
          : {}),
        ...(typeof result.peer_port === "number"
          ? { peerPort: result.peer_port }
          : {}),
        ...(typeof result.local_host === "string"
          ? { localHost: result.local_host }
          : {}),
        ...(typeof result.local_port === "number"
          ? { localPort: result.local_port }
          : {}),
      };
    },

    async send(socket, data) {
      return socketResult(
        await bridge.requestSync({
          op: "send",
          socket_id: socket,
          data: Array.from(data),
        }),
      );
    },

    async recv(socket, maxBytes, opts) {
      return socketResult(
        await bridge.requestSync({
          op: "recv",
          socket_id: socket,
          max_bytes: maxBytes,
          nonblocking: opts?.nonblocking === true,
        }),
      );
    },

    async setNoDelay(socket, enabled) {
      return socketResult(
        await bridge.requestSync({
          op: "set_no_delay",
          socket_id: socket,
          enabled,
        }),
      );
    },

    async listen(req) {
      const result = await bridge.requestSync({
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

    async accept(listener) {
      return parseAccept(
        await bridge.requestSync({
          op: "accept",
          listener_id: listener,
        }),
      );
    },

    /**
     * The bridge worker serializes requests over the SAB; a long-running
     * accept on the worker side would deadlock against the connect that
     * feeds it. Poll instead, yielding the kernel-side event loop
     * between attempts so other host work can run. This is the
     * transport's only supported async pattern; the host-import handler
     * still sees a single `await acceptAsync`.
     *
     * No artificial deadline: real `accept(2)` blocks until a connection
     * arrives or the listener closes. Process-level timeouts/cancellations
     * are enforced by the kernel's deadline machinery, not here. The
     * polling cadence backs off from 5ms to 100ms so an idle listener
     * doesn't hammer the SAB. Loop terminates when the bridge returns
     * any non-`wouldBlock` result — success, listener-closed, or error.
     */
    async acceptAsync(listener) {
      let delayMs = 5;
      // deno-lint-ignore no-constant-condition
      while (true) {
        const r = parseAccept(
          await bridge.requestSync({
            op: "accept",
            listener_id: listener,
          }),
        );
        if (!(r.ok === false && "wouldBlock" in r && r.wouldBlock === true)) {
          return r;
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (delayMs < 100) delayMs = Math.min(100, delayMs * 2);
      }
    },

    /**
     * Poll the bridge with `nonblocking: true` and back off until bytes
     * arrive, the socket closes, or any non-EAGAIN error is reported.
     * A blocking `requestSync` would park the worker and deadlock any
     * concurrent op on the same SAB queue (see acceptAsync above for the
     * same constraint). Issue #18 tracks the original blocking version.
     */
    async recvAsync(socket, maxBytes) {
      let delayMs = 5;
      // deno-lint-ignore no-constant-condition
      while (true) {
        const r = socketResult(
          await bridge.requestSync({
            op: "recv",
            socket_id: socket,
            max_bytes: maxBytes,
            nonblocking: true,
          }),
        );
        if (r.ok) {
          // EOF (`ok` with no bytes) and any byte payload exit the poll.
          return r;
        }
        if (r.error !== "EAGAIN") return r;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (delayMs < 100) delayMs = Math.min(100, delayMs * 2);
      }
    },

    async closeListener(listener) {
      return socketResult(
        await bridge.requestSync({
          op: "close_listener",
          listener_id: listener,
        }),
      );
    },

    async close(socket) {
      return socketResult(
        await bridge.requestSync({
          op: "close",
          socket_id: socket,
        }),
      );
    },
  };
}
