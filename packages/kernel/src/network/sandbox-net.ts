/**
 * SandboxNet — host-page-facing API over a {@link ListenerRegistry}.
 *
 * Embedded in the Sandbox object as `sandbox.net`. The browser harness
 * (sibling repo) uses this surface to:
 *   - enumerate sandbox-bound listeners (so a Service Worker can decide
 *     whether to intercept a given http://127.0.0.1:<port>/ request),
 *   - observe listener lifecycle (mirror it into the SW's URL map),
 *   - open a duplex byte stream from the host page into a sandbox
 *     server, exactly as if the page had opened a TCP socket.
 *
 * Everything HTTP/WebSocket-shaped is the harness's concern. SandboxNet
 * only carries bytes.
 */

import type {
  ListenerInfo,
  ListenerRegistry,
  SocketHandle,
} from "./listener-registry.js";

export class HostSocket {
  constructor(
    private readonly registry: ListenerRegistry,
    /** Registry-internal positive socket handle. */
    private readonly handle: SocketHandle,
  ) {}

  send(bytes: Uint8Array): number {
    const r = this.registry.send(this.handle, bytes);
    if (!r.ok) throw new Error(r.error);
    return r.bytesSent;
  }

  /** Suspend until at least one byte (or EOF) is available. Empty
   *  Uint8Array means the sandbox-side peer closed cleanly. */
  async recv(maxBytes: number = 65536): Promise<Uint8Array> {
    const r = await this.registry.recvAsync(this.handle, maxBytes);
    if (!r.ok) throw new Error(r.error);
    return r.bytes;
  }

  close(): void {
    this.registry.closeSocket(this.handle);
  }

  get addrInfo(): {
    peerHost: string;
    peerPort: number;
    localHost: string;
    localPort: number;
  } | null {
    return this.registry.socketAddrInfo(this.handle);
  }
}

export class SandboxNet {
  constructor(private readonly registry: ListenerRegistry) {}

  /** Snapshot of currently-bound listeners. */
  listListeners(): ListenerInfo[] {
    return this.registry.listListeners();
  }

  /** Subscribe to listener lifecycle. Returns an unsubscribe function. */
  on(
    event: "listen" | "unlisten",
    cb: (info: ListenerInfo) => void,
  ): () => void {
    return this.registry.on(event, cb);
  }

  /**
   * Open a duplex byte stream from the host page to a sandbox-bound
   * listener. Throws if no listener is bound on host:port.
   */
  connect(req: { host: string; port: number }): HostSocket {
    const r = this.registry.connectFromHost(req);
    if (!r.ok) throw new Error(r.error);
    return new HostSocket(this.registry, r.socket);
  }
}
