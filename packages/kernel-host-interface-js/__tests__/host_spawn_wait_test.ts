/**
 * Unit tests for host_spawn / host_wait wiring in buildUserYurtImports.
 *
 * Strategy: directly call the kernel via KernelHostInterface to verify the
 * end-to-end flow:
 *   1. host_spawn is no longer in the ENOSYS stub set (removed from
 *      USER_YURT_STUB_IMPORTS).
 *   2. Calling SYS_SPAWN directly via kernelSyscall enqueues a PendingSpawn
 *      and returns a positive child pid.
 *   3. After runPendingSpawns() drains the queue, SYS_WAIT returns an 8-byte
 *      kernel response whose status byte encodes exit code 7.
 *
 * The full guest→host_spawn→host_wait round trip (where the user wasm itself
 * calls host_spawn + host_wait) is Task 5 / E2E. Here we unit-test the
 * kernel-side plumbing without instantiating a guest that imports host_spawn.
 */

import { assertEquals, assertGreater } from "@std/assert";
import {
  defaultHostState,
  KernelHostInterface,
  METHOD,
  s,
} from "../mod.ts";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function workspaceRoot(): string {
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

let cachedKernelWasm: Uint8Array | undefined;
async function kernelWasm(): Promise<Uint8Array> {
  if (cachedKernelWasm) return cachedKernelWasm;
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  const path = join(
    targetDir,
    "wasm32-wasip1",
    "release",
    "yurt_kernel_wasm.wasm",
  );
  try {
    cachedKernelWasm = await Deno.readFile(path);
    return cachedKernelWasm;
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        "yurt-kernel-wasm",
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) throw new Error("cargo build of yurt-kernel-wasm failed");
    cachedKernelWasm = await Deno.readFile(path);
    return cachedKernelWasm;
  }
}

async function freshKernelHostInterface(): Promise<KernelHostInterface> {
  return await KernelHostInterface.load(await kernelWasm(), defaultHostState());
}

async function fixtureWasm(crateName: string, artifact: string): Promise<Uint8Array> {
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  const path = join(targetDir, "wasm32-wasip1", "release", `${artifact}.wasm`);
  try {
    return await Deno.readFile(path);
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        crateName,
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) throw new Error(`build of ${crateName} failed`);
    return await Deno.readFile(path);
  }
}

/** Build the SYS_SPAWN wire request: u32 path_len + path + (u32 arg_len + arg)* */
function encodeSysSpawnRequest(path: Uint8Array, argv: Uint8Array[]): Uint8Array {
  let len = 4 + path.byteLength;
  for (const arg of argv) len += 4 + arg.byteLength;
  const req = new Uint8Array(len);
  const view = new DataView(req.buffer);
  let off = 0;
  view.setUint32(off, path.byteLength, true);
  off += 4;
  req.set(path, off);
  off += path.byteLength;
  for (const arg of argv) {
    view.setUint32(off, arg.byteLength, true);
    off += 4;
    req.set(arg, off);
    off += arg.byteLength;
  }
  return req;
}

// ── Inline wasm helpers for malformed-request tests ──────────────────────────

/**
 * Each WASM_* constant is a minimal wasm module (compiled from WAT via
 * wat2wasm, hex-encoded inline) that:
 *   - imports yurt.host_spawn(i32,i32,i32,i32)->i32
 *   - imports wasi_snapshot_preview1.proc_exit(i32)
 *   - exports memory
 *   - exports _start: calls host_spawn with a crafted bad request then
 *     proc_exit(rc) so the return value is observable as the exit code
 *
 * The data sections (if any) embed the crafted request at offset 0.
 */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Case (a): host_spawn(ptr=0, len=50, 0, 0) — 50 bytes < 88-byte minimum → -22 */
const WASM_A = hexToBytes(
  "0061736d0100000001100360047f7f7f7f017f60017f0060000002360204797572740a686f73745f737061776e000016776173695f736e617073686f745f70726576696577310970726f635f657869740001030201020503010001071302066d656d6f72790200065f737461727400020a10010e004100413241004100100010010b",
);
/** Case (b): 88-byte header, logicalSize=88, version=2 → -22 */
const WASM_B = hexToBytes(
  "0061736d0100000001100360047f7f7f7f017f60017f0060000002360204797572740a686f73745f737061776e000016776173695f736e617073686f745f70726576696577310970726f635f657869740001030201020503010001071302066d656d6f72790200065f737461727400020a11010f00410041d80041004100100010010b0b0c010041000b06580000000200",
);
/** Case (c): 88-byte buffer, logicalSize=200 (> 88) → -75 */
const WASM_C = hexToBytes(
  "0061736d0100000001100360047f7f7f7f017f60017f0060000002360204797572740a686f73745f737061776e000016776173695f736e617073686f745f70726576696577310970726f635f657869740001030201020503010001071302066d656d6f72790200065f737461727400020a11010f00410041d80041004100100010010b0b0c010041000b06c80000000100",
);
/**
 * Case (d): logicalSize=90, version=1, prog="/x"@offset88,
 * argsVecOff=0, argsCount=5 → -22 (I2: null vec with non-zero count)
 */
const WASM_D = hexToBytes(
  "0061736d0100000001100360047f7f7f7f017f60017f0060000002360204797572740a686f73745f737061776e000016776173695f736e617073686f745f70726576696577310970726f635f657869740001030201020503010001071302066d656d6f72790200065f737461727400020a11010f00410041da0041004100100010010b0b2e020041000b205a000000010000005800000002000000000000000000000000000000050000000041d8000b022f78",
);
/**
 * Case (e): logicalSize=88, version=1, prog_off=5 (misaligned: 5 % 4 != 0)
 * → -22 (I1: span offset not a multiple of 4)
 */
const WASM_E = hexToBytes(
  "0061736d0100000001100360047f7f7f7f017f60017f0060000002360204797572740a686f73745f737061776e000016776173695f736e617073686f745f70726576696577310970726f635f657869740001030201020503010001071302066d656d6f72790200065f737461727400020a11010f00410041d80041004100100010010b0b16010041000b1058000000010000000500000002000000",
);

/**
 * Run a minimal wasm module (built with the pattern above) as a user process.
 * Catches proc_exit(n) and returns n.  Re-throws any other error.
 */
async function runMalformedSpawnCase(
  mk: KernelHostInterface,
  wasmBytes: Uint8Array,
): Promise<number> {
  const user = mk.spawnUserProcessWithArgs(wasmBytes, [s("test")]);
  let exitCode = 0;
  try {
    user.runStart();
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const m = /proc_exit\((-?\d+)\)/.exec(msg);
    if (m) {
      exitCode = Number(m[1]);
    } else {
      throw e;
    }
  }
  return exitCode;
}

// ── Test 1: host_spawn malformed-request negative cases ──────────────────────

Deno.test("host_spawn returns clean errno for malformed yurt_spawn_request_v1 buffers", async () => {
  // Each sub-case drives host_spawn with a crafted bad request and asserts
  // a clean negative errno return — never a throw/trap from the import.

  // (a) bytes.length < 88 → -22 (EINVAL: header too short)
  {
    const mk = await freshKernelHostInterface();
    const rc = await runMalformedSpawnCase(mk, WASM_A);
    assertEquals(rc, -22, `case (a): expected -22 for too-short request, got ${rc}`);
  }

  // (b) version != 1 → -22 (EINVAL: unknown record version)
  {
    const mk = await freshKernelHostInterface();
    const rc = await runMalformedSpawnCase(mk, WASM_B);
    assertEquals(rc, -22, `case (b): expected -22 for bad version, got ${rc}`);
  }

  // (c) logicalSize > bytes.length → -75 (EOVERFLOW)
  {
    const mk = await freshKernelHostInterface();
    const rc = await runMalformedSpawnCase(mk, WASM_C);
    assertEquals(rc, -75, `case (c): expected -75 for logicalSize overflow, got ${rc}`);
  }

  // (d) argsCount=5, argsVecOff=0 → -22 (EINVAL: null vec with non-zero count)
  {
    const mk = await freshKernelHostInterface();
    const rc = await runMalformedSpawnCase(mk, WASM_D);
    assertEquals(rc, -22, `case (d): expected -22 for null args vec, got ${rc}`);
  }

  // (e) prog span offset=5 (misaligned, not a multiple of 4) → -22 (EINVAL)
  {
    const mk = await freshKernelHostInterface();
    const rc = await runMalformedSpawnCase(mk, WASM_E);
    assertEquals(rc, -22, `case (e): expected -22 for misaligned prog span, got ${rc}`);
  }
});

// ── Test 2: SYS_SPAWN enqueues a child and returns a pid ─────────────────────

Deno.test("SYS_SPAWN with child-exit7 registers a pending spawn and returns pid", async () => {
  const mk = await freshKernelHostInterface();
  const childWasm = await fixtureWasm("child-exit7-wasm", "child-exit7-wasm");

  const childPath = s("/child-exit7.wasm");
  mk.registerRamfsFile(childPath, childWasm);

  // SYS_SPAWN: path=/child-exit7.wasm, argv=["/child-exit7.wasm"]
  const { rc } = mk.kernelSyscall(
    METHOD.SYS_SPAWN,
    1,
    encodeSysSpawnRequest(childPath, [childPath]),
    0,
  );
  const childPid = Number(rc);
  assertGreater(
    childPid,
    999,
    `expected kernel-allocated child pid >= 1000, got ${childPid}`,
  );

  // Drain should return the pending spawn record
  const pending = mk.drainPendingSpawn();
  if (pending === null) {
    throw new Error("expected a pending spawn entry after SYS_SPAWN");
  }
  assertEquals(pending.childPid, childPid);
});

// ── Test 3: runPendingSpawns + SYS_WAIT yields exit code 7 ───────────────────

Deno.test("runPendingSpawns drains child-exit7 and SYS_WAIT returns status 7", async () => {
  const mk = await freshKernelHostInterface();
  const childWasm = await fixtureWasm("child-exit7-wasm", "child-exit7-wasm");

  const childPath = s("/child-exit7.wasm");
  mk.registerRamfsFile(childPath, childWasm);

  const { rc: spawnRc } = mk.kernelSyscall(
    METHOD.SYS_SPAWN,
    1,
    encodeSysSpawnRequest(childPath, [childPath]),
    0,
  );
  const childPid = Number(spawnRc);
  assertGreater(childPid, 999, `bad child pid: ${childPid}`);

  // Drain and run the child (records exit code 7 into kernel)
  mk.runPendingSpawns();

  // SYS_WAIT: wantPid=childPid, flags=0
  const waitReq = new Uint8Array(8);
  const waitView = new DataView(waitReq.buffer);
  waitView.setUint32(0, childPid >>> 0, true);
  waitView.setUint32(4, 0, true); // flags=0
  const { rc: waitRc, response } = mk.kernelSyscall(
    METHOD.SYS_WAIT,
    1,
    waitReq,
    8,
  );
  assertEquals(Number(waitRc), 8, `SYS_WAIT should return 8 bytes, got ${waitRc}`);

  // Decode kernel 8-byte response: u32 exitedPid@0, i32 status@4
  const resp = new DataView(response.buffer, response.byteOffset, 8);
  const exitedPid = resp.getUint32(0, true);
  const status = resp.getInt32(4, true);
  assertEquals(exitedPid, childPid, "exited pid should match");
  assertEquals(status, 7, "exit status should be 7 (child-exit7 exits with 7)");
});

// ── Test 4: yurt_spawn_request_v1 parsing (parse a minimal 88-byte header) ───

Deno.test("host_spawn parses yurt_spawn_request_v1 and forwards to SYS_SPAWN", async () => {
  // Build a minimal yurt_spawn_request_v1 manually (88-byte fixed header,
  // prog span pointing to a string appended after the header).
  // Then verify that invoking a user process whose wasm calls host_spawn
  // yields a positive child pid in the result buffer.
  //
  // This test verifies the parse path by confirming that buildUserYurtImports
  // no longer stubs host_spawn with -ENOSYS.  We do so by running the
  // spawn-wait fixture, which calls host_spawn + host_wait internally.

  const mk = await freshKernelHostInterface();

  // Register child-exit7.wasm in the kernel's ramfs (spawn-wait calls
  // Command::new("/child-exit7.wasm").status())
  const childWasm = await fixtureWasm("child-exit7-wasm", "child-exit7-wasm");
  mk.registerRamfsFile(s("/child-exit7.wasm"), childWasm);

  // Load spawn-wait fixture (calls host_spawn + host_wait at the wasm level)
  const spawnWaitWasm = await fixtureWasm("spawn-wait-wasm", "spawn-wait-wasm");

  // spawnUserProcessWithArgs gives us a UserProcess with an initial pid.
  // When it runs _start, it will call host_spawn(/child-exit7.wasm) and then
  // host_wait.  runPendingSpawns() must be called to drain the child.
  const user = mk.spawnUserProcessWithArgs(spawnWaitWasm, [
    s("spawn-wait"),
  ]);

  // We call runStart in a try/catch because proc_exit(0) throws.
  let exitCode = -1;
  try {
    user.runStart();
    exitCode = 0;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    const m = /proc_exit\((-?\d+)\)/.exec(msg);
    if (m) {
      exitCode = Number(m[1]);
    } else {
      throw e;
    }
  }

  assertEquals(exitCode, 0, `spawn-wait should exit 0, got ${exitCode}`);
});
