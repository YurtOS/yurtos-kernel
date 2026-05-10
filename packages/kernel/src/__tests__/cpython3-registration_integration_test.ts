import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";
import type { SocketBackend, SocketHandle } from "../network/socket-backend.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const CPYTHON_WASM = resolve(WASM_DIR, "cpython3.wasm");

const maybeDescribe = existsSync(CPYTHON_WASM) ? describe : describe.skip;

// yurt's shell currently rejects the `VAR=val cmd` env-prefix form
// with EINVAL when spawning, so cpython3 is always invoked bare.
// The interpreter finds its stdlib via the default --prefix=/usr/local
// baked in at configure time — no PYTHONHOME/PYTHONPATH needed.
function cpythonCommand(args: string): string {
  return `cpython3 ${args}`;
}

maybeDescribe("CPython bring-up registration", () => {
  it("registers cpython3 as a temporary command without replacing python3", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      const cpython = sandbox.stat("/usr/bin/cpython3");
      expect(cpython.type).toBe("file");
      expect(cpython.permissions & 0o100).not.toBe(0);

      const python = sandbox.stat("/usr/bin/python3");
      expect(python.type).toBe("file");

      const cpythonBytes = sandbox.readFile("/usr/bin/cpython3");
      const pythonBytes = sandbox.readFile("/usr/bin/python3");
      expect(cpythonBytes.length).not.toBe(pythonBytes.length);
    } finally {
      sandbox.destroy();
    }
  });

  it("runs cpython3 through the sandbox process path", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      const result = await sandbox.run(cpythonCommand("--version"));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("Python 3.14.4");
    } finally {
      sandbox.destroy();
    }
  });

  it("executes inline Python code with cpython3 -c", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      const result = await sandbox.run(cpythonCommand('-c "print(1 + 2)"'));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("3");
    } finally {
      sandbox.destroy();
    }
  });

  it("reads and writes Yurt VFS files through CPython file APIs", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      sandbox.writeFile("/tmp/input.txt", new TextEncoder().encode("21"));

      const code = [
        'value = int(open("/tmp/input.txt").read())',
        'open("/tmp/output.txt", "w").write(str(value * 2))',
        'print(open("/tmp/output.txt").read())',
      ].join("; ");
      const result = await sandbox.run(cpythonCommand(`-c '${code}'`));

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("42");
      expect(new TextDecoder().decode(sandbox.readFile("/tmp/output.txt")))
        .toBe("42");
    } finally {
      sandbox.destroy();
    }
  });

  it("routes CPython socket operations through the Yurt socket backend", async () => {
    const handle: SocketHandle = 101;
    const requests: Record<string, unknown>[] = [];
    let socketBackend: SocketBackend;
    socketBackend = {
      connect(req) {
        requests.push({ op: "connect", ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: "send", socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: 4 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: "recv", socket, max_bytes: maxBytes });
        return { ok: true, data_b64: btoa("pong") };
      },
      close(socket) {
        requests.push({ op: "close", socket });
        return { ok: true };
      },
      acceptAsync: () => Promise.resolve({ ok: false, error: "not used" }),
      recvAsync: (socket, maxBytes) =>
        Promise.resolve(socketBackend.recv(socket, maxBytes)),
    };
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      socketBackend,
    });
    try {
      const code = [
        "import socket",
        's = socket.create_connection(("example.test", 80))',
        's.sendall(b"ping")',
        "print(s.recv(4).decode())",
        "s.close()",
      ].join("; ");
      const result = await sandbox.run(cpythonCommand(`-c '${code}'`));

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("pong");
      expect(requests).toEqual([
        { op: "connect", host: "example.test", port: 80, tls: false },
        { op: "send", socket: handle, data_b64: "cGluZw==" },
        { op: "recv", socket: handle, max_bytes: 4 },
        { op: "close", socket: handle },
      ]);
    } finally {
      sandbox.destroy();
    }
  });
});
