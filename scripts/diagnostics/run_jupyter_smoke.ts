/**
 * Diagnostic harness — launch ipykernel inside the kernel sandbox with
 * the same fixtures the jupyter smoke uses, but call `IPKernelApp.start()`
 * instead of stopping at `initialize()`. Streams stdout+stderr through
 * the per-chunk sandbox hook (sandbox.ts:installStreamingChunkHooks) so
 * the cold-hang location stays visible even when cpython doesn't return.
 *
 * Pair with `launch_ipkernel.py` in this directory.
 *
 * Run from the repo root:
 *
 *   YURT_NET_DEBUG=1 deno run --no-check -A --unstable-sloppy-imports \
 *     scripts/diagnostics/run_jupyter_smoke.ts
 *
 * What you'll see, in order:
 *
 *   1. `[launch] importing IPKernelApp…`        — cpython imports work
 *   2. `[launch] clear/instance…`                — IPKernelApp singleton
 *   3. `[launch] initialize(...)`                — about to call init
 *   4. `[yurt-net] bind/listen fd=…`             — 5 jupyter channels
 *   5. `[yurt-net] pthread.socketpair / spawn`   — libzmq mailbox + I/O
 *   6. `[yurt-net] pthread.bind fd=…`            — heartbeat allocs its
 *                                                  AF_INET listener
 *   7. `[yurt-net] pthread.poll.req / resp ready=0` x N — pthreads idle,
 *                                                          no client
 *                                                          connecting
 *
 * Current known stall: main cpython hangs somewhere in step 3 (between
 * `bind fd=1059` and the next op — looks like a `threading.Thread.start`
 * waiting on `_started.wait()` from an IOPubThread / ParentPoller whose
 * bootstrap doesn't complete on our pthread runtime). Diagnosis options
 * (future PR):
 *   - faulthandler.dump_traceback_later() inside cpython to see what
 *     main is stuck on
 *   - audit per-pthread `_started: threading.Event` set propagation
 *     across our SabCondvar.signal -> Atomics.notify path
 *   - wire additional dispatcher ops (host_socket_connect for pthreads,
 *     getsockname/getpeername) that IOPubThread may need on bootstrap
 *
 * Why this exists: the standing jupyter_smoke_test.ts uses the dry-run
 * script that stops at the cooperative-threads boundary. This harness
 * pushes past — into IPKernelApp.start() — for the express purpose of
 * making the next hang visible.
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "../../packages/kernel/src/sandbox.ts";
import { NodeAdapter } from "../../packages/kernel/src/platform/node-adapter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(
  HERE,
  "../../packages/kernel/src/platform/__tests__/fixtures",
);
const SITE = resolve(FIXTURES, "yurt-jupyter/site-packages");
const USR = resolve(FIXTURES, "yurt-jupyter/usr-share");
const LAUNCH_PY = resolve(HERE, "launch_ipkernel.py");

function readDir(root: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  function walk(p: string) {
    for (const e of Deno.readDirSync(p)) {
      const c = resolve(p, e.name);
      if (e.isDirectory) walk(c);
      else if (e.isFile || e.isSymlink) {
        out[relative(root, c)] = readFileSync(c);
      }
    }
  }
  walk(root);
  return out;
}

const sandbox = await Sandbox.create({
  wasmDir: FIXTURES,
  adapter: new NodeAdapter(),
  network: { allowedHosts: ["127.0.0.1", "localhost"] },
  serverSockets: { allowLoopback: true },
  mounts: [
    { path: "/opt/yurt-jupyter/site-packages", files: readDir(SITE) },
    { path: "/usr/share/yurt-jupyter", files: readDir(USR) },
    {
      path: "/tmp",
      files: { "launch.py": readFileSync(LAUNCH_PY) },
    },
  ],
});
sandbox.setEnv(
  "PYTHONPATH",
  "/usr/share/yurt-jupyter:/opt/yurt-jupyter/site-packages",
);

console.log("=== sandbox up — running cpython3 /tmp/launch.py ===");
const t0 = Date.now();
const result = await sandbox.run("cpython3 /tmp/launch.py", {
  onStdout: (chunk) => Deno.stdout.writeSync(new TextEncoder().encode(chunk)),
  onStderr: (chunk) => Deno.stderr.writeSync(new TextEncoder().encode(chunk)),
});
console.log(`\n=== finished in ${Date.now() - t0}ms ===`);
console.log("exit code:", result.exitCode);
sandbox.destroy();
