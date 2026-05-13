import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createKernelImports } from "../kernel-imports.js";
import { ProcessKernel } from "../../process/kernel.js";
import type {
  SocketBackend,
  SocketHandle,
} from "../../network/socket-backend.js";
import { WasiHost } from "../../wasi/wasi-host.js";
import {
  WASI_EAGAIN,
  WASI_ESUCCESS,
  WASI_FDFLAGS_NONBLOCK,
} from "../../wasi/types.js";
import { VFS } from "../../vfs/vfs.js";

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function writeString(
  memory: WebAssembly.Memory,
  ptr: number,
  value: string,
): number {
  const bytes = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readJson(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): unknown {
  return JSON.parse(
    new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)),
  );
}

function readSocketAddr(memory: WebAssembly.Memory, ptr: number) {
  const view = new DataView(memory.buffer, ptr, 8);
  const bytes = new Uint8Array(memory.buffer, ptr, 4);
  return {
    host: [...bytes].join("."),
    port: view.getUint16(4, false),
    reserved: view.getUint16(6, true),
  };
}

function readStringAt(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): string {
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

describe("socket fd host imports", () => {
  it("connects, sends, receives, and reports addresses through native socket imports", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    const handle: SocketHandle = 77;
    let backend: SocketBackend;
    backend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return {
          ok: true,
          socket: handle,
          peerHost: "127.0.0.1",
          peerPort: req.port,
          localHost: "10.0.2.15",
          localPort: 50123,
        };
      },
      send(socket, data) {
        requests.push({ op: "send", socket, data: [...data] });
        return { ok: true, bytes_sent: 4 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data: new TextEncoder().encode("pong") };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const hostLen = writeString(memory, 16, "127.0.0.1");
    expect(
      (imports.host_socket_connect as (...args: number[]) => number)(
        fd,
        16,
        hostLen,
        9,
        0,
      ),
    ).toBe(0);

    writeString(memory, 64, "ping");
    expect(
      (imports.host_socket_send as (...args: number[]) => number)(
        fd,
        64,
        4,
        0,
      ),
    ).toBe(4);

    const recvLen = await (imports.host_socket_recv as (
      ...args: number[]
    ) => number | Promise<number>)(fd, 96, 8, 0);
    expect(recvLen).toBe(4);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, 96, recvLen)),
    ).toBe("pong");

    expect(
      (imports.host_socket_addr as (...args: number[]) => number)(
        fd,
        1,
        128,
        8,
      ),
    ).toBe(8);
    expect(readSocketAddr(memory, 128)).toEqual({
      host: "127.0.0.1",
      port: 9,
      reserved: 0,
    });
    expect(requests).toContainEqual({
      op: "send",
      socket: handle,
      data: [...new TextEncoder().encode("ping")],
    });
  });

  it("binds, listens, accepts, sets options, and closes through native socket imports", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array() }),
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      listen(req) {
        requests.push({ op: "listen", ...req });
        return {
          ok: true,
          listener: 55,
          host: "127.0.0.1",
          port: 18081,
        };
      },
      accept: () => ({
        ok: true,
        socket: 66,
        peerHost: "127.0.0.1",
        peerPort: 50123,
        localHost: "127.0.0.1",
        localPort: 18081,
      }),
      setNoDelay(socket, enabled) {
        requests.push({ op: "setNoDelay", socket, enabled });
        return { ok: true };
      },
      closeListener: () => ({ ok: true }),
      acceptAsync: (listener) => Promise.resolve(backend.accept!(listener)),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
      serverSockets: { allowLoopback: true },
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const hostLen = writeString(memory, 16, "127.0.0.1");
    expect(
      (imports.host_socket_bind as (...args: number[]) => number)(
        fd,
        16,
        hostLen,
        18081,
      ),
    ).toBe(0);
    expect(
      (imports.host_socket_listen as (...args: number[]) => number)(fd, 8),
    ).toBe(0);

    const acceptedLen = await (imports.host_socket_accept as (
      ...args: number[]
    ) => Promise<number>)(fd, 128, 16);
    expect(acceptedLen).toBe(16);
    const acceptedView = new DataView(memory.buffer, 128, 16);
    const acceptedFd = acceptedView.getInt32(0, true);
    expect(acceptedFd).toBeGreaterThan(2);
    expect(kernel.getFdTarget(0, acceptedFd)).toMatchObject({
      type: "socket",
      socket: 66,
      peerHost: "127.0.0.1",
      peerPort: 50123,
      localHost: "127.0.0.1",
      localPort: 18081,
    });

    expect(
      (imports.host_socket_option as (...args: number[]) => number)(
        acceptedFd,
        1,
        1,
        1,
      ),
    ).toBe(0);
    expect(
      (imports.host_socket_option as (...args: number[]) => number)(
        acceptedFd,
        1,
        0,
        0,
      ),
    ).toBe(1);
    expect(
      (imports.host_socket_close as (...args: number[]) => number)(acceptedFd),
    ).toBe(0);
    expect(requests).toContainEqual({
      op: "listen",
      host: "127.0.0.1",
      port: 18081,
      backlog: 8,
    });
    expect(requests).toContainEqual({
      op: "setNoDelay",
      socket: 66,
      enabled: true,
    });
    expect(requests).toContainEqual({ op: "close", socket: 66 });
  });

  it.ignore("tracks opaque backend handles on kernel fds and closes them through closeFd", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    const handle: SocketHandle = 77;
    let backend: SocketBackend;
    backend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: handle };
      },
      send(socket, data) {
        requests.push({ op: "send", socket, data: Array.from(data) });
        return { ok: true, bytes_sent: 3 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data: new Uint8Array(0) };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const reqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "127.0.0.1",
        port: 9,
        tls: false,
      }),
    );

    const connectLen =
      (imports.host_socket_connect as (...args: number[]) => number)(
        16,
        reqLen,
        256,
        4096,
      );
    expect(readJson(memory, 256, connectLen)).toEqual({ ok: true });
    expect(kernel.getFdTarget(0, fd)).toMatchObject({
      type: "socket",
      socket: handle,
    });

    expect((imports.host_close_fd as (...args: number[]) => number)(fd)).toBe(
      0,
    );
    expect(requests.at(-1)).toEqual({ op: "close", socket: handle });
    expect(kernel.getFdTarget(0, fd)).toBeNull();
  });

  it.ignore("routes WASI fd_read and fd_write for connected socket fds through the backend", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    const handle: SocketHandle = 77;
    let backend: SocketBackend;
    backend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: handle };
      },
      send(socket, data) {
        requests.push({ op: "send", socket, data: Array.from(data) });
        return { ok: true, bytes_sent: 4 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data: encode("pong") };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const reqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "127.0.0.1",
        port: 9,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      reqLen,
      256,
      4096,
    );

    const host = new WasiHost({
      vfs: new VFS(),
      args: ["socket-canary"],
      env: {},
      preopens: { "/": "/" },
      ioFds: kernel.getFdTable(0),
      kernel,
      pid: 0,
    });
    host.setMemory(memory);
    const wasi = host.getImports().wasi_snapshot_preview1;
    const view = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);

    writeString(memory, 512, "ping");
    view.setUint32(32, 512, true);
    view.setUint32(36, 4, true);
    expect(wasi.fd_write(fd, 32, 1, 64)).toBe(WASI_ESUCCESS);
    expect(view.getUint32(64, true)).toBe(4);
    expect(requests.at(-1)).toEqual({
      op: "send",
      socket: handle,
      data: Array.from(encode("ping")),
    });

    view.setUint32(40, 600, true);
    view.setUint32(44, 8, true);
    expect(await wasi.fd_read(fd, 40, 1, 68)).toBe(WASI_ESUCCESS);
    expect(view.getUint32(68, true)).toBe(4);
    expect(new TextDecoder().decode(bytes.subarray(600, 604))).toBe("pong");
    expect(requests.at(-1)).toEqual({
      op: "recv",
      socket: handle,
      max_bytes: 8,
    });
  });

  it.ignore("reports peer and local socket addresses for connected socket fds", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 88 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );

    const addrReqLen = writeString(memory, 16, JSON.stringify({ fd }));
    const addrLen = (imports.host_socket_addr as (...args: number[]) => number)(
      16,
      addrReqLen,
      512,
      4096,
    );

    const addr = readJson(memory, 512, addrLen) as Record<string, unknown>;
    expect(addr).toMatchObject({
      ok: true,
      peer_host: "example.test",
      peer_port: 443,
      local_host: "10.0.2.15",
    });
    expect(typeof addr.local_port).toBe("number");
    expect(addr.local_port as number).toBeGreaterThanOrEqual(49152);
  });

  it.ignore("uses backend-reported addresses for connected socket fds", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let backend: SocketBackend;
    backend = {
      connect: () => ({
        ok: true,
        socket: 77,
        peerHost: "10.0.2.15",
        peerPort: 8080,
        localHost: "127.0.0.1",
        localPort: 50321,
      }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );

    const addrReqLen = writeString(memory, 16, JSON.stringify({ fd }));
    const addrLen = (imports.host_socket_addr as (...args: number[]) => number)(
      16,
      addrReqLen,
      512,
      4096,
    );
    expect(readJson(memory, 512, addrLen)).toEqual({
      ok: true,
      peer_host: "10.0.2.15",
      peer_port: 8080,
      local_host: "127.0.0.1",
      local_port: 50321,
    });
  });

  it.ignore("applies and reports TCP_NODELAY through connected socket fds", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 99 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      setNoDelay(socket, enabled) {
        requests.push({ op: "setNoDelay", socket, enabled });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );

    const setReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        option: "no_delay",
        value: true,
      }),
    );
    const setLen =
      (imports.host_socket_option as (...args: number[]) => number)(
        16,
        setReqLen,
        512,
        4096,
      );
    expect(readJson(memory, 512, setLen)).toEqual({ ok: true });
    expect(requests).toContainEqual({
      op: "setNoDelay",
      socket: 99,
      enabled: true,
    });

    const getReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        option: "no_delay",
      }),
    );
    const getLen =
      (imports.host_socket_option as (...args: number[]) => number)(
        16,
        getReqLen,
        512,
        4096,
      );
    expect(readJson(memory, 512, getLen)).toEqual({ ok: true, value: 1 });
  });

  it.ignore("applies pre-connect TCP_NODELAY when the socket connects", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 101 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      setNoDelay(socket, enabled) {
        requests.push({ op: "setNoDelay", socket, enabled });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const setReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        option: "no_delay",
        value: true,
      }),
    );
    const setLen =
      (imports.host_socket_option as (...args: number[]) => number)(
        16,
        setReqLen,
        512,
        4096,
      );
    expect(readJson(memory, 512, setLen)).toEqual({ ok: true });
    expect(requests).toEqual([]);

    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    const connectLen =
      (imports.host_socket_connect as (...args: number[]) => number)(
        16,
        connectReqLen,
        256,
        4096,
      );

    expect(readJson(memory, 256, connectLen)).toEqual({ ok: true });
    expect(requests).toEqual([{
      op: "setNoDelay",
      socket: 101,
      enabled: true,
    }]);
  });

  it.ignore("preserves peeked socket data for the next recv", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 202 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: (socket, maxBytes) => {
        requests.push({ op: "recv", socket, maxBytes });
        return { ok: true, data: encode("abc") };
      },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );

    const peekLen = (imports.host_socket_recv as (...args: number[]) => number)(
      fd,
      512,
      3,
      0x02,
    );
    expect(peekLen).toBe(3);
    expect(readStringAt(memory, 512, peekLen)).toBe("abc");

    const recvLen = (imports.host_socket_recv as (...args: number[]) => number)(
      fd,
      512,
      3,
      0,
    );
    expect(recvLen).toBe(3);
    expect(readStringAt(memory, 512, recvLen)).toBe("abc");
    expect(requests).toEqual([{ op: "recv", socket: 202, maxBytes: 3 }]);
  });

  it.ignore("returns EAGAIN for nonblocking socket fd reads without buffered data", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 303 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: (socket, maxBytes, opts) => {
        requests.push({ op: "recv", socket, maxBytes, opts });
        // Real loopback backend signals EAGAIN when no bytes are buffered.
        return { ok: false, error: "EAGAIN" };
      },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );

    const wasi = new WasiHost({
      vfs: new VFS(),
      args: [],
      env: {},
      preopens: { "/": "/" },
      ioFds: kernel.getFdTable(0),
      kernel,
      pid: 0,
    });
    wasi.setMemory(memory);
    const wasiImports = wasi.getImports().wasi_snapshot_preview1;
    expect(wasiImports.fd_fdstat_set_flags(fd, WASI_FDFLAGS_NONBLOCK)).toBe(
      WASI_ESUCCESS,
    );

    new DataView(memory.buffer).setUint32(128, 256, true);
    new DataView(memory.buffer).setUint32(132, 3, true);

    expect(wasiImports.fd_read(fd, 128, 1, 192)).toBe(WASI_EAGAIN);
    // Backend was polled (with the nonblocking flag) and signaled EAGAIN.
    expect(requests).toEqual([{
      op: "recv",
      socket: 303,
      maxBytes: 3,
      opts: { nonblocking: true },
    }]);
  });

  it.ignore("returns EAGAIN for nonblocking host_socket_recv without buffered data", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 404 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: (socket, maxBytes, opts) => {
        requests.push({ op: "recv", socket, maxBytes, opts });
        return { ok: false, error: "EAGAIN" };
      },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );
    const target = kernel.getFdTarget(0, fd);
    expect(target?.type).toBe("socket");
    if (!target || target.type !== "socket") {
      throw new Error("expected socket fd target");
    }
    target.fdFlags = WASI_FDFLAGS_NONBLOCK;

    const recvLen = (imports.host_socket_recv as (...args: number[]) => number)(
      fd,
      512,
      3,
      0,
    );

    expect(recvLen).toBe(-11);
    expect(requests).toEqual([{
      op: "recv",
      socket: 404,
      maxBytes: 3,
      opts: { nonblocking: true },
    }]);
  });

  it.ignore("preserves nonblocking host_socket_recv peeked bytes", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: true, socket: 505 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: (socket, maxBytes) => {
        requests.push({ op: "recv", socket, maxBytes });
        return { ok: true, data: encode("abc") };
      },
      close: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const connectReqLen = writeString(
      memory,
      16,
      JSON.stringify({
        fd,
        host: "example.test",
        port: 443,
        tls: false,
      }),
    );
    (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      connectReqLen,
      256,
      4096,
    );
    const target = kernel.getFdTarget(0, fd);
    expect(target?.type).toBe("socket");
    if (!target || target.type !== "socket") {
      throw new Error("expected socket fd target");
    }
    target.fdFlags = WASI_FDFLAGS_NONBLOCK;

    const peekLen = (imports.host_socket_recv as (...args: number[]) => number)(
      fd,
      512,
      3,
      0x02,
    );
    expect(peekLen).toBe(3);
    expect(readStringAt(memory, 512, peekLen)).toBe("abc");

    const recvLen = (imports.host_socket_recv as (...args: number[]) => number)(
      fd,
      512,
      3,
      0,
    );
    expect(recvLen).toBe(3);
    expect(readStringAt(memory, 512, recvLen)).toBe("abc");
    expect(requests).toEqual([{ op: "recv", socket: 505, maxBytes: 3 }]);
  });

  it.ignore("accepts a listener connection and allocates a connected socket fd", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      listen: () => ({
        ok: true,
        listener: 55,
        host: "127.0.0.1",
        port: 18081,
      }),
      accept: () => ({
        ok: true,
        socket: 66,
        peerHost: "127.0.0.1",
        peerPort: 50123,
        localHost: "127.0.0.1",
        localPort: 18081,
      }),
      closeListener: () => ({ ok: true }),
      acceptAsync: (listener) => Promise.resolve(backend.accept!(listener)),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
      serverSockets: { allowLoopback: true },
    });
    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const bindLen = writeString(
      memory,
      16,
      JSON.stringify({ fd, host: "127.0.0.1", port: 18081 }),
    );
    (imports.host_socket_bind as (...args: number[]) => number)(
      16,
      bindLen,
      256,
      4096,
    );
    const listenLen = writeString(
      memory,
      16,
      JSON.stringify({ fd, backlog: 8 }),
    );
    (imports.host_socket_listen as (...args: number[]) => number)(
      16,
      listenLen,
      256,
      4096,
    );

    const acceptLen = writeString(memory, 16, JSON.stringify({ fd }));
    const out = await (imports.host_socket_accept as (
      ...args: number[]
    ) => Promise<number>)(16, acceptLen, 256, 4096);
    const accepted = readJson(memory, 256, out) as { ok: true; fd: number };

    expect(accepted.ok).toBe(true);
    expect(typeof accepted.fd).toBe("number");
    expect(kernel.getFdTarget(0, accepted.fd)).toMatchObject({
      type: "socket",
      socket: 66,
      peerHost: "127.0.0.1",
      peerPort: 50123,
      localHost: "127.0.0.1",
      localPort: 18081,
    });
  });

  it("reports listener local address but rejects peer address", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      listen: () => ({
        ok: true,
        listener: 55,
        host: "127.0.0.1",
        port: 51234,
      }),
      accept: () => ({ ok: false, error: "not used" }),
      closeListener: () => ({ ok: true }),
      acceptAsync: (listener) => Promise.resolve(backend.accept!(listener)),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
      serverSockets: { allowLoopback: true },
    });

    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const hostLen = writeString(memory, 16, "127.0.0.1");
    (imports.host_socket_bind as (...args: number[]) => number)(
      fd,
      16,
      hostLen,
      0,
    );
    (imports.host_socket_listen as (...args: number[]) => number)(
      fd,
      1,
    );

    const localLen =
      (imports.host_socket_addr as (...args: number[]) => number)(
        fd,
        0,
        512,
        8,
      );
    expect(localLen).toBe(8);
    expect(readSocketAddr(memory, 512)).toEqual({
      host: "127.0.0.1",
      port: 51234,
      reserved: 0,
    });

    const peerLen = (imports.host_socket_addr as (...args: number[]) => number)(
      fd,
      1,
      512,
      8,
    );
    expect(peerLen).toBe(-107);
  });
});
