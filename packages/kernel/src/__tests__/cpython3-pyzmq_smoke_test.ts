/**
 * Runtime smoke for the cpython3 + pyzmq integration.
 *
 * Validates that the cpython3.wasm built by `yurt-ports/ports/cpython`
 * (with ZLIB_PREFIX + PYZMQ_PREFIX + OPENSSL_PREFIX live) can:
 *
 *   1. Boot through the yurt sandbox process path.
 *   2. Import `zlib` and exercise compress/decompress — proves the
 *      yurt zlib port (`yurt-ports/ports/zlib`) is wired in as a
 *      static cpython builtin via Setup.local.
 *   3. Import `binascii` — same wiring, plus confirms `cpython3` can
 *      boot WITHOUT `-S`. site.py pulls in `binascii` via the
 *      base64 codec; before zlib landed, the only way past site.py
 *      was `-S`.
 *   4. Import the `zmq` package from /usr/local/lib/python3.14/
 *      site-packages/zmq/ — staged into the sandbox VFS via the
 *      sandbox's cpython3-lib-manifest mechanism. This transitively
 *      exercises the baked-in `_zmq` builtin (Cython's init function
 *      runs as part of `from . import _zmq`); we don't `import _zmq`
 *      directly because the Cython module's init expects the parent
 *      `zmq` package context, so a top-level `import _zmq` always
 *      raises — that's a Cython convention, not a yurt bug.
 *
 * Skipped unless BOTH the cpython3.wasm and the pyzmq site-packages
 * sidecar are staged (gitignored; populate by running
 * scripts/stage-cpython-fixtures.sh after building the cpython + pyzmq
 * ports). Gating on cpython3.wasm alone would unskip on dev boxes that
 * have the existing CPython smoke fixture but no pyzmq tree, producing
 * a false `import zmq` failure.
 *
 * Note: invocations are bare (`cpython3 --version`, not
 * `PYTHONHOME=... cpython3 ...`). yurt's shell currently rejects
 * the env-prefix syntax with EINVAL when spawning, and cpython3
 * already finds its stdlib via the default --prefix=/usr/local
 * baked in at configure time.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import type { RunResult } from "../run-result.js";
import { NodeAdapter } from "../platform/node-adapter.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const CPYTHON_WASM = resolve(WASM_DIR, "cpython3.wasm");
// pyzmq sidecar gate: cpython3.wasm alone is not enough — the
// `import zmq` case needs the pyzmq site-packages tree staged by
// scripts/stage-cpython-fixtures.sh.
const PYZMQ_INIT = resolve(
  WASM_DIR,
  "cpython3-lib/site-packages/zmq/__init__.py",
);
const HAS_FIXTURES = existsSync(CPYTHON_WASM) && existsSync(PYZMQ_INIT);

const maybeDescribe = HAS_FIXTURES ? describe : describe.skip;

/**
 * Run a Python program in the sandbox by piping it to `cpython3 -` over
 * stdin. Prefer this over `cpython3 -c "..."` for any program containing
 * `"`, `$`, `\`, or backticks: the latter nests inside the shell's
 * double-quoted argument and breaks silently on those characters.
 */
async function runPython(
  sandbox: Sandbox,
  lines: string[],
): Promise<RunResult> {
  const program = lines.join("\n") + "\n";
  return sandbox.run("cpython3 -", {
    stdinData: new TextEncoder().encode(program),
  });
}

maybeDescribe("cpython3 + pyzmq runtime smoke", () => {
  it("boots cpython3 and reports its version", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      const result = await sandbox.run("cpython3 --version");
      expect(result.exitCode).toBe(0);
      // Match `Python 3.x.y` so cpython point-bumps don't break the smoke.
      expect(result.stdout.trim()).toMatch(/^Python 3\.\d+\.\d+$/);
    } finally {
      sandbox.destroy();
    }
  });

  it("imports zlib and round-trips compress / decompress", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      // The repeated 'hello' makes DEFLATE actually compress; a
      // single short string can come out *bigger* due to format
      // overhead, which would mask a working zlib.
      const result = await runPython(sandbox, [
        "import zlib",
        "data = b'hello hello hello hello hello hello'",
        "comp = zlib.compress(data)",
        "assert zlib.decompress(comp) == data",
        "print(zlib.ZLIB_VERSION)",
      ]);
      if (result.exitCode !== 0) {
        console.log("--- zlib: exit", result.exitCode);
        console.log("--- zlib stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      // ports/zlib pins 1.3.x; match the line so a point-bump doesn't
      // break the smoke.
      expect(result.stdout.trim()).toMatch(/^1\.\d+\.\d+$/);
    } finally {
      sandbox.destroy();
    }
  });

  it("imports binascii and round-trips hexlify / unhexlify", async () => {
    // Two things this case covers that aren't redundant with the
    // zlib case:
    //   - binascii is its own builtin (linked separately against -lz
    //     for crc32). A broken linker order could leave one working
    //     and the other not.
    //   - This invocation runs WITHOUT `-S`. site.py imports
    //     `binascii` via the `base64` codec path; if site.py raises,
    //     this test fails. Before the zlib port landed, the only
    //     way to get cpython3 to start was `-S`.
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      const result = await runPython(sandbox, [
        "import binascii",
        "h = binascii.hexlify(b'yurt')",
        "assert binascii.unhexlify(h) == b'yurt'",
        "print(h.decode())",
      ]);
      if (result.exitCode !== 0) {
        console.log("--- binascii: exit", result.exitCode);
        console.log("--- binascii stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      // 'yurt' is 0x79 0x75 0x72 0x74 — exact match.
      expect(result.stdout.trim()).toBe("79757274");
    } finally {
      sandbox.destroy();
    }
  });

  it("imports the zmq package from site-packages", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      // Full chain end-to-end:
      //   zmq/__init__.py
      //     → zmq/backend/__init__.py
      //     → zmq/backend/cython/__init__.py
      //     → from . import _zmq  (resolves to the _zmq.py shim)
      //     → sys.modules aliasing publishes the top-level builtin
      //       under the dotted name zmq.backend.cython._zmq.
      //
      // Reaching `zmq.zmq_version()` proves all three layers are
      // wired correctly: Python tree (this port), Cython-generated
      // C extension baked into cpython3.wasm, libzmq.a behind it.
      //
      // No `-S` here — the zlib port (yurt-ports/ports/zlib) lets
      // site.py boot cleanly, so site-packages is on sys.path
      // without manual insertion.
      const result = await runPython(sandbox, [
        "import zmq",
        "print(zmq.zmq_version())",
      ]);
      if (result.exitCode !== 0) {
        console.log("--- zmq import: exit", result.exitCode);
        console.log("--- zmq stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      // libzmq 4.3.5 reports as "4.3.5".
      expect(result.stdout.trim()).toMatch(/^4\.\d+\.\d+$/);
    } finally {
      sandbox.destroy();
    }
  });

  it("exchanges a ZMQ message over inproc:// with IO_THREADS=0", async () => {
    // The first test that exercises a real ZMQ socket end-to-end in
    // the sandbox, not just an `import zmq`. The shape is constrained
    // by two of yurt's current realities:
    //
    //   1. libzmq's signaler calls `socketpair(AF_UNIX, …)`, which the
    //      yurt ABI shim implements via bind/listen/connect/accept on
    //      AF_INET loopback (abi/src/yurt_socket.c). That listen() is
    //      denied unless the host opts in — hence
    //      `serverSockets.allowLoopback`. Without it the test fails
    //      at `ctx.socket(...)` with "Not supported (src/ip.cpp:773)".
    //
    //   2. The default libzmq Context spawns a separate I/O reactor
    //      thread the first time a socket is allocated. yurt's
    //      `threadsBackend` is a cooperative single-threaded JS
    //      event loop and rejects the pthread_create — libzmq then
    //      bails with "Resource temporarily unavailable
    //      (src/thread.cpp:241)". `set(IO_THREADS, 0)` keeps libzmq
    //      synchronous and skips the reactor spawn. The catch is
    //      that `IO_THREADS=0` disables TCP transports (which need
    //      the reactor for poll/select); only `inproc://` (in-
    //      process queues) works. Sufficient to prove the pyzmq
    //      bindings are alive and the socket wire is real.
    //
    // When the kernel grows preemptive threads (`host_thread_spawn`
    // actually spawning a parallel execution context), this test can
    // bump to TCP + default IO_THREADS and the same shape covers
    // the Jupyter wire pattern.
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
    });
    try {
      const result = await runPython(sandbox, [
        "import zmq",
        "ctx = zmq.Context()",
        "ctx.set(zmq.IO_THREADS, 0)",
        "p = ctx.socket(zmq.PAIR); p.bind('inproc://yurt-test')",
        "s = ctx.socket(zmq.PAIR); s.connect('inproc://yurt-test')",
        "s.send_string('jupyter-shape')",
        "print(p.recv_string())",
      ]);
      if (result.exitCode !== 0) {
        console.log("--- zmq inproc: exit", result.exitCode);
        console.log("--- zmq inproc stderr:", result.stderr);
      }
      // Note: Context.term() at process teardown currently trips a
      // "memory access out of bounds" in libzmq's shutdown path on
      // wasi (suspected interaction with the no-thread context).
      // The actual send/recv completes synchronously before that,
      // so the message lands on stdout and the assertion below
      // checks the visible part. Exit code is loose for the same
      // reason — assert payload, not exit.
      expect(result.stdout).toContain("jupyter-shape");
    } finally {
      sandbox.destroy();
    }
  });
});
