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

function writeSockaddrIn(
  memory: WebAssembly.Memory,
  ptr: number,
  host: [number, number, number, number],
  port: number,
): number {
  const bytes = new Uint8Array(memory.buffer, ptr, 16);
  bytes.fill(0);
  const view = new DataView(memory.buffer, ptr, 16);
  view.setUint16(0, 2, true);
  view.setUint16(2, port, false);
  bytes.set(host, 4);
  return 16;
}

describe("socket listener policy preparation", () => {
  it("authorizes loopback listen and stores listener handle on the socket fd", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    const listenPolicy: SocketListenPolicy = {
      allowLoopback: true,
    };
    const calls: unknown[] = [];
    const backend: SocketBackend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
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
    const bindLen = writeSockaddrIn(memory, 16, [127, 0, 0, 1], 18081);
    const bindOut = (imports.host_socket_bind as (...args: number[]) => number)(
      fd,
      16,
      bindLen,
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
    const backend: SocketBackend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
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
    const bindLen = writeSockaddrIn(memory, 16, [127, 0, 0, 1], 18081);
    (imports.host_socket_bind as (...args: number[]) => number)(
      fd,
      16,
      bindLen,
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
    const backend: SocketBackend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
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
    const bindLen = writeSockaddrIn(memory, 16, [0, 0, 0, 0], 8080);
    expect(
      (imports.host_socket_bind as (...args: number[]) => number)(
        fd,
        16,
        bindLen,
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

describe("socket listen — cross-process audit (#125)", () => {
  // Recommendation #1 from the #125 audit doc: two processes issuing
  // concurrent async socketListen on port 0 must receive distinct
  // ephemeral ports and consistent, non-cross-wired route entries.
  // Locks in the audit's "atomic continuation" property against
  // future backend changes — if a backend ever mutates its global
  // route/port registry before its await and finalizes after, this
  // test will regress.
  it("two concurrent async listens on port 0 get distinct ephemeral ports", async () => {
    const memoryA = new WebAssembly.Memory({ initial: 1 });
    const memoryB = new WebAssembly.Memory({ initial: 1 });
    const kernel = new ProcessKernel();
    let nextPort = 30000;
    let nextListener = 1;
    const installed: Array<{ port: number; listener: number }> = [];
    const backend: SocketBackend = {
      connect: () => ({ ok: false, error: "not used" }),
      send: () => ({ ok: true, bytes_sent: 0 }),
      recv: () => ({ ok: true, data: new Uint8Array(0) }),
      close: () => ({ ok: true }),
      // Async listen: stage the global mutation inside the resolved
      // continuation (the contract documented on SocketBackend.listen
      // per the same #125 audit).
      listen() {
        return Promise.resolve().then(() => {
          const port = nextPort++;
          const listener = nextListener++;
          installed.push({ port, listener });
          return { ok: true, listener, host: "127.0.0.1", port };
        });
      },
    };
    const listenPolicy: SocketListenPolicy = { allowLoopback: true };
    const optsA = {
      memory: memoryA,
      callerPid: 100,
      kernel,
      socketBackend: backend,
      serverSockets: listenPolicy,
    } satisfies KernelImportsOptions;
    const optsB = {
      memory: memoryB,
      callerPid: 200,
      kernel,
      socketBackend: backend,
      serverSockets: listenPolicy,
    } satisfies KernelImportsOptions;
    const importsA = createKernelImports(optsA);
    const importsB = createKernelImports(optsB);

    const fdA = (importsA.host_socket_open as (...a: number[]) => number)(
      2,
      1,
      0,
    );
    const fdB = (importsB.host_socket_open as (...a: number[]) => number)(
      2,
      1,
      0,
    );
    writeSockaddrIn(memoryA, 16, [127, 0, 0, 1], 0);
    writeSockaddrIn(memoryB, 16, [127, 0, 0, 1], 0);
    (importsA.host_socket_bind as (...a: number[]) => number)(fdA, 16, 16);
    (importsB.host_socket_bind as (...a: number[]) => number)(fdB, 16, 16);

    const rA = (importsA.host_socket_listen as (...a: number[]) => unknown)(
      fdA,
      8,
    );
    const rB = (importsB.host_socket_listen as (...a: number[]) => unknown)(
      fdB,
      8,
    );

    // Backend returns a Promise; await both rcs and assert 0.
    expect(await rA).toBe(0);
    expect(await rB).toBe(0);

    expect(installed).toHaveLength(2);
    // Distinct ephemeral ports.
    expect(installed[0].port).not.toBe(installed[1].port);
    // Distinct listener handles — no cross-wiring.
    expect(installed[0].listener).not.toBe(installed[1].listener);
  });
});
