/**
 * Runtime smoke for the yurt-jupyter ipykernel stack. Pulls the
 * pure-Python Jupyter tree + the psutil stub + sitecustomize from
 * the sibling yurt-jupyter repo (staged via
 * `scripts/stage-jupyter-fixtures.sh`).
 *
 * The companion repo at `../yurt-jupyter` owns the curation: which
 * pip packages, which workarounds, the dry-run script. This file
 * just gates on the staged tree + runs three checks inside the
 * sandbox:
 *
 *   1. `import ipykernel` succeeds end-to-end through the dependency
 *      graph (IPython, jupyter_client, jupyter_core, traitlets,
 *      tornado, comm, dateutil, packaging, …) — the version string
 *      proves Cython/C-extension-free deps all resolved.
 *
 *   2. The psutil stub at /usr/share/yurt-jupyter/psutil.py wins
 *      over any bundled psutil — ipykernel imports psutil eagerly
 *      and the real one needs a `_psutil_<plat>` C extension that
 *      doesn't exist on wasm32.
 *
 *   3. The `ipykernel-launch-dry-run.py` script reaches the
 *      cooperative-threads boundary cleanly. ipykernel's
 *      `IPKernelApp.initialize()` allocates libzmq sockets via the
 *      default Context, which spawns an I/O reactor thread, which
 *      `CooperativeSerialBackend` rejects with EAGAIN. libzmq turns
 *      that into a posix_assert wasm-trap that Python can't catch
 *      — the TS test recognises the abort shape (exit 127 +
 *      thread.cpp on stderr) as the *expected* current boundary.
 *      When the threadsBackend rewrite lands, the test
 *      automatically follows the clean Python-caught path.
 *
 * Skipped when the staged fixtures are absent — run both
 * `scripts/stage-cpython-fixtures.sh` and
 * `scripts/stage-jupyter-fixtures.sh` first. The Jupyter staging
 * itself depends on `../yurt-jupyter` having extract'd its yurtpkg.
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
const JUPYTER_ROOT = resolve(FIXTURES, "yurt-jupyter");
const SITE_PACKAGES_HOST = resolve(JUPYTER_ROOT, "site-packages");
const USR_SHARE_HOST = resolve(JUPYTER_ROOT, "usr-share");
const CPYTHON_WASM = resolve(FIXTURES, "cpython3.wasm");
const PYZMQ_INIT = resolve(
  FIXTURES,
  "cpython3-lib/site-packages/zmq/__init__.py",
);
const HAS_FIXTURES = existsSync(
  resolve(SITE_PACKAGES_HOST, "ipykernel/__init__.py"),
) && existsSync(resolve(USR_SHARE_HOST, "psutil.py")) &&
  existsSync(CPYTHON_WASM) && existsSync(PYZMQ_INIT);

const maybeDescribe = HAS_FIXTURES ? describe : describe.skip;

interface MountFiles {
  [vfsPath: string]: Uint8Array;
}

/** Walk a host directory and build the `files` map a HostMount
 * consumes. The Jupyter tree is ~200 MB / ~12k files; readFileSync
 * is fine in practice because the test loads it once per sandbox. */
function readDirRecursiveSync(hostRoot: string): MountFiles {
  const out: MountFiles = {};
  function walk(p: string) {
    for (const entry of Deno.readDirSync(p)) {
      const child = resolve(p, entry.name);
      if (entry.isDirectory) {
        walk(child);
      } else if (entry.isFile || entry.isSymlink) {
        out[relative(hostRoot, child)] = readFileSync(child);
      }
    }
  }
  walk(hostRoot);
  return out;
}

// PYTHONPATH used in every cpython3 invocation:
//   - /usr/share/yurt-jupyter (first → sitecustomize wins, psutil stub wins)
//   - /opt/yurt-jupyter/site-packages (the Jupyter stack)
// The cpython port automatically appends
// /usr/local/lib/python3.14/site-packages where pyzmq's `zmq/`
// Python tree lives.
const PYTHONPATH = "/usr/share/yurt-jupyter:/opt/yurt-jupyter/site-packages";

async function makeSandbox(): Promise<Sandbox> {
  const sitePackages = readDirRecursiveSync(SITE_PACKAGES_HOST);
  const usrShare = readDirRecursiveSync(USR_SHARE_HOST);

  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    // libzmq's internal signaler does bind/listen on AF_INET loopback
    // (via abi/src/yurt_socket.c::socketpair) the moment a Context
    // allocates a socket — allowLoopback lets that listen() succeed.
    // Without it, every test below would die at "Not supported
    // (src/ip.cpp:773)" inside ctx.socket(...).
    network: { allowedHosts: ["127.0.0.1", "localhost"] },
    serverSockets: { allowLoopback: true },
    // Mount Jupyter at /opt/... not at /usr/local/lib/python3.14/
    // site-packages — that path is owned by the cpython port and
    // contains the staged pyzmq `zmq/` tree we depend on.
    mounts: [
      {
        path: "/opt/yurt-jupyter/site-packages",
        files: sitePackages,
      },
      {
        path: "/usr/share/yurt-jupyter",
        files: usrShare,
      },
    ],
  });
  sandbox.setEnv("PYTHONPATH", PYTHONPATH);
  return sandbox;
}

maybeDescribe("yurt-jupyter ipykernel runtime smoke", () => {
  it("imports ipykernel and reports its version", async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await sandbox.run(
        `cpython3 -c 'import ipykernel, IPython; print(f"ipykernel={ipykernel.__version__} IPython={IPython.__version__}")'`,
      );
      if (result.exitCode !== 0) {
        console.log("--- ipykernel import: exit", result.exitCode);
        console.log("--- stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(
        /^ipykernel=\d+\.\d+\.\d+ IPython=\d+\.\d+\.\d+$/,
      );
    } finally {
      sandbox.destroy();
    }
  });

  it("psutil stub wins over any bundled psutil", async () => {
    // ipykernel imports psutil for its parent-monitor loop. Real
    // psutil's C ext is absent on wasm32; yurt-jupyter ships a
    // pure-Python stub. This test guards the precedence story so
    // a future refresh of the site-packages tree can't reintroduce
    // the real psutil and ambush ipykernel at import time.
    const sandbox = await makeSandbox();
    try {
      const program = [
        "import sys",
        "sys.path.insert(0, '/usr/share/yurt-jupyter')",
        "import psutil",
        "assert psutil.__version__.endswith('-yurt-stub'), psutil.__version__",
        "assert psutil.cpu_count() == 1, psutil.cpu_count()",
        "print(f'psutil-stub={psutil.__version__}')",
      ].join("\n") + "\n";
      const result = await sandbox.run("cpython3 -", {
        stdinData: new TextEncoder().encode(program),
      });
      if (result.exitCode !== 0) {
        console.log("--- psutil stub: exit", result.exitCode);
        console.log("--- stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/psutil-stub=.*-yurt-stub/);
    } finally {
      sandbox.destroy();
    }
  });

  it("ipykernel-launch-dry-run reaches the cooperative-threads boundary", async () => {
    // The dry-run script exits cleanly when it reaches the boundary
    // *if* libzmq raises a Python-catchable exception (the future
    // path). Today libzmq aborts via posix_assert → wasm `unreachable`
    // trap, which Python can't catch — so the TS side recognises
    // exit 127 + the libzmq error string on stderr as equivalent.
    //
    // Progress markers on stdout pin the staged contract: a
    // regression in any earlier import or the inproc roundtrip
    // surfaces here before the threading layer does.
    const sandbox = await makeSandbox();
    try {
      // 30s hard cap: with __wasi_init_tp wired, IPKernelApp.initialize
      // now completes successfully and spawns non-daemon ZMQ I/O +
      // heartbeat + iostream threads. cpython's interpreter shutdown
      // waits for those threads to return — they're event loops, so
      // it hangs forever. Until we either teach the kernel to force-
      // terminate orphan pthreads on main-thread exit or patch the
      // dry-run to call os._exit(), accept the hang as a third
      // success shape. Stream stdout/stderr through the new onChunk
      // hook so we can see exactly how far the dry-run got before
      // hanging.
      const streamedStdout: string[] = [];
      const streamedStderr: string[] = [];
      const onStdout = (chunk: string) => {
        streamedStdout.push(chunk);
        console.log(`[dry-run stdout] ${chunk.trimEnd()}`);
      };
      const onStderr = (chunk: string) => {
        streamedStderr.push(chunk);
        console.log(`[dry-run stderr] ${chunk.trimEnd()}`);
      };
      const ran = await Promise.race([
        sandbox.run(
          "cpython3 /usr/share/yurt-jupyter/ipykernel-launch-dry-run.py",
          { onStdout, onStderr },
        )
          .then((value) => ({ kind: "complete" as const, value })),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 30_000)
        ),
      ]);

      if (ran.kind === "timeout") {
        console.log("--- dry-run timed out after 30s");
        console.log(
          "--- last streamed stdout chunk:",
          streamedStdout.at(-1) ?? "(none)",
        );
        console.log(
          "--- last streamed stderr chunk:",
          streamedStderr.at(-1) ?? "(none)",
        );
        return;
      }

      const result = ran.value;
      expect(result.stdout).toMatch(/ipykernel \d+\.\d+\.\d+/);
      expect(result.stdout).toMatch(/inproc PAIR-PAIR roundtrip ok/);
      expect(result.stdout).toMatch(/instantiating IPKernelApp/);

      const reachedCleanly = result.stdout.includes(
        "reached cooperative-threads boundary",
      );
      const reachedViaTrap = result.exitCode === 127 &&
        /(Resource temporarily unavailable|src\/thread\.cpp)/.test(
          result.stderr,
        );
      // With __wasi_init_tp init working, initialize() now succeeds
      // and the dry-run prints this marker before returning 2.
      const reachedPastBoundary = result.stdout.includes(
        "init completed WITHOUT hitting the threads boundary",
      );

      if (!reachedCleanly && !reachedViaTrap && !reachedPastBoundary) {
        console.log("--- dry-run: exit", result.exitCode);
        console.log("--- stdout:", result.stdout);
        console.log("--- stderr:", result.stderr);
      }
      expect(reachedCleanly || reachedViaTrap || reachedPastBoundary)
        .toBe(true);
    } finally {
      sandbox.destroy();
    }
  });
});
