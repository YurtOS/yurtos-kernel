/**
 * Reproducer: worker-host dispatcher deadlock when main calls a
 * blocking `Atomics.wait` while a spawned worker is mid-flight.
 *
 * EXPECTED TO FAIL until `packages/kernel/src/network/bridge.ts`'s
 * `requestSync` / `fetchSync` are rewritten to use `Atomics.waitAsync`
 * (or made async end-to-end). When this test passes, the bug is fixed.
 *
 * What happens
 * ------------
 * `IPKernelApp.initialize(...)` allocates ipykernel's 5 ZMQ sockets,
 * which causes libzmq's I/O reactor thread to spawn AND triggers
 * socket operations that route through the kernel's
 * `createNetworkBridgeSocketBackend` (`packages/kernel/src/network/
 * socket-backend.ts:350`). Those calls hit
 * `NetworkBridge.requestSync` (`packages/kernel/src/network/
 * bridge.ts:564`), which does `Atomics.wait(int32, 0, …, 30_000)`
 * on the main JS thread.
 *
 * `Atomics.wait` on main blocks the JS event loop. Meanwhile the
 * spawned I/O reactor worker has issued a `postMessage(
 * {type:"host-call"})` to main and is parked in
 * `Atomics.wait` on its own request SAB awaiting the dispatcher's
 * response. Main's listener (attached via
 * `attachWorkerHostDispatcher`) can't fire because the event loop
 * is frozen by the bridge's own `Atomics.wait`. Mutual deadlock —
 * the bridge's 30-second timeout is the only way it ever unblocks,
 * and even that leaves the worker stuck.
 *
 * The earlier `SabMutex.lockAsync` / `SabCondvar.waitAsync` fixes
 * resolved the same class of bug in the threads backend. The bridge
 * code path is the second layer.
 *
 * Status contract
 * ---------------
 * - FAIL today: "DEADLOCK: IPKernelApp.initialize did not return
 *   within 20s".
 * - PASS once `bridge.ts` is rewired: IPKernelApp.initialize advances
 *   past the socket-allocation step and the test exits with whatever
 *   the next concrete error or success is — at that point this test
 *   transitions from "reproducer" to "smoke" and its assertion shape
 *   should be tightened.
 *
 * Skipped when the staged threaded cpython3 + pyzmq + yurt-jupyter
 * fixtures are absent.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";

const FIXTURES = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const CPYTHON_WASM = resolve(FIXTURES, "cpython3.wasm");
const PYZMQ_INIT = resolve(
  FIXTURES,
  "cpython3-lib/site-packages/zmq/__init__.py",
);
const JUPYTER_SITE_PACKAGES = resolve(FIXTURES, "yurt-jupyter/site-packages");
const JUPYTER_USR_SHARE = resolve(FIXTURES, "yurt-jupyter/usr-share");
const IPYKERNEL_INIT = resolve(JUPYTER_SITE_PACKAGES, "ipykernel/__init__.py");
const PSUTIL_STUB = resolve(JUPYTER_USR_SHARE, "psutil.py");
const HAS_FIXTURES = existsSync(CPYTHON_WASM) && existsSync(PYZMQ_INIT) &&
  existsSync(IPYKERNEL_INIT) && existsSync(PSUTIL_STUB);

const maybeDescribe = HAS_FIXTURES ? describe : describe.skip;

const PYTHONPATH = "/usr/share/yurt-jupyter:/opt/yurt-jupyter/site-packages";

function readDirRecursiveSync(hostRoot: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  function walk(p: string) {
    for (const entry of Deno.readDirSync(p)) {
      const child = resolve(p, entry.name);
      if (entry.isDirectory) walk(child);
      else if (entry.isFile || entry.isSymlink) {
        out[relative(hostRoot, child)] = readFileSync(child);
      }
    }
  }
  walk(hostRoot);
  return out;
}

async function withTimeout<T>(
  ms: number,
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: number | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms) as unknown as number;
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

maybeDescribe("worker-host bridge.requestSync deadlock", () => {
  it("IPKernelApp.initialize returns within 20s (currently hangs)", async () => {
    // Stage the full jupyter fixture set so cpython can reach the
    // socket-allocation path inside ipykernel.kernelapp:
    //   - /opt/yurt-jupyter/site-packages  → pure-Python jupyter stack
    //   - /usr/share/yurt-jupyter          → sitecustomize + psutil stub
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      // ipykernel binds 5 TCP loopback sockets via libzmq. Without
      // allowLoopback the listen() trips "Not supported (src/ip.cpp:773)"
      // before we ever reach the deadlock site.
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
      mounts: [
        {
          path: "/opt/yurt-jupyter/site-packages",
          files: readDirRecursiveSync(JUPYTER_SITE_PACKAGES),
        },
        {
          path: "/usr/share/yurt-jupyter",
          files: readDirRecursiveSync(JUPYTER_USR_SHARE),
        },
      ],
    });
    sandbox.setEnv("PYTHONPATH", PYTHONPATH);
    try {
      const program = [
        // sitecustomize-style ssl pre-import; the dry-run script does
        // the same thing for a different yurt-kernel bug.
        "import ssl",
        // Smallest reproducer for the deadlock: just instantiate +
        // initialize. No need to actually run the kernel.
        "from ipykernel.kernelapp import IPKernelApp",
        "IPKernelApp.clear_instance()",
        "app = IPKernelApp.instance()",
        "try:",
        "  app.initialize(['-f', '/tmp/yurt-jupyter-k.json'])",
        "  print('initialize ok')",
        "except Exception as e:",
        "  print(f'initialize failed: {type(e).__name__}: {e}')",
      ].join("\n") + "\n";

      const ran = await withTimeout(
        20_000,
        sandbox.run("cpython3 -", {
          stdinData: new TextEncoder().encode(program),
        }),
      );

      if (!ran.ok) {
        throw new Error(
          "DEADLOCK: IPKernelApp.initialize did not return within 20s.\n" +
            "\n" +
            "Earlier layers already fixed (dc58e1c, dbaa1be): SabMutex/\n" +
            "SabCondvar + NetworkBridge.requestSync/fetchSync now use\n" +
            "Atomics.waitAsync. The remaining blocker is the WASI VFS path.\n" +
            "\n" +
            "Expected cause: packages/kernel/src/execution/vfs-proxy.ts:94\n" +
            "still does `Atomics.wait(this.int32, 0, STATUS_REQUEST)` on the\n" +
            "execution-worker thread (where cpython lives). cpython does\n" +
            "many VFS ops during IPKernelApp.initialize (config dirs, log\n" +
            "files, jupyter runtime paths) — each blocks the execution-\n" +
            "worker event loop and stalls the pthread worker's dispatcher\n" +
            "postMessages.\n" +
            "\n" +
            "Fix path (phased — order matters):\n" +
            "  1. Add path_* WASI imports (path_open, path_filestat_get,\n" +
            "     path_create_directory, path_unlink_file, path_rename,\n" +
            "     path_symlink, path_readlink, path_remove_directory, …)\n" +
            "     to ASYNC_WASI_IMPORTS in packages/kernel/src/process/\n" +
            "     loader.ts:115. Verify against file-conformance smoke\n" +
            "     (sunny's regression gate for JSPI i64-arg behavior).\n" +
            "  2. Widen VfsLike interface in vfs/vfs-like.ts to return\n" +
            "     `T | Promise<T>` for the affected methods.\n" +
            "  3. Convert VfsProxy methods (and execution-worker.ts:467's\n" +
            "     extension proxy) to use Atomics.waitAsync; cascade `await`\n" +
            "     up through FdTable.open + the wrapped path_* imports.",
        );
      }

      // When the deadlock is fixed, IPKernelApp.initialize will EITHER
      // succeed (print "initialize ok") or fail with a Python exception
      // we then print as "initialize failed: …". Both shapes count as
      // "no longer hanging". Tighten this assertion to `toBe(0)` and
      // `toContain("initialize ok")` once the next gate is closed.
      console.log("--- initialize: exit", ran.value.exitCode);
      console.log("--- stdout:", ran.value.stdout);
      console.log("--- stderr:", ran.value.stderr);
      expect(ran.value.stdout).toMatch(
        /initialize ok|initialize failed: \w+: /,
      );
    } finally {
      sandbox.destroy();
    }
  });
});
