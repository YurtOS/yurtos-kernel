#!/usr/bin/env -S deno run --allow-all --no-check --unstable-sloppy-imports
/**
 * Run real ipykernel_launcher inside the yurt sandbox with logs
 * streamed live. Use it for iteration on the jupyter init path.
 *
 * Usage:
 *   scripts/run-jupyter.ts                          # 60s timeout, default
 *   scripts/run-jupyter.ts --timeout 300            # 5 min
 *   scripts/run-jupyter.ts --log-level DEBUG        # pass through to ipykernel
 *   scripts/run-jupyter.ts --tee /tmp/jupyter.log   # mirror to file
 *
 * What runs:
 *   cpython3 -m ipykernel_launcher -f /tmp/yurt-jupyter-kernel.json
 *
 * Behavior:
 *   - Stages the yurt-jupyter fixture tree at /opt/yurt-jupyter/...
 *   - Stages the sitecustomize + psutil stub at /usr/share/yurt-jupyter
 *   - PYTHONUNBUFFERED=1 so prints flush immediately
 *   - Streams stdout/stderr to the terminal (and optional --tee file)
 *   - Prints connection file contents (if it gets written) so you can
 *     dial in from a host-side client
 *   - Ctrl-C aborts cleanly
 *
 * What blocks today (current state in this branch):
 *   `Heartbeat.run() → self._bind_socket()` — libzmq ROUTER bind on
 *   the heartbeat worker pthread deadlocks against hb_ctx's I/O
 *   reactor pthread through the sync worker-host dispatcher. Sunny's
 *   dispatcher work fixes this.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "jsr:@std/cli@^1/parse-args";
import { Sandbox } from "../packages/kernel/src/sandbox.ts";
import { NodeAdapter } from "../packages/kernel/src/platform/node-adapter.ts";

const args = parseArgs(Deno.args, {
  string: ["timeout", "log-level", "tee", "connection-file"],
  boolean: ["no-connection-file-readback"],
  default: {
    timeout: "60",
    "log-level": "INFO",
    "connection-file": "/tmp/yurt-jupyter-kernel.json",
  },
});

const TIMEOUT_MS = Number(args.timeout) * 1000;
const LOG_LEVEL = String(args["log-level"]);
const CONN_FILE = String(args["connection-file"]);
const TEE_PATH = args.tee ? String(args.tee) : null;

const KERNEL_ROOT = resolve(import.meta.dirname!, "..");
const FIXTURES = resolve(
  KERNEL_ROOT,
  "packages/kernel/src/platform/__tests__/fixtures",
);
const JUPYTER_ROOT = resolve(FIXTURES, "yurt-jupyter");
const SITE_PACKAGES_HOST = resolve(JUPYTER_ROOT, "site-packages");
const USR_SHARE_HOST = resolve(JUPYTER_ROOT, "usr-share");

if (!existsSync(resolve(SITE_PACKAGES_HOST, "ipykernel/__init__.py"))) {
  console.error(
    `fatal: jupyter fixtures missing under ${JUPYTER_ROOT}\n` +
      `       Run scripts/stage-jupyter-fixtures.sh first.`,
  );
  Deno.exit(2);
}
if (!existsSync(resolve(FIXTURES, "cpython3.wasm"))) {
  console.error(
    `fatal: cpython3.wasm missing at ${FIXTURES}\n` +
      `       Rebuild yurt-ports/ports/cpython and re-stage.`,
  );
  Deno.exit(2);
}

interface MountFiles {
  [vfsPath: string]: Uint8Array;
}
function readDirRecursiveSync(hostRoot: string): MountFiles {
  const out: MountFiles = {};
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

let teeStream: Deno.FsFile | null = null;
if (TEE_PATH) {
  mkdirSync(dirname(TEE_PATH), { recursive: true });
  teeStream = await Deno.open(TEE_PATH, {
    create: true,
    write: true,
    truncate: true,
  });
}
const teeWrite = (label: string, chunk: string) => {
  const line = `[${label}] ${chunk.trimEnd()}\n`;
  Deno.stdout.writeSync(new TextEncoder().encode(line));
  if (teeStream) teeStream.writeSync(new TextEncoder().encode(line));
};

console.error(
  `[runner] mounting yurt-jupyter (${SITE_PACKAGES_HOST.length}…), ` +
    `loglevel=${LOG_LEVEL}, timeout=${TIMEOUT_MS}ms, ` +
    `connfile=${CONN_FILE}, tee=${TEE_PATH ?? "-"}`,
);

const sandbox = await Sandbox.create({
  wasmDir: FIXTURES,
  adapter: new NodeAdapter(),
  network: { allowedHosts: ["127.0.0.1", "localhost"] },
  serverSockets: { allowLoopback: true },
  mounts: [
    {
      path: "/opt/yurt-jupyter/site-packages",
      files: readDirRecursiveSync(SITE_PACKAGES_HOST),
    },
    {
      path: "/usr/share/yurt-jupyter",
      files: readDirRecursiveSync(USR_SHARE_HOST),
    },
  ],
});
sandbox.setEnv(
  "PYTHONPATH",
  "/usr/share/yurt-jupyter:/opt/yurt-jupyter/site-packages",
);
sandbox.setEnv("PYTHONUNBUFFERED", "1");
// ipykernel respects the standard traitlets `--log-level` flag, but
// also reads JUPYTER_LOG_LEVEL on some paths. Set both.
sandbox.setEnv("JUPYTER_LOG_LEVEL", LOG_LEVEL);

let cancelled = false;
const onSignal = () => {
  if (cancelled) return;
  cancelled = true;
  console.error("[runner] SIGINT received — destroying sandbox");
  try {
    sandbox.destroy();
  } catch (e) {
    console.error("[runner] destroy threw:", (e as Error).message);
  }
};
Deno.addSignalListener("SIGINT", onSignal);

try {
  const start = Date.now();
  const cmd = `cpython3 -m ipykernel_launcher --log-level=${LOG_LEVEL} -f ${CONN_FILE}`;
  console.error(`[runner] ${cmd}`);

  const run = sandbox.run(cmd, {
    onStdout: (c) => teeWrite("OUT", c),
    onStderr: (c) => teeWrite("ERR", c),
  });

  // Print the connection file once it appears (so a host-side client
  // could attach). We poll the VFS instead of the sandbox.run
  // returning, because the kernel is supposed to run forever.
  const pollConn = async () => {
    while (!cancelled) {
      try {
        const blob = sandbox.readFile(CONN_FILE);
        const text = new TextDecoder().decode(blob);
        console.error(`[runner] connection-file ready: ${CONN_FILE}`);
        console.error(text);
        return;
      } catch {
        // not yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  if (!args["no-connection-file-readback"]) void pollConn();

  const result = await Promise.race([
    run.then((r) => ({ kind: "done" as const, r })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), TIMEOUT_MS)
    ),
  ]);
  const ms = Date.now() - start;
  if (result.kind === "timeout") {
    console.error(`[runner] TIMEOUT after ${TIMEOUT_MS}ms (${ms}ms wall)`);
  } else {
    console.error(`[runner] exit ${result.r.exitCode} (${ms}ms wall)`);
  }
} finally {
  if (!cancelled) {
    try {
      sandbox.destroy();
    } catch {
      /* ignore */
    }
  }
  if (teeStream) teeStream.close();
}
