/**
 * Reproducer for the libzmq-I/O-reactor-spawn hang.
 *
 * This test is EXPECTED TO HANG until the worker-SAB ↔ main-thread
 * dispatcher deadlock is resolved. It exists so the regression is
 * pinned at a small, focused level instead of being buried inside the
 * full ipykernel-launch dry-run.
 *
 * What it does
 * ------------
 * Spins up a sandbox against the threaded `cpython3.wasm` and runs
 * the minimal Python program that triggers libzmq's I/O reactor
 * thread spawn:
 *
 *   import zmq
 *   ctx = zmq.Context()       # IO_THREADS=1 by default → spawn
 *   print("reactor ok")
 *
 * The `import zmq` step does NOT yet allocate any sockets, so libzmq's
 * signaler doesn't run. The first thing that does run is the default
 * `Context()` constructor, which calls `pthread_create` for the I/O
 * reactor. That `pthread_create` routes through the kernel's
 * `WorkerSabThreadsBackend.spawn`, which posts a `start` message to a
 * fresh Worker hosting a cloned cpython3.wasm instance. The reactor
 * thread then issues its first host-import call (typically a poll or
 * recvmsg loop primitive) via the worker-host-proxy SAB round-trip.
 *
 * Suspected deadlock: the worker `Atomics.wait`s on the request SAB
 * for main's response, but main is parked in some sync code path that
 * doesn't drain the worker's `"host-call"` message. Either side waits
 * forever.
 *
 * Why this test instead of just running the jupyter smoke
 * -------------------------------------------------------
 * 1. The jupyter dry-run runs ~50 lines of Python before reaching the
 *    reactor spawn; if any of those preflight steps regresses, the
 *    failure shape is identical (silent hang). A focused reproducer
 *    cuts the failure surface to one operation.
 * 2. The hang itself blocks `deno test` indefinitely — this test
 *    wraps the run in `Promise.race` against a hard timeout so the
 *    suite fails fast with a recognisable message rather than wedging
 *    CI.
 *
 * Status contract
 * ---------------
 * - Currently expected to FAIL with "REACTOR HANG: cpython3 zmq.Context()
 *   did not return within 10s — worker-SAB / dispatcher deadlock".
 * - When the deadlock is fixed, expect the run to complete with stdout
 *   containing "reactor ok" and exit code 0.
 *
 * Skipped when the staged threaded cpython3 + pyzmq fixtures are absent.
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
const JUPYTER_SITE_PACKAGES = resolve(
  FIXTURES,
  "yurt-jupyter/site-packages",
);
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

/**
 * Wrap a promise with a hard timeout. Returns `{ ok: true, value }` on
 * settled-in-time, `{ ok: false }` on timeout. Importantly the timer is
 * cleared on settle so we don't leak `setTimeout` handles when the
 * underlying promise resolves first (Deno's test sanitizer would
 * otherwise complain).
 */
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

maybeDescribe("libzmq I/O reactor spawn (worker-SAB integration)", () => {
  // Walks the same import chain the ipykernel dry-run uses, one
  // import at a time. The dry-run hangs after printing "importing
  // stack…" but before printing the ipykernel version. This narrows
  // which import is the culprit.
  const IMPORT_CHAIN = [
    "traitlets",
    "tornado",
    "jupyter_client",
    "jupyter_core",
    "IPython",
    "ipykernel",
  ];
  for (const mod of IMPORT_CHAIN) {
    it(`import ${mod} returns within 10s`, async () => {
      const sitePackages = readDirRecursiveSync(JUPYTER_SITE_PACKAGES);
      const sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ["127.0.0.1", "localhost"] },
        serverSockets: { allowLoopback: true },
        mounts: [
          { path: "/opt/yurt-jupyter/site-packages", files: sitePackages },
          {
            path: "/usr/share/yurt-jupyter",
            files: readDirRecursiveSync(JUPYTER_USR_SHARE),
          },
        ],
      });
      sandbox.setEnv("PYTHONPATH", PYTHONPATH);
      try {
        const ran = await withTimeout(
          10_000,
          sandbox.run(`cpython3 -c 'import ${mod}; print("${mod} ok")'`),
        );
        if (!ran.ok) {
          throw new Error(
            `IMPORT HANG: cpython3 -c 'import ${mod}' did not return within 10s`,
          );
        }
        const result = ran.value;
        if (result.exitCode !== 0) {
          console.log(`--- import ${mod}: exit`, result.exitCode);
          console.log("--- stderr:", result.stderr);
        }
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`${mod} ok`);
      } finally {
        sandbox.destroy();
      }
    });
  }

  it("ssl preload + full import stack returns within 10s", async () => {
    // Mimic the exact preflight the ipykernel-launch-dry-run runs:
    // pre-import ssl (workaround for the ssl/asyncio order issue),
    // then the full import stack in one process.
    const sitePackages = readDirRecursiveSync(JUPYTER_SITE_PACKAGES);
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
      mounts: [
        { path: "/opt/yurt-jupyter/site-packages", files: sitePackages },
        {
          path: "/usr/share/yurt-jupyter",
          files: readDirRecursiveSync(JUPYTER_USR_SHARE),
        },
      ],
    });
    sandbox.setEnv("PYTHONPATH", PYTHONPATH);
    try {
      const program = [
        "import ssl",
        "import traitlets, tornado, jupyter_client, jupyter_core, IPython, ipykernel",
        "print('stack ok')",
      ].join("\n") + "\n";
      const ran = await withTimeout(
        15_000,
        sandbox.run("cpython3 -", {
          stdinData: new TextEncoder().encode(program),
        }),
      );
      if (!ran.ok) {
        throw new Error(
          "IMPORT HANG: ssl + full stack did not return within 15s — " +
            "matches the jupyter_smoke step 3 dry-run hang shape.",
        );
      }
      if (ran.value.exitCode !== 0) {
        console.log("--- stack import: exit", ran.value.exitCode);
        console.log("--- stdout:", ran.value.stdout);
        console.log("--- stderr:", ran.value.stderr);
      }
      expect(ran.value.exitCode).toBe(0);
      expect(ran.value.stdout).toContain("stack ok");
    } finally {
      sandbox.destroy();
    }
  });

  it("IPKernelApp.initialize reaches the reactor spawn within 15s", async () => {
    // The actual step 3 dry-run shape: imports + IPKernelApp.initialize.
    // If this hangs while the import-only test above passes, the bug
    // is in libzmq's I/O reactor spawn from inside IPKernelApp, not
    // in the imports.
    const sitePackages = readDirRecursiveSync(JUPYTER_SITE_PACKAGES);
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      serverSockets: { allowLoopback: true },
      mounts: [
        { path: "/opt/yurt-jupyter/site-packages", files: sitePackages },
        {
          path: "/usr/share/yurt-jupyter",
          files: readDirRecursiveSync(JUPYTER_USR_SHARE),
        },
      ],
    });
    sandbox.setEnv("PYTHONPATH", PYTHONPATH);
    try {
      const program = [
        "import ssl",
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
        15_000,
        sandbox.run("cpython3 -", {
          stdinData: new TextEncoder().encode(program),
        }),
      );
      if (!ran.ok) {
        throw new Error(
          "INIT HANG: IPKernelApp.initialize did not return within 15s — " +
            "matches the jupyter step 3 dry-run hang.",
        );
      }
      console.log("--- initialize: exit", ran.value.exitCode);
      console.log("--- stdout:", ran.value.stdout);
      console.log("--- stderr:", ran.value.stderr);
      // Don't assert success here — this is a reproducer. Just want to
      // see what happens.
    } finally {
      sandbox.destroy();
    }
  });

  it("zmq.Context() returns within 10s", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ["127.0.0.1", "localhost"] },
      // libzmq's internal signaler calls socketpair(AF_UNIX, …); the
      // yurt ABI shim implements it via bind/listen/connect/accept on
      // AF_INET loopback. Without allowLoopback the signaler trips
      // "Not supported (src/ip.cpp:773)" at ctx.socket() time.
      serverSockets: { allowLoopback: true },
    });
    try {
      const program = [
        "import zmq",
        "ctx = zmq.Context()",
        "print('reactor ok')",
        // Skip ctx.term() — the libzmq shutdown path has a separate
        // known wasm-bounds bug (see cpython3-pyzmq_smoke_test.ts:230
        // comment) that we don't want masking the reactor-spawn result.
      ].join("\n") + "\n";

      const ran = await withTimeout(
        10_000,
        sandbox.run("cpython3 -", {
          stdinData: new TextEncoder().encode(program),
        }),
      );

      if (!ran.ok) {
        throw new Error(
          "REACTOR HANG: cpython3 zmq.Context() did not return within 10s. " +
            "Likely worker-SAB dispatcher deadlock: the spawned I/O reactor " +
            "is blocked in Atomics.wait on the per-thread request SAB while " +
            "main is parked somewhere that prevents the dispatcher from " +
            "draining the worker's 'host-call' message. " +
            "Inspect packages/kernel/src/process/threads/worker-sab.ts " +
            "(defaultSpawnThread) and worker-host-proxy.ts " +
            "(attachWorkerHostDispatcher) — likely fix is to detach the " +
            "join await from the dispatcher's message-handler dispatch.",
        );
      }

      const result = ran.value;
      if (result.exitCode !== 0) {
        console.log("--- reactor reproducer: exit", result.exitCode);
        console.log("--- stdout:", result.stdout);
        console.log("--- stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("reactor ok");
    } finally {
      sandbox.destroy();
    }
  });
});
