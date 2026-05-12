import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createKernelImports,
  type KernelImportsOptions,
} from "../kernel-imports.js";
import { ProcessKernel } from "../../process/kernel.js";
import type { SandboxOptions } from "../../sandbox.js";
import type {
  SocketBackend,
  SocketListenPolicy,
} from "../../network/socket-backend.js";

function writeString(
  memory: WebAssembly.Memory,
  ptr: number,
  value: string,
): number {
  const bytes = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

describe("socket listener policy preparation", () => {
  it("authorizes loopback listen and stores listener handle on the socket fd", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const listenPolicy: SocketListenPolicy = {
      allowLoopback: true,
    };
    const calls: unknown[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      listen(req) {
        calls.push(req);
        return {
          ok: true,
          listener: 9001,
          host: "127.0.0.1",
          port: req.port,
        };
      },
      accept: () => ({ ok: false, error: "not used" }),
      closeListener: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const sandboxOptions = {
      wasmDir: "/tmp/wasm",
      serverSockets: listenPolicy,
    } satisfies SandboxOptions;
    expect(sandboxOptions.serverSockets).toBe(listenPolicy);
    const kernelOptions = {
      memory,
      kernel,
      socketBackend: backend,
      serverSockets: listenPolicy,
    } satisfies KernelImportsOptions;
    const imports = createKernelImports(kernelOptions);
    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const bindLen = writeString(memory, 16, "127.0.0.1");
    const bindOut = (imports.host_socket_bind as (...args: number[]) => number)(
      fd,
      16,
      bindLen,
      18081,
    );
    expect(bindOut).toBe(0);

    const listenOut =
      (imports.host_socket_listen as (...args: number[]) => number)(
        fd,
        8,
      );

    expect(listenOut).toBe(0);
    expect(calls).toEqual([{
      host: "127.0.0.1",
      port: 18081,
      backlog: 8,
    }]);
    expect(kernel.getFdTarget(0, fd)).toMatchObject({
      type: "socket",
      listener: 9001,
      boundHost: "127.0.0.1",
      boundPort: 18081,
    });
  });

  it("rejects loopback listen when allowLoopback is not enabled", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      listen: () => {
        throw new Error("policy denial must happen before backend.listen");
      },
      accept: () => ({ ok: false, error: "not used" }),
      closeListener: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
      serverSockets: { allowLoopback: false },
    });
    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const bindLen = writeString(memory, 16, "127.0.0.1");
    (imports.host_socket_bind as (...args: number[]) => number)(
      fd,
      16,
      bindLen,
      18081,
    );

    const out = (imports.host_socket_listen as (...args: number[]) => number)(
      fd,
      8,
    );

    expect(out).toBe(-13);
  });

  it("allows mapped 0.0.0.0 listen only for configured mapped ports", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const calls: unknown[] = [];
    let backend: SocketBackend;
    backend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data_b64: "" }),
      close: () => ({ ok: true }),
      listen(req) {
        calls.push(req);
        return { ok: true, listener: 44, host: "127.0.0.1", port: 19081 };
      },
      accept: () => ({ ok: false, error: "not used" }),
      closeListener: () => ({ ok: true }),
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(backend.recv(socket, maxBytes)),
    };
    const imports = createKernelImports({
      memory,
      kernel,
      socketBackend: backend,
      serverSockets: {
        allowLoopback: false,
        portMappings: [{
          sandboxHost: "0.0.0.0",
          sandboxPort: 8080,
          hostPort: 19081,
        }],
        onListen: (req) => req.port === 8080,
      },
    });
    const fd = (imports.host_socket_open as (...args: number[]) => number)(
      2,
      1,
      0,
    );
    const bindLen = writeString(memory, 16, "0.0.0.0");
    expect(
      (imports.host_socket_bind as (...args: number[]) => number)(
        fd,
        16,
        bindLen,
        8080,
      ),
    ).toBe(0);

    const out = (imports.host_socket_listen as (...args: number[]) => number)(
      fd,
      8,
    );

    expect(out).toBe(0);
    expect(calls).toEqual([{
      host: "0.0.0.0",
      port: 8080,
      backlog: 8,
      mapping: { sandboxHost: "0.0.0.0", sandboxPort: 8080, hostPort: 19081 },
    }]);
  });
});
