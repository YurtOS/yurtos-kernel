import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createKernelImports } from "../kernel-imports.js";
import { ProcessKernel } from "../../process/kernel.js";
import type {
  SocketBackend,
  SocketHandle,
} from "../../network/socket-backend.js";
import { WASI_FDFLAGS_NONBLOCK } from "../../wasi/types.js";

function writeString(
  memory: WebAssembly.Memory,
  ptr: number,
  value: string,
): number {
  const bytes = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function writeBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  value: string,
): number {
  const bytes = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

function readBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
): Uint8Array {
  return new Uint8Array(memory.buffer, ptr, len).slice();
}

function readSocketAddr(memory: WebAssembly.Memory, ptr: number, len: number) {
  const view = new DataView(memory.buffer, ptr, len);
  return {
    port: view.getUint16(0, true),
    host: new TextDecoder().decode(readBytes(memory, ptr + 2, len - 2)),
  };
}

describe("socket fd host imports", () => {
  it("connects using direct address bytes and closes the allocated fd", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const requests: Record<string, unknown>[] = [];
    const handle: SocketHandle = 77;
    const backend: SocketBackend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return {
          ok: true,
          socket: handle,
          peerHost: req.host,
          peerPort: req.port,
          localHost: "10.0.2.15",
          localPort: 43123,
        };
      },
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data_b64: "" }),
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });

    const len = writeString(memory, 16, "127.0.0.1:9");
    const fd = (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      len,
      0,
    );

    expect(fd).toBeGreaterThanOrEqual(3);
    expect(requests[0]).toEqual({
      op: "connect",
      host: "127.0.0.1",
      port: 9,
      tls: false,
    });
    expect(kernel.getFdTarget(0, fd)).toMatchObject({
      type: "socket",
      socket: handle,
    });
    expect((imports.host_socket_close as (...args: number[]) => number)(fd))
      .toBe(0);
    expect(requests.at(-1)).toEqual({ op: "close", socket: handle });
    expect(kernel.getFdTarget(0, fd)).toBeNull();
  });

  it("sends and receives raw guest bytes through direct imports", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const sent: string[] = [];
    const backend: SocketBackend = {
      connect: () => ({ ok: true, socket: 88 }),
      send(_socket, dataB64) {
        sent.push(atob(dataB64));
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv() {
        return { ok: true, data_b64: btoa("pong") };
      },
      close: () => ({ ok: true }),
      recvAsync(socket, maxBytes) {
        return Promise.resolve(this.recv(socket, maxBytes));
      },
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });
    const addrLen = writeString(memory, 16, "127.0.0.1:9");
    const fd = (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      addrLen,
      0,
    );
    const pingLen = writeBytes(memory, 64, "ping");

    expect(
      (imports.host_socket_send as (...args: number[]) => number)(
        fd,
        64,
        pingLen,
        0,
      ),
    ).toBe(4);
    expect(sent).toEqual(["ping"]);

    const recvLen = await (imports.host_socket_recv as (
      ...args: number[]
    ) => number | Promise<number>)(fd, 128, 16, 0);
    expect(recvLen).toBe(4);
    expect(new TextDecoder().decode(readBytes(memory, 128, recvLen))).toBe(
      "pong",
    );
  });

  it("forwards TCP_NODELAY changes to the socket backend", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const calls: Array<{ socket: SocketHandle; enabled: boolean }> = [];
    const backend: SocketBackend = {
      connect: () => ({ ok: true, socket: 77 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data_b64: "" }),
      setNoDelay(socket, enabled) {
        calls.push({ socket, enabled });
        return { ok: true };
      },
      close: () => ({ ok: true }),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });
    const addrLen = writeString(memory, 16, "127.0.0.1:9");
    const fd = (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      addrLen,
      0,
    );

    expect(
      (imports.host_socket_set_no_delay as (...args: number[]) => number)(
        fd,
        1,
      ),
    ).toBe(0);
    expect(
      (imports.host_socket_set_no_delay as (...args: number[]) => number)(
        fd,
        0,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      { socket: 77, enabled: true },
      { socket: 77, enabled: false },
    ]);
  });

  it("reports local address as u16 port plus UTF-8 host bytes", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const backend: SocketBackend = {
      connect: () => ({
        ok: true,
        socket: 99,
        localHost: "10.0.2.15",
        localPort: 45678,
      }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });
    const addrLen = writeString(memory, 16, "127.0.0.1:9");
    const fd = (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      addrLen,
      0,
    );
    const outLen = (imports.host_socket_addr as (...args: number[]) => number)(
      fd,
      256,
      64,
    );

    expect(readSocketAddr(memory, 256, outLen)).toEqual({
      host: "10.0.2.15",
      port: 45678,
    });
  });

  it("preserves peeked socket data for the next direct recv", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let calls = 0;
    const backend: SocketBackend = {
      connect: () => ({ ok: true, socket: 100 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv() {
        calls += 1;
        return { ok: true, data_b64: btoa("abc") };
      },
      close: () => ({ ok: true }),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });
    const addrLen = writeString(memory, 16, "127.0.0.1:9");
    const fd = (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      addrLen,
      0,
    );

    const peekLen = await (imports.host_socket_recv as (
      ...args: number[]
    ) => number | Promise<number>)(fd, 128, 8, 0x02);
    const recvLen = await (imports.host_socket_recv as (
      ...args: number[]
    ) => number | Promise<number>)(fd, 160, 8, 0);

    expect(peekLen).toBe(3);
    expect(recvLen).toBe(3);
    expect(new TextDecoder().decode(readBytes(memory, 128, 3))).toBe("abc");
    expect(new TextDecoder().decode(readBytes(memory, 160, 3))).toBe("abc");
    expect(calls).toBe(1);
  });

  it("returns EAGAIN for nonblocking direct recv without buffered data", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const backend: SocketBackend = {
      connect: () => ({ ok: true, socket: 101 }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: false, error: "EAGAIN" }),
      close: () => ({ ok: true }),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
    });
    const addrLen = writeString(memory, 16, "127.0.0.1:9");
    const fd = (imports.host_socket_connect as (...args: number[]) => number)(
      16,
      addrLen,
      0,
    );
    kernel.setFdDescriptorFlags(0, fd, WASI_FDFLAGS_NONBLOCK);

    expect(
      (imports.host_socket_recv as (...args: number[]) => number)(
        fd,
        128,
        8,
        0,
      ),
    ).toBe(-11);
  });
});
