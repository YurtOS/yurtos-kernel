# JS-host multi-process (spawn/wait) driver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a guest that does `spawn` + `waitpid` run correctly through the Deno-side `Runner`, with byte-identical results to the Rust host.

**Architecture:** Mirror, in `kernel-host-interface-js`, the per-child semantics of the Rust host's `run_pending_spawns` (`packages/runtime-wasmtime/src/kernel_host_interface.rs:3095`): the guest calls `host_spawn` → kernel `sys_spawn` enqueues a `PendingSpawn` and returns a child pid; the guest calls `host_wait` → kernel `sys_wait` returns `-EAGAIN`; the host then drains and runs every pending child (instantiated **bound to the kernel-allocated child pid**), `recordExit`s each, and the guest's `host_wait` retries and reaps. The drive loop is re-entrant from `host_wait` (the existing JS thread-pump shape), a documented, intentional divergence from the Rust external-cadence loop.

**Tech Stack:** TypeScript (Deno), Rust (`wasm32-wasip1` fixture + `wasmtime` parity test), the `kernel.wasm` ABI.

**Spec:** `docs/superpowers/specs/2026-05-17-js-host-multiprocess-driver-design.md` (rev3, commit `9841bf4`). Read it before starting.

**Workspace — NON-NEGOTIABLE:** All work happens in the isolated worktree `/Users/sunny/work/yurtos/yurtos-kernel-pr129` on branch `claude/remove-typescript-kernel-CUcuf`. The primary checkout `/Users/sunny/work/yurtos/yurtos-kernel` is driven by a concurrent agent and its branch changes underfoot — never run git/edits there. Every command below is run with that worktree as CWD.

**Env:** Deno networking in this env needs `DENO_CERT=/etc/ssl/certs/ca-certificates.crt` (TLS-intercepting proxy). The test commands here are offline (`--allow-read/-run`, no `--allow-net` fetch), so this should not bite, but set it if a step unexpectedly does TLS.

**Out of scope (do not implement):** `fork()` (its own PR); per-pid child stdout draining; concurrent fork/pipes/pthreads; signal-terminated children (kernel-contract boundary — see spec).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/kernel-host-interface-js/mod.ts` | modify | New `KernelHostInterface.runPendingSpawns()`; new internal instantiate-bound-to-kernel-pid + run-`_start` helper; `buildUserYurtImports` gains `drainPendingProcess?`; wire `host_spawn`/`host_wait`; drop the 2 names from `USER_YURT_STUB_IMPORTS`; pass `drainPendingProcess` from `spawn()`/`spawnThread`. |
| `packages/runner/src/process-pump.ts` | modify | Replace the "throw on queued spawn" block with `mk.runPendingSpawns()`. |
| `test-fixtures/wasm/spawn-wait/` | create | Rust guest fixture: parent spawns exactly one child, `waitpid(child)`, prints a deterministic line with the reaped exit code. |
| `Cargo.toml` (workspace) | modify | Register `test-fixtures/wasm/spawn-wait` as a workspace member (follow how the other 8 fixtures are registered). |
| `packages/runner/src/__tests__/spawn_wait_test.ts` | create | Deno E2E: build fixtures via cargo if missing, run through `Runner.runArgv`, assert stdout + exit code. |
| `packages/runner/src/__tests__/runner_test.ts` | modify | Replace the throw-on-missing-artifact with the cargo-auto-build helper (same convention). |
| `.github/workflows/deno.yml` | modify | Add `packages/runner/src/__tests__/` to the CI `deno test` invocation. |
| `packages/runtime-wasmtime/tests/fixture_parity.rs` | modify | Add a `spawn-wait` case so both hosts assert byte-identical stdout + exit. |
| wasm-fixture build list(s) | modify | Add `spawn-wait-wasm` wherever the existing 8 fixtures are enumerated for the slow-tier build (grep for an existing fixture name, e.g. `wc-bytes-wasm`). |

**Verified anchors (do not re-derive; cite while implementing):**
- `PendingSpawn` (`mod.ts:265`): `{ childPid: number; wasmBytes: Uint8Array; argv: Uint8Array[] }`.
- `KernelHostInterface.drainPendingSpawn(): PendingSpawn | null` (`mod.ts:3527`, `null` on `-ENOENT`).
- `KernelHostInterface.recordExit(pid, exitStatus): void` (`mod.ts:3522`, **throws** when kernel rc≠0).
- `KernelHostInterface.spawnUserProcessWithArgs(bytes, argv)` → caches an anon module then `spawnCachedUserProcess(moduleId, argv)` (`mod.ts:3585`). `UserProcess` ctor `(pid, instance, memory, kernel)`; `runStart()` calls `_start`; `capturedStdout()` drains the **root** pid (`mod.ts:2126-2175`).
- `buildUserYurtImports(pid, kernel, userMemoryRef, callerTid=1, drainPendingThread?)` (`mod.ts:1620`); stub loop `for (const name of USER_YURT_STUB_IMPORTS) imports[name] = () => -ENOSYS;` (`:1687`); `host_thread_join` `-EAGAIN`→`drainPendingThread()`→retry (`:1697-1712`). Engine passes `drainPendingThread` from `spawn()` (`:1909`) and `spawnThread()` (`:2037`).
- Constants in `mod.ts`: `ENOENT=2` (`:484`), `EAGAIN=11` (`:485`), `ESRCH=3` (`:493`), `ENOSYS=38` (`:494`); `METHOD.SYS_WAIT=0x1_002C` (`:175`), `METHOD.SYS_SPAWN=0x1_002F` (`:178`).
- `decodePendingSpawn` already implemented (`mod.ts:996`).
- Rust reference `run_pending_spawns` (`kernel_host_interface.rs:3095`); `instantiate_with_pid` (`:3020`).
- Normative wait-status decode: `packages/kernel-host-interface-deno/wasm-kernel-imports.ts:795-821` (`signal = status>=128 && status<192 ? status-128 : 0; exitCode = signal===0 ? status : 0;` → 16-byte `{i32 pid, i32 exitCode, i32 signal, i32 0}` LE).
- Rust parity harness: `packages/runtime-wasmtime/tests/fixture_parity.rs` (`ensure_fixture_built(crate_name)` runs `cargo build --release -p <crate> --target wasm32-wasip1`).
- Existing fixtures are plain Rust crates (`test-fixtures/wasm/echo-args/`: `Cargo.toml` with `name = "echo-args-wasm"`, `src/main.rs` a `fn main()`).

---

## Task 1: Pin the two unverified contract points (discovery spike)

Two byte-level contracts must be read from source, not guessed, before coding. This task produces a short note committed to the plan dir; no product code.

**Files:**
- Read: `packages/kernel-host-interface-deno/wasm-kernel-imports.ts` (the `host_spawn` descriptor), `packages/kernel-wasm/src/dispatch/process.rs:1236` (`sys_spawn` request parser), `abi/src/` (guest-side spawn/wait wrappers — grep), an existing guest user of spawn if any.
- Create: `docs/superpowers/plans/2026-05-17-contract-notes.md`

- [ ] **Step 1: Extract the `SYS_SPAWN` request encoding.** In the worktree run:
  `grep -n "host_spawn\|SYS_SPAWN" packages/kernel-host-interface-deno/wasm-kernel-imports.ts` and read its descriptor; cross-check `sed -n '1236,1360p' packages/kernel-wasm/src/dispatch/process.rs` for how `sys_spawn` parses the request. Record the exact byte layout (the spec states `u32 path_len + path + u32 argc + (u32 len + arg)*` — confirm or correct against `process.rs`).

- [ ] **Step 2: Extract the guest-side spawn/wait calling convention.** Run `grep -rn "host_spawn\|host_wait\|posix_spawn\|yurt_host_spawn\|sys_spawn" abi/src abi/include` and identify how a guest invokes spawn+wait (C wrapper, `#[link(wasm_import_module="yurt")]` extern, or libc `posix_spawn`/`execve`+`waitpid`). Record the exact symbol(s) and signature(s) a Rust `wasm32-wasip1` fixture must call, and how argv/path are passed.

- [ ] **Step 3: Write `docs/superpowers/plans/2026-05-17-contract-notes.md`** containing: (a) the confirmed `SYS_SPAWN` request byte layout with field offsets; (b) the confirmed guest spawn+wait API the fixture will use, with a minimal Rust snippet that compiles the call (extern block or libc call); (c) the confirmed `WNOHANG` flag bit value (grep `WNOHANG` in `packages/kernel-wasm/src/dispatch/process.rs`). No "TBD" — if something cannot be confirmed from source, stop and report rather than guess.

- [ ] **Step 4: Commit.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
git add docs/superpowers/plans/2026-05-17-contract-notes.md
git commit -m "docs(plan): pin SYS_SPAWN encoding + guest spawn/wait convention"
```

> Tasks 2–7 reference `contract-notes.md` for the two byte-level contracts. Use the confirmed values verbatim.

---

## Task 2: Rust guest fixture `spawn-wait` (no host changes yet)

A guest that spawns one child and waits for it. Built first so later JS tasks have a real artifact to assert against. It will currently FAIL through the Runner (host stubs return `-ENOSYS`) — that failure is the red test for Task 5.

**Files:**
- Create: `test-fixtures/wasm/spawn-wait/Cargo.toml`
- Create: `test-fixtures/wasm/spawn-wait/src/main.rs`
- Modify: `Cargo.toml` (workspace members) — mirror an existing fixture entry
- Create: `test-fixtures/wasm/child-exit7/Cargo.toml`, `test-fixtures/wasm/child-exit7/src/main.rs` (the child program: exit(7))

- [ ] **Step 1: Create the child fixture.** `test-fixtures/wasm/child-exit7/Cargo.toml`:
```toml
[package]
name = "child-exit7-wasm"
version = "0.1.0"
edition = "2021"
```
`test-fixtures/wasm/child-exit7/src/main.rs`:
```rust
fn main() {
    std::process::exit(7);
}
```

- [ ] **Step 2: Create the parent fixture.** `test-fixtures/wasm/spawn-wait/Cargo.toml`:
```toml
[package]
name = "spawn-wait-wasm"
version = "0.1.0"
edition = "2021"
```
`test-fixtures/wasm/spawn-wait/src/main.rs` — spawn `/child-exit7.wasm`, `waitpid` it, print the reaped code. Use the **exact** guest spawn/wait API recorded in `contract-notes.md` (Task 1 Step 3). Skeleton (replace the two marked calls with the confirmed convention; argv[0] is the kernel-resolved program path):
```rust
fn main() {
    // Spawn exactly one child by path. (confirmed API from contract-notes.md)
    let child_pid: i32 = spawn_child("/child-exit7.wasm");
    if child_pid < 0 {
        println!("spawn failed: {child_pid}");
        std::process::exit(1);
    }
    // waitpid(child_pid) — single targeted wait, NOT wait(-1) (see spec).
    let code: i32 = wait_child(child_pid); // confirmed API from contract-notes.md
    println!("child {child_pid} exited {code}");
    std::process::exit(0);
}
```
Add the `spawn_child` / `wait_child` definitions per `contract-notes.md` (extern block or libc). They MUST use `waitpid(child_pid)`, not `wait(-1)`.

- [ ] **Step 3: Register both crates as workspace members.** Run `grep -n "test-fixtures/wasm" Cargo.toml` and add `test-fixtures/wasm/spawn-wait` and `test-fixtures/wasm/child-exit7` to the `members` list exactly like the existing 8.

- [ ] **Step 4: Build both fixtures.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
cargo build --release --target wasm32-wasip1 -p spawn-wait-wasm -p child-exit7-wasm
```
Expected: builds succeed; `target/wasm32-wasip1/release/spawn-wait-wasm.wasm` and `child-exit7-wasm.wasm` exist.

- [ ] **Step 5: Commit.**
```bash
git add test-fixtures/wasm/spawn-wait test-fixtures/wasm/child-exit7 Cargo.toml
git commit -m "test(fixtures): add spawn-wait + child-exit7 wasm fixtures"
```

---

## Task 3: `KernelHostInterface.runPendingSpawns()` + instantiate-bound-to-kernel-pid

The genuinely new JS code. A flat iterative drain mirroring the Rust reference; instantiate each child **bound to the kernel-allocated `childPid`** (hard requirement — never a fresh host pid), run `_start`, parse the `proc_exit` trap, `recordExit`.

**Files:**
- Modify: `packages/kernel-host-interface-js/mod.ts`
- Test: `packages/kernel-host-interface-js/__tests__/run_pending_spawns_test.ts` (create)

- [ ] **Step 1: Read the by-pid instantiation path.** Read `mod.ts` `spawnCachedUserProcess` (find it: `grep -n "spawnCachedUserProcess\|cacheProcessModule\|parseSpawnContext" mod.ts`) and `CachedProcessEngine.spawn()` (`:1864`). Note how a pid+argv+module become a running instance; the new helper mirrors this but (a) takes the kernel-allocated pid from `PendingSpawn.childPid`, (b) actually calls `_start`.

- [ ] **Step 2: Write the failing test.** `packages/kernel-host-interface-js/__tests__/run_pending_spawns_test.ts`:
```ts
import { assertEquals } from "jsr:@std/assert";
import { build_and_load_kernel } from "./helpers.ts"; // reuse the suite's kernel loader; if none, mirror kernel-host-interface_test.ts:40-70
import { KernelHostInterface } from "../mod.ts";

Deno.test("runPendingSpawns drains a queued child bound to its kernel pid", async () => {
  // Arrange: a kernel with one PendingSpawn enqueued whose wasm exits 7.
  // Use the spawn-wait/child-exit7 artifacts; stage child at /child-exit7.wasm,
  // run the parent far enough to enqueue the spawn, then:
  const mk = await build_and_load_kernel();
  // ...stage + spawn parent (see kernel-host-interface_test.ts patterns)...
  // Act
  mk.runPendingSpawns();
  // Assert: the child was reaped with code 7 (waitProcess sees it).
  const w = mk.waitProcess(/*parentPid*/ 1, /*childPid*/ 0, 0);
  assertEquals(w.status, 7);
});
```
(If wiring a full kernel here is heavy, this behavior is also covered end-to-end by Task 5; keep this test minimal — assert `runPendingSpawns` exists and is a no-op returning normally when nothing is queued, plus the Task 5 E2E covers the reaping path. Prefer the real assertion if the suite already has kernel helpers.)

- [ ] **Step 3: Run it, expect failure.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
deno test --no-check --allow-read --allow-write --allow-env --allow-run packages/kernel-host-interface-js/__tests__/run_pending_spawns_test.ts
```
Expected: FAIL — `mk.runPendingSpawns is not a function`.

- [ ] **Step 4: Implement the by-pid instantiate+run helper on `CachedProcessEngine`.** Add a method that mirrors `spawn()` (`mod.ts:1864`) but takes an explicit kernel pid and runs `_start`, parsing the `proc_exit` trap with the **same regex contract** as `process-pump.ts` (`/proc_exit\((-?\d+)\)/`; clean return ⇒ 0):
```ts
// In class CachedProcessEngine, sibling of spawn()/spawnThread().
runCachedChild(
  kernel: KernelInstance,
  childPid: number,
  wasmBytes: Uint8Array,
  argv: Uint8Array[],
): number {
  const moduleId = s(`pending-spawn:${childPid}`);
  this.cacheModule(moduleId, wasmBytes);
  const module = this.modules.get(byteKey(moduleId))!;
  const userMemoryRef: { memory?: WebAssembly.Memory } = {};
  const sysImports = buildSysImports(childPid, kernel, userMemoryRef);
  const sys_setrlimit = (resource: number, soft: bigint, hard: bigint): number => {
    const req = new Uint8Array(20);
    const v = new DataView(req.buffer);
    v.setUint32(0, resource >>> 0, true);
    v.setBigUint64(4, soft, true);
    v.setBigUint64(12, hard, true);
    return Number(kernel.syscall(METHOD.SYS_SETRLIMIT, childPid, req, 0).rc);
  };
  const instance = new WebAssembly.Instance(module, {
    env: { ...sysImports, sys_setrlimit },
    wasi_snapshot_preview1: buildWasiShim(childPid, kernel, argv, userMemoryRef),
    yurt: buildUserYurtImports(
      childPid, kernel, userMemoryRef, 1,
      (tid) => this.runPendingThread(childPid, tid),
      () => this.runPendingSpawns(kernel), // child may itself spawn
    ),
  });
  const memory = instance.exports.memory instanceof WebAssembly.Memory
    ? instance.exports.memory
    : new WebAssembly.Memory({ initial: 0 });
  userMemoryRef.memory = memory;
  const start = instance.exports._start;
  if (typeof start !== "function") return 0;
  try {
    (start as () => void)();
    return 0; // clean return, no WASI exit ⇒ 0 (mirrors last_exit().unwrap_or(0))
  } catch (e) {
    const m = /proc_exit\((-?\d+)\)/.exec((e as Error).message ?? String(e));
    if (m) return Number(m[1]) | 0;
    throw e;
  }
}

runPendingSpawns(kernel: KernelInstance): void {
  let depth = 0;
  // (no recursion here; the guard is for the re-entrant host_wait nesting,
  //  enforced in buildUserYurtImports — see Task 4. This loop is flat.)
  for (;;) {
    const pending = this.drainPendingSpawnViaKernel(kernel); // see Step 5
    if (pending === null) break;
    const code = this.runCachedChild(
      kernel, pending.childPid, pending.wasmBytes, pending.argv,
    );
    if (++depth > 100000) throw new Error("runPendingSpawns: runaway drain");
    try {
      const rc = Number(kernel.recordExit(pending.childPid, code));
      if (rc !== 0 && rc !== -ESRCH) {
        throw new Error(`kernel_record_exit failed: rc=${rc}`);
      }
    } catch (e) {
      // -ESRCH ⇒ child already reaped/gone: continue draining (spec).
      if (!String((e as Error).message).includes("rc=-3")) throw e;
    }
  }
}
```
Note: `recordExit` on `KernelHostInterface` throws on rc≠0; here we call the lower-level `kernel.recordExit` (the `KernelInstance` raw call, as `KernelHostInterface.recordExit` does at `mod.ts:3522`) so `-ESRCH` can be tolerated per spec. Confirm the raw call shape against `mod.ts:3522`.

- [ ] **Step 5: Expose drain to the engine.** `CachedProcessEngine` has `this.kernelRef`. Add `private drainPendingSpawnViaKernel(kernel): PendingSpawn | null` that calls `kernel.drainPendingSpawnRaw()` and `decodePendingSpawn` exactly as `KernelHostInterface.drainPendingSpawn()` does (`mod.ts:3527`: `-ENOENT`⇒null, decode otherwise). Then add the public delegator on `KernelHostInterface`:
```ts
// On class KernelHostInterface, near recordExit (mod.ts:3522):
runPendingSpawns(): void {
  this.engine.runPendingSpawns(this.kernel);
}
```
(Use the suite's actual engine field name — grep `new CachedProcessEngine` / `this.engine` in `mod.ts`.)

- [ ] **Step 6: Run the test, expect pass.**
```bash
deno test --no-check --allow-read --allow-write --allow-env --allow-run packages/kernel-host-interface-js/__tests__/run_pending_spawns_test.ts
```
Expected: PASS.

- [ ] **Step 7: Typecheck + commit.**
```bash
deno check 'packages/kernel-host-interface-js/**/*.ts'
git add packages/kernel-host-interface-js
git commit -m "feat(khi-js): runPendingSpawns — flat drain, instantiate bound to kernel child pid"
```

---

## Task 4: Wire `host_spawn` / `host_wait` in `buildUserYurtImports`

Replace the `-ENOSYS` stubs so the guest can request a spawn and block in `host_wait` until the host pumps children. Mirror the `host_thread_join` `-EAGAIN`→drain→retry shape.

**Files:**
- Modify: `packages/kernel-host-interface-js/mod.ts` (`buildUserYurtImports`, `USER_YURT_STUB_IMPORTS`, the two engine call sites `:1909` and `:2037`)

- [ ] **Step 1: Add the `drainPendingProcess` parameter + nesting guard.** Change the signature at `mod.ts:1620`:
```ts
function buildUserYurtImports(
  pid: number,
  kernel: KernelInstance,
  userMemoryRef: { memory?: WebAssembly.Memory },
  callerTid = 1,
  drainPendingThread?: (tid: number) => void,
  drainPendingProcess?: () => void,
): Record<string, (...args: (number | bigint)[]) => number> {
```

- [ ] **Step 2: Remove the two names from the stub list.** At `USER_YURT_STUB_IMPORTS` (`mod.ts:518`) delete the `"host_spawn"` and `"host_wait"` entries (leave `"host_fork"` — out of scope). The `for (...) imports[name] = () => -ENOSYS` loop then no longer stubs them.

- [ ] **Step 3: Wire `host_spawn` and `host_wait`** right after the `host_thread_*` block (after `mod.ts:1712`). Use the confirmed `SYS_SPAWN` encoding from `contract-notes.md`; the `host_wait` retry mirrors `host_thread_join` (`:1697`) and the status→`yurt_wait_result_v1` decode is the deno normative formula:
```ts
const WNOHANG = /* value from contract-notes.md, typically 1 */ 1;
imports.host_spawn = (pathPtr, pathLen, argvPtr, argvCnt) => {
  const path = copyIn(Number(pathPtr), Number(pathLen));
  if (typeof path === "number") return path;
  // Build the SYS_SPAWN request EXACTLY per contract-notes.md.
  const req = buildSpawnRequest(path, readArgv(Number(argvPtr), Number(argvCnt)));
  return Number(kernel.syscall(METHOD.SYS_SPAWN, pid, req, 0).rc);
};
imports.host_wait = (wantPid, flags, outPtr, outCap) => {
  const req = new Uint8Array(8);
  const rv = new DataView(req.buffer);
  rv.setUint32(0, Number(wantPid) >>> 0, true);
  rv.setUint32(4, Number(flags) >>> 0, true);
  let out = kernel.syscall(METHOD.SYS_WAIT, pid, req, 8);
  let rc = Number(out.rc);
  while (
    rc === -EAGAIN && !(Number(flags) & WNOHANG) && drainPendingProcess
  ) {
    drainPendingProcess();
    out = kernel.syscall(METHOD.SYS_WAIT, pid, req, 8);
    rc = Number(out.rc);
  }
  if (rc < 0) return rc;
  if (rc !== 8) return -7; // -E2BIG/malformed for this ABI (deno parity)
  const kv = new DataView(out.response.buffer, out.response.byteOffset, 8);
  const exitedPid = kv.getUint32(0, true);
  const status = kv.getInt32(4, true);
  const signal = status >= 128 && status < 192 ? status - 128 : 0;
  const exitCode = signal === 0 ? status : 0;
  const result = new Uint8Array(16);
  const rvv = new DataView(result.buffer);
  rvv.setInt32(0, exitedPid, true);
  rvv.setInt32(4, exitCode, true);
  rvv.setInt32(8, signal, true);
  rvv.setInt32(12, 0, true);
  return copyOut(Number(outPtr), result.subarray(0, Math.min(16, Number(outCap) >>> 0)));
};
```
Implement `buildSpawnRequest` and `readArgv` per `contract-notes.md` (helpers local to `buildUserYurtImports`, using the existing `copyIn`). If `outCap < 16`, return `-7` before writing (match deno `wasm-kernel-imports.ts:803`).

- [ ] **Step 4: Add a re-entrancy depth guard.** Wrap the `drainPendingProcess()` call so deeply nested `host_wait`→drain→child-`host_wait` recursion fails loudly. Add a module-scoped counter incremented before `drainPendingProcess()` and decremented after; throw `new Error("host_wait: re-entrant spawn/wait nesting too deep")` past a bound (e.g. 256). (Spec Risks.)

- [ ] **Step 5: Pass `drainPendingProcess` from the two engine call sites.** At `mod.ts:1909` (`spawn()`) and `:2037` (`spawnThread()`), add the 6th arg `() => this.runPendingSpawns(kernel)` (the engine method from Task 3). Use the `kernel` in scope at each site.

- [ ] **Step 6: Typecheck.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
deno check 'packages/kernel-host-interface-js/**/*.ts'
```
Expected: no errors.

- [ ] **Step 7: Commit.**
```bash
git add packages/kernel-host-interface-js/mod.ts
git commit -m "feat(khi-js): wire host_spawn/host_wait (EAGAIN->drain->retry, deno-parity decode)"
```

---

## Task 5: Drive the pump from `process-pump.ts` + E2E test (red→green)

**Files:**
- Modify: `packages/runner/src/process-pump.ts`
- Create: `packages/runner/src/__tests__/spawn_wait_test.ts`

- [ ] **Step 1: Write the failing E2E test.** `packages/runner/src/__tests__/spawn_wait_test.ts`. Mirror the cargo-auto-build pattern from `packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts:52-64` (read it first):
```ts
import { assertEquals } from "jsr:@std/assert";
import { Runner } from "../runner.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;

async function buildFixture(crate: string) {
  const wasm = `${ROOT}target/wasm32-wasip1/release/${crate}.wasm`;
  try {
    await Deno.stat(wasm);
    return wasm;
  } catch { /* build below */ }
  const cmd = new Deno.Command("cargo", {
    args: ["build", "--release", "-p", crate, "--target", "wasm32-wasip1"],
    cwd: ROOT,
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`cargo build of ${crate} failed`);
  return wasm;
}

Deno.test("spawn-wait: parent reaps child exit code through Runner", async () => {
  const kernelWasm = await buildFixture("yurt-kernel-wasm");
  const parent = await buildFixture("spawn-wait-wasm");
  const child = await buildFixture("child-exit7-wasm");
  const runner = await Runner.create({
    kernelWasm: await Deno.readFile(kernelWasm),
    mounts: [
      { path: "/spawn-wait.wasm", bytes: await Deno.readFile(parent) },
      { path: "/child-exit7.wasm", bytes: await Deno.readFile(child) },
    ],
  });
  const r = runner.runArgv(["/spawn-wait.wasm"]);
  assertEquals(r.stdout.trim(), "child 2 exited 7"); // confirm child pid value empirically; pin in assertion
  assertEquals(r.exitCode, 0);
});
```
(If `MountConfig`'s field is not `{path,bytes}`, read `packages/runner/src/vfs-stage.ts` for the real shape and fix the mounts. The expected child pid in the stdout assertion: run once, observe, pin the exact deterministic string — it must be stable across hosts for Task 6.)

- [ ] **Step 2: Run it, expect failure.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
deno test --no-check --allow-read --allow-write --allow-env --allow-run packages/runner/src/__tests__/spawn_wait_test.ts
```
Expected: FAIL — the current `pumpToCompletion` throws `"guest requested a child process (sys_spawn/fork) … not yet wired"`.

- [ ] **Step 3: Replace the throw with the pump.** In `packages/runner/src/process-pump.ts`, replace the block:
```ts
  const pending = mk.drainPendingSpawn();
  if (pending !== null) {
    throw new Error(
      "runner: guest requested a child process (sys_spawn/fork), which " +
        "requires the kernel-host-interface-deno process registry — not yet " +
        "wired into the Runner. Tracked as the multi-process pump follow-up.",
    );
  }

  return { exitCode };
```
with:
```ts
  // Any children the root queued without itself waiting are drained here;
  // children the root *did* wait on were already pumped re-entrantly from
  // host_wait. Idempotent: drains to -ENOENT.
  mk.runPendingSpawns();

  return { exitCode };
```
Update the file's header comment (lines 1-9) to state spawn/wait is now wired (fork still raises — but fork is a `-ENOSYS` stub so it surfaces as a guest errno, not a host throw; no code needed).

- [ ] **Step 4: Run the E2E, expect pass.**
```bash
deno test --no-check --allow-read --allow-write --allow-env --allow-run packages/runner/src/__tests__/spawn_wait_test.ts
```
Expected: PASS — stdout `child <pid> exited 7`, exit 0.

- [ ] **Step 5: Commit.**
```bash
git add packages/runner/src/process-pump.ts packages/runner/src/__tests__/spawn_wait_test.ts
git commit -m "feat(runner): drive runPendingSpawns from pumpToCompletion + spawn-wait E2E"
```

---

## Task 6: Cross-host parity in `fixture_parity.rs`

The Rust host already drives spawn/wait (`run_pending_spawns`). Add the same fixture there and assert byte-identical stdout + exit so the contract — not one host — is verified.

**Files:**
- Modify: `packages/runtime-wasmtime/tests/fixture_parity.rs`

- [ ] **Step 1: Read an existing parity case.** `grep -n "fn .*parity\|ensure_fixture_built\|captured_stdout\|run_pending_spawns" packages/runtime-wasmtime/tests/fixture_parity.rs` and read one complete test (e.g. the `echo-args` or `wc-bytes` case) to copy its structure (build → load kernel → spawn → run → drain stdout → assert).

- [ ] **Step 2: Add the `spawn-wait` case** following that structure exactly. It must: `ensure_fixture_built("spawn-wait-wasm")` and `ensure_fixture_built("child-exit7-wasm")`, stage `/child-exit7.wasm` and `/spawn-wait.wasm`, spawn the parent, call the Rust host's pump (`run_pending_spawns`) on the `-EAGAIN`/after-run path exactly as the existing multi-step cases do, drain the parent's stdout, and:
```rust
assert_eq!(stdout.trim(), "child 2 exited 7"); // SAME literal as the JS E2E (Task 5)
assert_eq!(exit_code, 0);
```
The asserted stdout string MUST be byte-identical to the JS E2E assertion in Task 5 Step 1 — that equality *is* the cross-host parity oracle.

- [ ] **Step 3: Run it.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
cargo test -p yurt-runtime-wasmtime --test fixture_parity spawn 2>&1 | tail -20
```
Expected: the new case PASSes; stdout matches the JS literal.

- [ ] **Step 4: Reconcile if the literals differ.** If the child pid differs between hosts, the spawn-wait fixture must print something host-invariant (e.g. drop the pid: `child exited 7`); update BOTH assertions and the fixture to match. Re-run Task 5 Step 4 and this step until both pass with the identical string.

- [ ] **Step 5: Commit.**
```bash
git add packages/runtime-wasmtime/tests/fixture_parity.rs test-fixtures/wasm/spawn-wait
git commit -m "test(parity): spawn-wait cross-host byte-parity (js Runner == wasmtime host)"
```

---

## Task 7: CI wiring + fast-tier hygiene

`packages/runner/__tests__` runs in no CI job today; the new + existing runner tests must run somewhere and not break pre-push.

**Files:**
- Modify: `.github/workflows/deno.yml`
- Modify: `packages/runner/src/__tests__/runner_test.ts`
- Modify: wasm-fixture build list(s) for the slow tier

- [ ] **Step 1: Wire runner tests into CI.** Read `.github/workflows/deno.yml` (the `IMAGE_RUNTIME_TESTS` list around `:17-35` and the `deno test … $IMAGE_RUNTIME_TESTS` step `:72`). Add `packages/runner/src/__tests__/spawn_wait_test.ts` (and the directory's other tests) to the invocation, alongside the existing kernel-host-interface suites. Match the existing YAML list style exactly.

- [ ] **Step 2: Make the runner CI step build wasm fixtures.** Ensure the job that runs these tests first builds the needed fixtures (`yurt-kernel-wasm`, `spawn-wait-wasm`, `child-exit7-wasm`) — either the test self-builds (it does, Task 5 Step 1) or add a `cargo build --release --target wasm32-wasip1 -p …` step mirroring how `guest-compat.yml` builds the existing 8. Add `spawn-wait-wasm` + `child-exit7-wasm` to that fixture build list (grep `wc-bytes-wasm` across `.github/workflows/` to find every place fixtures are enumerated).

- [ ] **Step 3: Fix `runner_test.ts` to auto-build, not throw.** Read `packages/runner/src/__tests__/runner_test.ts`'s `artifact()` helper. Replace its throw-on-missing with the same `buildFixture`-style cargo auto-build used in `spawn_wait_test.ts` Step 1 (extract a shared helper if clean, e.g. `packages/runner/src/__tests__/_build_fixture.ts`, and use it in both). This keeps the pre-push fast glob (`packages/**/*_test.ts`) green on a clean checkout.

- [ ] **Step 4: Run the full runner suite locally.**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
deno test --no-check --allow-read --allow-write --allow-env --allow-run packages/runner/src/__tests__/
```
Expected: all runner tests PASS (including the existing `runner_test.ts` via auto-build).

- [ ] **Step 5: Commit.**
```bash
git add .github/workflows/deno.yml packages/runner/src/__tests__/
git commit -m "ci: wire packages/runner tests into deno.yml; auto-build fixtures (no skip)"
```

---

## Task 8: Full verification (definition of done)

- [ ] **Step 1: Existing fixtures still green (no regression).**
```bash
cd /Users/sunny/work/yurtos/yurtos-kernel-pr129
deno test --no-check --allow-read --allow-write --allow-env --allow-run packages/runner/src/__tests__/runner_test.ts packages/kernel-host-interface-js/__tests__/
```
Expected: all PASS (the 8 existing fixtures + new tests).

- [ ] **Step 2: Lint/format/typecheck.**
```bash
deno fmt --check && deno lint && deno check 'packages/**/*.ts'
```
Expected: clean.

- [ ] **Step 3: Rust tests.**
```bash
cargo test --tests -p yurt-runtime-wasmtime 2>&1 | tail -15
cargo test --tests 2>&1 | tail -15
```
Expected: PASS incl. the new parity case.

- [ ] **Step 4: Push and verify PR #129 CI.**
```bash
git push origin claude/remove-typescript-kernel-CUcuf
gh pr checks 129 --watch
```
Expected: all checks green. If any job is red, it is NOT done — investigate (AGENTS.md). "Flaky" is not a resolution.

- [ ] **Step 5: Update the PR body checklist.** Mark Phase 2's multi-process driver (spawn/wait) landed; note fork is a separate PR per the spec. `gh pr edit 129 --body-file <updated>` (preserve the rest of the body).

---

## Self-review (completed by plan author)

- **Spec coverage:** spawn/wait wiring (T3,T4) ✓; flat iterative drain + kernel-pid binding + clean-return⇒0 (T3) ✓; `host_wait` EAGAIN→drain→retry + deno-normative decode (T4) ✓; signal-exit only `signal===0` arm exercised, full decode implemented (T4) ✓; re-entrancy depth guard (T4 S4, spec Risks) ✓; fixture single-child + `waitpid(pid)` (T2 S2) ✓; parent-stdout+exit observable contract, no child-stdout dependency (T2,T5) ✓; cross-host byte-parity oracle (T6) ✓; auto-build convention + CI wiring, no skip (T7) ✓; fork untouched/`-ENOSYS` (T4 S2) ✓; no-regression + CI-green (T8) ✓.
- **Placeholder scan:** the two genuinely-unverified byte contracts (SYS_SPAWN encoding, guest spawn/wait API) are pinned by an explicit discovery task (T1) with concrete deliverables and a "stop, don't guess" rule — not left as in-code TODOs. All code steps contain real code; the two T3/T4 helpers that depend on T1 reference the confirmed contract notes.
- **Type consistency:** `runPendingSpawns(kernel)` (engine) vs `runPendingSpawns()` (KernelHostInterface delegator) — distinct on purpose (T3 S4/S5); `PendingSpawn` fields `{childPid,wasmBytes,argv}` used consistently; `drainPendingProcess` 6th param threaded through `buildUserYurtImports`/`spawn()`/`spawnThread()` consistently.
