/**
 * Runtime smoke for the cpython3 + pyzmq integration.
 *
 * Validates that the cpython3.wasm built by `yurt-ports/ports/cpython`
 * (with PYZMQ_PREFIX live) can:
 *
 *   1. Boot through the yurt sandbox process path.
 *   2. Resolve the `_zmq` builtin baked into the interpreter.
 *   3. Import the `zmq` package from /usr/local/lib/python3.14/
 *      site-packages/zmq/ — staged into the sandbox VFS via the
 *      sandbox's cpython3-lib-manifest mechanism.
 *
 * Skipped when fixtures/cpython3.wasm is not present (the file is
 * gitignored; populate by running scripts/stage-cpython-fixtures.sh
 * after building the cpython + pyzmq ports).
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
import { NodeAdapter } from "../platform/node-adapter.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const CPYTHON_WASM = resolve(WASM_DIR, "cpython3.wasm");

const maybeDescribe = existsSync(CPYTHON_WASM) ? describe : describe.skip;

maybeDescribe("cpython3 + pyzmq runtime smoke", () => {
  it("boots cpython3 and reports its version", async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      const result = await sandbox.run("cpython3 --version");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("Python 3.14.4");
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
      // -S skips site.py because cpython's site.py imports
      // `binascii`, gated on a future zlib yurt port. We compensate
      // by manually prepending site-packages to sys.path.
      const code = [
        "import sys",
        "sys.path.insert(0, \\\"/usr/local/lib/python3.14/site-packages\\\")",
        "import zmq",
        "print(zmq.zmq_version())",
      ].join("; ");
      const result = await sandbox.run(`cpython3 -S -c "${code}"`);
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
});
