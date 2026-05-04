import type { NetworkBridgeLike } from './bridge.js';

export type SocketHandle = number;
export type SocketListenerHandle = number;

export interface SocketPortMapping {
  sandboxHost: '0.0.0.0';
  sandboxPort: number;
  hostPort: number;
}

export interface SocketListenRequest {
  host: '127.0.0.1' | 'localhost' | '0.0.0.0';
  port: number;
  backlog: number;
  mapping?: SocketPortMapping;
}

export interface SocketListenBackendRequest {
  host: '127.0.0.1' | 'localhost' | '0.0.0.0';
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
  | { ok: false; wouldBlock: true; error: 'accept would block' }
  | { ok: false; error: string };

export interface SocketBackend {
  connect(req: { host: string; port: number; tls: boolean }): { ok: true; socket: SocketHandle } | { ok: false; error: string };
  send(socket: SocketHandle, dataB64: string): SocketBackendResult;
  recv(socket: SocketHandle, maxBytes: number, opts?: { nonblocking?: boolean }): SocketBackendResult;
  setNoDelay?(socket: SocketHandle, enabled: boolean): SocketBackendResult;
  listen?(req: SocketListenBackendRequest): SocketListenBackendResult;
  /** Polls for one accepted socket. Must not block the bridge request loop. */
  accept?(listener: SocketListenerHandle): SocketAcceptBackendResult;
  closeListener?(listener: SocketListenerHandle): SocketBackendResult;
  close(socket: SocketHandle): SocketBackendResult;
}

interface LoopbackSocket {
  peer: SocketHandle;
  rx: Uint8Array[];
  peerHost: string;
  peerPort: number;
  localHost: string;
  localPort: number;
}

interface LoopbackListener {
  host: '127.0.0.1' | 'localhost' | '0.0.0.0';
  port: number;
  pending: SocketAcceptBackendResult[];
}

function socketResult(result: { ok: boolean; [key: string]: unknown }): SocketBackendResult {
  if (result.ok) {
    const ok: { ok: true; data?: string; bytes_sent?: number; data_b64?: string } = { ok: true };
    if (typeof result.data === 'string') ok.data = result.data;
    if (typeof result.data_b64 === 'string') ok.data_b64 = result.data_b64;
    if (typeof result.bytes_sent === 'number') ok.bytes_sent = result.bytes_sent;
    return ok;
  }
  return {
    ok: false,
    error: typeof result.error === 'string' ? result.error : 'socket operation failed',
  };
}

export function createLoopbackSocketBackend(delegate?: SocketBackend): SocketBackend {
  const sockets = new Map<SocketHandle, LoopbackSocket>();
  const listeners = new Map<SocketListenerHandle, LoopbackListener>();
  const routes = new Map<string, SocketListenerHandle>();
  let nextSocket = -1;
  let nextListener = -1;
  let nextEphemeralPort = 49152;

  function routeKey(host: string, port: number): string {
    const normalized = host === 'localhost' ? '127.0.0.1' : host;
    return `${normalized}:${port}`;
  }

  function bytesToBase64(data: Uint8Array): string {
    let binary = '';
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  return {
    connect(req) {
      const listenerId = routes.get(routeKey(req.host, req.port));
      const listener = listenerId !== undefined ? listeners.get(listenerId) : undefined;
      if (!listener) {
        return delegate?.connect(req) ?? { ok: false, error: 'socket connect failed' };
      }

      const client = nextSocket--;
      const server = nextSocket--;
      const clientPort = nextEphemeralPort++;
      sockets.set(client, {
        peer: server,
        rx: [],
        peerHost: listener.host === '0.0.0.0' ? '10.0.2.15' : '127.0.0.1',
        peerPort: listener.port,
        localHost: '127.0.0.1',
        localPort: clientPort,
      });
      sockets.set(server, {
        peer: client,
        rx: [],
        peerHost: '127.0.0.1',
        peerPort: clientPort,
        localHost: listener.host === '0.0.0.0' ? '10.0.2.15' : '127.0.0.1',
        localPort: listener.port,
      });
      listener.pending.push({
        ok: true,
        socket: server,
        peerHost: '127.0.0.1',
        peerPort: clientPort,
        localHost: listener.host === '0.0.0.0' ? '10.0.2.15' : '127.0.0.1',
        localPort: listener.port,
      });
      return { ok: true, socket: client };
    },

    send(socket, dataB64) {
      const local = sockets.get(socket);
      if (!local) return delegate?.send(socket, dataB64) ?? { ok: false, error: 'send: invalid socket' };
      const peer = sockets.get(local.peer);
      if (!peer) return { ok: false, error: 'send: disconnected socket' };
      const data = base64ToBytes(dataB64);
      peer.rx.push(data);
      return { ok: true, bytes_sent: data.byteLength };
    },

    recv(socket, maxBytes, opts) {
      const local = sockets.get(socket);
      if (!local) return delegate?.recv(socket, maxBytes, opts) ?? { ok: false, error: 'recv: invalid socket' };
      const first = local.rx.shift();
      if (!first) {
        return opts?.nonblocking === true
          ? { ok: false, error: 'EAGAIN' }
          : { ok: true, data_b64: '' };
      }
      if (first.byteLength <= maxBytes) {
        return { ok: true, data_b64: bytesToBase64(first) };
      }
      local.rx.unshift(first.subarray(maxBytes));
      return { ok: true, data_b64: bytesToBase64(first.subarray(0, maxBytes)) };
    },

    setNoDelay(socket, enabled) {
      if (sockets.has(socket)) return { ok: true };
      return delegate?.setNoDelay?.(socket, enabled) ?? { ok: true };
    },

    listen(req) {
      const listener = nextListener--;
      const port = req.port === 0 ? nextEphemeralPort++ : req.port;
      listeners.set(listener, {
        host: req.host,
        port,
        pending: [],
      });
      routes.set(routeKey(req.host, port), listener);
      if (req.host === 'localhost') routes.set(routeKey('127.0.0.1', port), listener);
      if (req.host === '127.0.0.1') routes.set(routeKey('localhost', port), listener);
      return { ok: true, listener, host: req.host === '0.0.0.0' ? '10.0.2.15' : req.host, port };
    },

    accept(listener) {
      const state = listeners.get(listener);
      if (!state) return delegate?.accept?.(listener) ?? { ok: false, error: 'accept: invalid listener' };
      const accepted = state.pending.shift();
      return accepted ?? { ok: false, wouldBlock: true, error: 'accept would block' };
    },

    closeListener(listener) {
      if (!listeners.has(listener)) {
        return delegate?.closeListener?.(listener) ?? { ok: false, error: 'close_listener: invalid listener' };
      }
      listeners.delete(listener);
      for (const [key, value] of routes.entries()) {
        if (value === listener) routes.delete(key);
      }
      return { ok: true };
    },

    close(socket) {
      const local = sockets.get(socket);
      if (!local) return delegate?.close(socket) ?? { ok: true };
      sockets.delete(socket);
      const peer = sockets.get(local.peer);
      if (peer) peer.peer = 0;
      return { ok: true };
    },
  };
}

export function createNetworkBridgeSocketBackend(bridge: NetworkBridgeLike): SocketBackend {
  return {
    connect(req) {
      const result = bridge.requestSync({
        op: 'connect',
        host: req.host,
        port: req.port,
        tls: req.tls,
      });
      if (!result.ok || typeof result.socket_id !== 'number') {
        return {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'socket connect failed',
        };
      }
      return { ok: true, socket: result.socket_id };
    },

    send(socket, dataB64) {
      return socketResult(bridge.requestSync({
        op: 'send',
        socket_id: socket,
        data_b64: dataB64,
      }));
    },

    recv(socket, maxBytes, opts) {
      return socketResult(bridge.requestSync({
        op: 'recv',
        socket_id: socket,
        max_bytes: maxBytes,
        nonblocking: opts?.nonblocking === true,
      }));
    },

    setNoDelay(socket, enabled) {
      return socketResult(bridge.requestSync({
        op: 'set_no_delay',
        socket_id: socket,
        enabled,
      }));
    },

    listen(req) {
      const result = bridge.requestSync({
        op: 'listen',
        host: req.host,
        port: req.port,
        backlog: req.backlog,
        mapping: req.mapping,
      });
      if (!result.ok || typeof result.listener_id !== 'number') {
        return {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'socket listen failed',
        };
      }
      return {
        ok: true,
        listener: result.listener_id,
        host: typeof result.host === 'string' ? result.host : req.host,
        port: typeof result.port === 'number' ? result.port : req.port,
      };
    },

    accept(listener) {
      const result = bridge.requestSync({ op: 'accept', listener_id: listener });
      if (!result.ok && result.would_block === true) {
        return { ok: false, wouldBlock: true, error: 'accept would block' };
      }
      if (!result.ok || typeof result.socket_id !== 'number') {
        return {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'socket accept failed',
        };
      }
      return {
        ok: true,
        socket: result.socket_id,
        peerHost: typeof result.peer_host === 'string' ? result.peer_host : '127.0.0.1',
        peerPort: typeof result.peer_port === 'number' ? result.peer_port : 0,
        localHost: typeof result.local_host === 'string' ? result.local_host : '127.0.0.1',
        localPort: typeof result.local_port === 'number' ? result.local_port : 0,
      };
    },

    closeListener(listener) {
      return socketResult(bridge.requestSync({
        op: 'close_listener',
        listener_id: listener,
      }));
    },

    close(socket) {
      return socketResult(bridge.requestSync({
        op: 'close',
        socket_id: socket,
      }));
    },
  };
}
