# Worker-SAB pthread runtime (kernel side) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `CooperativeSerialBackend`'s single-threaded JS event-loop deadlock with a real `WorkerSabThreadsBackend` that hosts each `pthread_create` in a new Worker against a `SharedArrayBuffer`-backed `WebAssembly.Memory`, with mutex/condvar primitives synchronised via `Atomics.wait`/`notify`. This is the load-bearing kernel-side gate that today blocks libzmq's I/O reactor (and therefore `IPKernelApp.initialize()` in Jupyter).

**Architecture:** Each call to `host_thread_spawn(fnPtr, arg)` posts a `start` message to a new `Worker` running `worker-thread-host.ts`. The worker instantiates the *same* `WebAssembly.Module` against the *same* `WebAssembly.Memory` (whose buffer is a `SharedArrayBuffer`), looks up `fnPtr` in `__indirect_function_table`, calls it with `arg`, and posts back its return value. Mutex/condvar are SAB-backed `i32` cells synchronised with `Atomics.wait`/`Atomics.notify`. `host_thread_self()` returns the worker tid captured by the worker host's import closures; the main thread returns tid `0`. Host imports that mutate shared kernel state (fd table, listener registry) gain a coarse mutex around the critical sections; worker-side host imports proxy through `postMessage` into the main thread using typed operation ids plus fixed binary argument/result cells, never JSON at the guest↔kernel boundary.

**Tech Stack:** TypeScript on Deno + Node `worker_threads`, WebAssembly shared memory + `WebAssembly.Module.imports/exports`, `Atomics.wait`/`Atomics.notify`/`Atomics.load`/`Atomics.store`/`Atomics.compareExchange`, `yurt-cc` for the C pthread canary build.

---

## Scope

**IN scope (this plan, this PR):**
- SAB+Atomics implementation of `mutexLock`/`mutexUnlock`/`mutexTryLock`/`condWait`/`condSignal`/`condBroadcast` in `WorkerSabThreadsBackend`.
- New `worker-thread-host.ts` Worker-side bootstrap that instantiates a cloned WASM instance against shared memory.
- `LoadProcessOptions.workerSabThreads` constructed by the loader from `profile`, and a `SharedArrayBuffer`-backed `WebAssembly.Memory` threaded through the `workerSabMemory` option.
- Per-thread `host_thread_self()` via worker-local tid capture in the worker host import closures; main-thread calls return tid `0`.
- Coarse-grained lock around kernel-side state mutations in `kernel-imports.ts` that worker threads can reach (`host_socket_*`, `host_thread_*`, `host_mutex_*`, `host_cond_*`).
- A new C pthread canary that spawns ≥4 worker threads, contends on a shared mutex, signals via condvar, and asserts the counter.
- `abi_test.ts` step that loads the canary and verifies it exits 0.

**OUT of scope (follow-up plans):**
- Rebuilding `cpython3.wasm` with `yurt.features threads`, shared memory imports, and `_thread`/posix threads enabled. Lives in `yurt-ports/ports/cpython` and is gated on this plan landing. Will be tracked as `docs/superpowers/plans/2026-05-XX-cpython-threads.md` once this PR merges.
- libzmq's I/O reactor working end-to-end (depends on the cpython rebuild).
- Full Jupyter `BlockingKernelClient` `execute_request` round-trip (depends on both of the above).

---

## File Structure

**Create:**
- `packages/kernel/src/process/threads/worker-thread-host.ts` (~120 LOC) — Worker entry point. Receives `start({tid, fnPtr, arg, module, memory, importProxy})`, instantiates, calls table entry, posts back result.
- `packages/kernel/src/process/threads/worker-host-proxy.ts` (~180 LOC) — Main-thread dispatcher and worker-side typed binary proxy helpers for host imports reachable from Workers. No `JSON.parse`/`JSON.stringify`.
- `packages/kernel/src/process/threads/sab-primitives.ts` (~140 LOC) — Pure SAB+Atomics mutex and condvar implementation. No Worker code; just the lock cell layout and the wait/notify dance. Reusable on both sides.
- `packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts` (~150 LOC) — Tests the mutex/condvar with a real `Worker` doing concurrent acquires.
- `packages/kernel/src/process/threads/__tests__/worker-thread-host_test.ts` (~80 LOC) — Tests the worker bootstrap end-to-end with a minimal threaded WASM canary.
- `abi/conformance/c/pthread-multi-canary.c` (~80 LOC) — New canary: 4 threads, shared counter under mutex, condvar barrier.
- `abi/conformance/pthread-multi.spec.toml` (~10 LOC) — Conformance descriptor.

**Modify:**
- `packages/kernel/src/process/threads/worker-sab.ts` — Replace JS-async mutex/condvar with SAB-backed versions from `sab-primitives.ts`. Wire `spawnThread` default to the new Worker host.
- `packages/kernel/src/process/threads/backend-factory.ts` — Default-construct a `WorkerSabThreadsBackendOptions` if caller didn't supply one, using `worker-thread-host.ts`.
- `packages/kernel/src/process/loader.ts:135` — Construct `workerSabThreads` for threaded profiles; allocate `SharedArrayBuffer`-backed `WebAssembly.Memory` when `profile.requiresSharedMemory && profile.memoryImport`.
- `packages/kernel/src/sandbox.ts` — Pass `workerSabAvailable` and the per-process workerSab options into `loadProcess`.
- `packages/kernel/src/host-imports/kernel-imports.ts` — Export a reusable import dispatch surface for `worker-host-proxy.ts`; wrap the kernel-state-mutating bodies of socket/thread/mutex/cond imports in a mutex acquired before entry and released on return.
- `abi/conformance/c/pthread-canary.c:8` — Bump `NUM_THREADS` from `1` to `4` (existing canary).
- `abi/Makefile` — Add `pthread-multi-canary` to `CANARY_NAMES`.
- `packages/kernel/src/__tests__/abi_test.ts` — New step covering pthread-multi-canary; uplift the existing `runs the pthread-canary single-thread compatibility test` to assert NUM_THREADS=4.

---

## Phase 1: SAB-backed mutex/condvar primitives

### Task 1: Lock cell layout + atomic mutexLock

**Files:**
- Create: `packages/kernel/src/process/threads/sab-primitives.ts`
- Test: `packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts`

- [ ] **Step 1: Write the failing test (single-thread fast path)**

```ts
// packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts
import { assertEquals } from "@std/assert";
import { SabMutex } from "../sab-primitives.ts";

Deno.test("SabMutex: uncontended lock takes ownership and unlock releases it", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);

  assertEquals(m.tryLock(1), true);
  assertEquals(m.owner(), 1);
  m.unlock(1);
  assertEquals(m.owner(), 0);
});

Deno.test("SabMutex: tryLock fails when held by another tid", () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  m.tryLock(1);
  assertEquals(m.tryLock(2), false);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
deno test --no-check packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts
```

Expected: `error: Module not found "sab-primitives.ts"`.

- [ ] **Step 3: Implement `SabMutex` (cell layout + tryLock/unlock/owner)**

Lock cell layout: one `i32` (4 bytes) at `byteOffset`. Value `0` = unlocked, `tid > 0` = locked by that tid. Use `Atomics.compareExchange` for `tryLock` (CAS 0→tid). `unlock` writes 0 and `Atomics.notify(..., 1)`.

```ts
// packages/kernel/src/process/threads/sab-primitives.ts
export class SabMutex {
  static readonly BYTES = 4;
  private readonly view: Int32Array;
  constructor(sab: SharedArrayBuffer, byteOffset: number) {
    this.view = new Int32Array(sab, byteOffset, 1);
  }

  tryLock(tid: number): boolean {
    return Atomics.compareExchange(this.view, 0, 0, tid) === 0;
  }

  unlock(tid: number): void {
    if (Atomics.compareExchange(this.view, 0, tid, 0) !== tid) {
      throw new Error("SabMutex.unlock: not the owner");
    }
    Atomics.notify(this.view, 0, 1);
  }

  owner(): number {
    return Atomics.load(this.view, 0);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
deno test --no-check packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts
```

Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/process/threads/sab-primitives.ts \
        packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts
git commit -m "feat(threads): SabMutex lock cell with CAS tryLock/unlock"
```

### Task 2: Blocking `lock(tid)` via `Atomics.wait`

**Files:**
- Modify: `packages/kernel/src/process/threads/sab-primitives.ts`
- Modify: `packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts`

- [ ] **Step 1: Write the cross-Worker test**

```ts
// add to sab-primitives_test.ts
import { assertEquals } from "@std/assert";

Deno.test("SabMutex: lock() from a Worker blocks until main unlocks", async () => {
  const sab = new SharedArrayBuffer(SabMutex.BYTES);
  const m = new SabMutex(sab, 0);
  m.tryLock(1);  // main holds it as tid 1

  const workerCode = `
    self.onmessage = (e) => {
      const { sab } = e.data;
      const view = new Int32Array(sab, 0, 1);
      // CAS-loop blocking lock with tid = 2
      while (Atomics.compareExchange(view, 0, 0, 2) !== 0) {
        Atomics.wait(view, 0, Atomics.load(view, 0));
      }
      self.postMessage("locked");
    };
  `;
  const worker = new Worker(
    URL.createObjectURL(new Blob([workerCode], { type: "application/javascript" })),
    { type: "module" },
  );
  worker.postMessage({ sab });

  // Worker should be blocked. Wait a tick, then release.
  await new Promise((r) => setTimeout(r, 50));
  m.unlock(1);

  const got = await new Promise<string>((resolve) => {
    worker.onmessage = (e) => resolve(e.data);
  });
  assertEquals(got, "locked");
  assertEquals(m.owner(), 2);
  worker.terminate();
});
```

- [ ] **Step 2: Run the test, verify it fails**

It will pass already because the worker has its own inlined CAS-loop. So this test is really a baseline — it proves the SAB primitive works across Workers before we abstract it into a `lock()` method. Run it to confirm green, then proceed.

```bash
deno test --no-check --allow-read --allow-net packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 3: Add `lock(tid)` method that encapsulates the CAS+wait loop**

```ts
// in sab-primitives.ts
lock(tid: number): void {
  while (true) {
    const prev = Atomics.compareExchange(this.view, 0, 0, tid);
    if (prev === 0) return;
    Atomics.wait(this.view, 0, prev);
  }
}
```

- [ ] **Step 4: Update the test to call `m.lock(2)` directly inside the worker** (replace the inlined CAS loop). Worker imports become a problem here — the simplest path is to ship the worker code as a string that re-implements the loop inline, OR refactor the worker into a real file. Use the file path option:

Create `packages/kernel/src/process/threads/__tests__/_fixtures/lock-worker.ts`:

```ts
import { SabMutex } from "../../sab-primitives.ts";
self.onmessage = (e: MessageEvent) => {
  const { sab } = e.data;
  const m = new SabMutex(sab, 0);
  m.lock(2);
  (self as unknown as Worker).postMessage("locked");
};
```

Update the test to `new Worker(new URL("./_fixtures/lock-worker.ts", import.meta.url).href, { type: "module" })`.

- [ ] **Step 5: Run, verify pass, commit**

```bash
deno test --no-check --allow-read --allow-net packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts
git add packages/kernel/src/process/threads/sab-primitives.ts \
        packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts \
        packages/kernel/src/process/threads/__tests__/_fixtures/lock-worker.ts
git commit -m "feat(threads): SabMutex.lock() blocks across Workers via Atomics.wait"
```

### Task 3: `SabCondvar` — wait/signal/broadcast

**Files:**
- Modify: `packages/kernel/src/process/threads/sab-primitives.ts`
- Modify: `packages/kernel/src/process/threads/__tests__/sab-primitives_test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/kernel/src/process/threads/__tests__/_fixtures/condvar-worker.ts`:

```ts
import { SabCondvar, SabMutex } from "../../sab-primitives.ts";

self.onmessage = (e: MessageEvent) => {
  const { sab, tid, mutexOffset, condOffset, readyOffset } = e.data;
  const m = new SabMutex(sab, mutexOffset);
  const cv = new SabCondvar(sab, condOffset);
  const ready = new Int32Array(sab, readyOffset, 1);
  m.lock(tid);
  Atomics.add(ready, 0, 1);
  Atomics.notify(ready, 0);
  cv.wait(m, tid);
  m.unlock(tid);
  (self as unknown as Worker).postMessage(tid);
};
```

Add this test body to `sab-primitives_test.ts`:

```ts
Deno.test("SabCondvar: broadcast wakes all waiters", async () => {
  const mutexOffset = 0;
  const condOffset = SabMutex.BYTES;
  const readyOffset = SabMutex.BYTES + SabCondvar.BYTES;
  const sab = new SharedArrayBuffer(readyOffset + 4);
  const m = new SabMutex(sab, mutexOffset);
  const cv = new SabCondvar(sab, condOffset);
  const ready = new Int32Array(sab, readyOffset, 1);
  const makeWorker = (tid: number) => {
    const worker = new Worker(
      new URL("./_fixtures/condvar-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    const done = new Promise<number>((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
    });
    worker.postMessage({ sab, tid, mutexOffset, condOffset, readyOffset });
    return { worker, done };
  };

  const w2 = makeWorker(2);
  const w3 = makeWorker(3);
  while (Atomics.load(ready, 0) < 2) {
    Atomics.wait(ready, 0, Atomics.load(ready, 0), 100);
  }

  m.lock(1);
  cv.broadcast();
  m.unlock(1);

  assertEquals((await Promise.all([w2.done, w3.done])).sort(), [2, 3]);
  w2.worker.terminate();
  w3.worker.terminate();
});
```

- [ ] **Step 2: Run, verify it fails (`SabCondvar not defined`)**

- [ ] **Step 3: Implement `SabCondvar`**

Cell layout: one `i32` (seq counter) at `byteOffset`. `wait(m, tid)`:
1. Atomically read seq.
2. Unlock the mutex.
3. `Atomics.wait(seqView, 0, snapshot)` — blocks until signal/broadcast bumps the seq.
4. Re-lock the mutex.

`signal()`: `Atomics.add(seqView, 0, 1); Atomics.notify(seqView, 0, 1);`
`broadcast()`: `Atomics.add(seqView, 0, 1); Atomics.notify(seqView, 0, Number.MAX_SAFE_INTEGER);`

```ts
export class SabCondvar {
  static readonly BYTES = 4;
  private readonly view: Int32Array;
  constructor(sab: SharedArrayBuffer, byteOffset: number) {
    this.view = new Int32Array(sab, byteOffset, 1);
  }
  wait(m: SabMutex, tid: number): void {
    const seq = Atomics.load(this.view, 0);
    m.unlock(tid);
    Atomics.wait(this.view, 0, seq);
    m.lock(tid);
  }
  signal(): void {
    Atomics.add(this.view, 0, 1);
    Atomics.notify(this.view, 0, 1);
  }
  broadcast(): void {
    Atomics.add(this.view, 0, 1);
    Atomics.notify(this.view, 0, Number.MAX_SAFE_INTEGER);
  }
}
```

- [ ] **Step 4: Run, verify it passes**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(threads): SabCondvar wait/signal/broadcast"
```

---

## Phase 2: Worker host script

### Task 4: `worker-thread-host.ts` — instantiate cloned module + call fnPtr

**Files:**
- Create: `packages/kernel/src/process/threads/worker-thread-host.ts`
- Test: `packages/kernel/src/process/threads/__tests__/worker-thread-host_test.ts`

- [ ] **Step 1: Build a minimal threaded WASM fixture as the test target**

The fixture is a hand-written WAT module that imports a shared memory and exports a single function `worker_entry(arg: i32) -> i32` that returns `arg + 1`. Use the existing toolchain:

```wat
;; packages/kernel/src/process/threads/__tests__/_fixtures/echo-thread.wat
(module
  (import "env" "memory" (memory 1 1 shared))
  (func (export "worker_entry") (param $arg i32) (result i32)
    local.get $arg
    i32.const 1
    i32.add)
  (table (export "__indirect_function_table") 1 funcref)
  (elem (i32.const 0) $worker_entry_ref)
  (func $worker_entry_ref (param $arg i32) (result i32)
    local.get $arg
    i32.const 1
    i32.add))
```

Build to `.wasm` once with `wat2wasm` (binaryen tool) and check it in as a fixture. Skip if `wat2wasm` is unavailable — note in the test that it requires the binaryen toolchain.

- [ ] **Step 2: Write the failing test**

```ts
Deno.test("worker-thread-host: instantiates module and calls fnPtr", async () => {
  const wasmBytes = await Deno.readFile(
    new URL("./_fixtures/echo-thread.wasm", import.meta.url),
  );
  const module = await WebAssembly.compile(wasmBytes);
  const memory = new WebAssembly.Memory({
    initial: 1, maximum: 1, shared: true,
  });

  const worker = new Worker(
    new URL("../worker-thread-host.ts", import.meta.url).href,
    { type: "module" },
  );
  const result = await new Promise<number>((resolve) => {
    worker.onmessage = (e) => resolve(e.data.retval);
    worker.postMessage({
      type: "start", tid: 2, fnPtr: 0, arg: 41, module, memory,
    });
  });
  assertEquals(result, 42);
  worker.terminate();
});
```

- [ ] **Step 3: Implement `worker-thread-host.ts`**

```ts
// packages/kernel/src/process/threads/worker-thread-host.ts
import {
  createWorkerYurtImports,
  type WorkerHostImportProxy,
} from "./worker-host-proxy.ts";

interface StartMessage {
  type: "start";
  tid: number;
  fnPtr: number;
  arg: number;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  importProxy?: WorkerHostImportProxy;
}

self.onmessage = async (e: MessageEvent<StartMessage>) => {
  if (e.data.type !== "start") return;
  const { tid, fnPtr, arg, module, memory, importProxy } = e.data;

  // Instantiate the same module against the shared memory.
  const instance = await WebAssembly.instantiate(module, {
    env: { memory },
    yurt: importProxy ? createWorkerYurtImports(tid, memory, importProxy) : {},
  });
  const table = instance.exports.__indirect_function_table as WebAssembly.Table;
  const fn = table.get(fnPtr) as ((arg: number) => number) | null;
  if (!fn) {
    (self as unknown as Worker).postMessage({ type: "done", tid, retval: -1 });
    return;
  }
  const retval = fn(arg);
  (self as unknown as Worker).postMessage({ type: "done", tid, retval });
};
```

- [ ] **Step 4: Run, verify it passes**

```bash
deno test --no-check --allow-read packages/kernel/src/process/threads/__tests__/worker-thread-host_test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(threads): worker-thread-host bootstraps cloned WASM instance"
```

### Task 5: Wire `worker-thread-host` into `WorkerSabThreadsBackend.spawn`

**Files:**
- Modify: `packages/kernel/src/process/threads/worker-sab.ts`
- Modify: `packages/kernel/src/process/threads/__tests__/worker-sab_test.ts`

- [ ] **Step 1: Re-read the existing `worker-sab.ts` body (current state at HEAD)** to confirm `WorkerSabThreadsBackendOptions.spawnThread` is the right injection point.

- [ ] **Step 2: Add a `defaultSpawnThread` helper** that constructs a `Worker` against `worker-thread-host.ts` and returns a `Promise<number>` resolving to the worker's `retval`. Default `WorkerSabThreadsBackendOptions` to use it when omitted.

```ts
// in worker-sab.ts
export function defaultSpawnThread(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
): WorkerSabThreadsBackendOptions["spawnThread"] {
  const hostUrl = new URL("./worker-thread-host.ts", import.meta.url).href;
  return ({ tid, fnPtr, arg }) => new Promise<number>((resolve) => {
    const worker = new Worker(hostUrl, { type: "module" });
    worker.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "done") {
        resolve(e.data.retval as number);
        worker.terminate();
      }
    };
    worker.postMessage({ type: "start", tid, fnPtr, arg, module, memory });
  });
}
```

- [ ] **Step 3: Update `WorkerSabThreadsBackend` to use the SAB-backed mutex/condvar from `sab-primitives.ts`** (replace the existing in-process JS `MutexState`/`CondvarState`). Each `mutexPtr` becomes a SAB byte offset — the loader will hand the backend a SAB region. For now, accept the SAB through the constructor:

```ts
constructor(
  private readonly options: WorkerSabThreadsBackendOptions,
  private readonly primitivesSab: SharedArrayBuffer,
) {}
```

Implement `mutexLock`/`Unlock`/`TryLock` as `new SabMutex(this.primitivesSab, mutexPtr).lock(this.self())` etc.

- [ ] **Step 4: Update existing tests** in `worker-sab_test.ts` to pass a `new SharedArrayBuffer(64 * 1024)` for `primitivesSab`.

- [ ] **Step 5: Run all threads tests, verify green; commit**

```bash
deno test --no-check --allow-read packages/kernel/src/process/threads/
git commit -am "feat(threads): WorkerSabThreadsBackend uses SAB primitives + Worker host"
```

---

## Phase 3: Loader wiring

### Task 6: Allocate shared `WebAssembly.Memory` for threaded profiles

**Files:**
- Modify: `packages/kernel/src/process/loader.ts:135-160`
- Test: `packages/kernel/src/process/__tests__/loader_test.ts`

- [ ] **Step 1: Write a failing test** that loads the echo-thread fixture and asserts the loader instantiates against shared memory:

```ts
Deno.test("loader: threaded module gets SharedArrayBuffer-backed memory", async () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeThreadedImportedSharedMemoryModule()),
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
    workerSabAvailable: true,
    workerSabMemory: memory,
    workerSabThreads: {
      spawnThread: () => Promise.resolve(0),
    },
  });

  assertEquals(proc.memory, memory);
  assertEquals(proc.memory?.buffer instanceof SharedArrayBuffer, true);
  await proc.terminate();
});
```

- [ ] **Step 2: Run, verify failure (no SAB allocation today)**

- [ ] **Step 3: Implement in `loader.ts`**

After `validateYurtModuleProfile(...)`, when `profile.requiresSharedMemory && profile.memoryImport`, allocate:

```ts
let workerSabMemory = opts.workerSabMemory;
if (profile.requiresSharedMemory && profile.memoryImport && !workerSabMemory) {
  workerSabMemory = new WebAssembly.Memory({
    initial: 16, maximum: 16384, shared: true,
  });
}
```

Build `workerSabThreads` from a new `defaultSpawnThread(module, workerSabMemory)`. Pass both into `createThreadsBackend`.

- [ ] **Step 4: Run, verify pass; commit**

### Task 7: Hand a SAB-backed primitives region to `WorkerSabThreadsBackend`

**Files:**
- Modify: `packages/kernel/src/process/loader.ts`
- Modify: `packages/kernel/src/process/threads/backend-factory.ts`
- Modify: `packages/kernel/src/process/threads/worker-sab.ts`

- [ ] **Step 1: Reuse the shared linear memory for mutex/condvar cells.** Wasm-side pthread.h structs (`pthread_mutex_t`) are 4-byte aligned regions inside the WASM linear memory. The pointers passed to `host_mutex_lock(mutexPtr)` etc. are already linear-memory addresses, and the linear memory is SAB-backed. So `WorkerSabThreadsBackend.mutexLock(ptr)` should construct `new SabMutex(memory.buffer as SharedArrayBuffer, ptr)`. No separate primitives SAB needed.

- [ ] **Step 2: Drop the `primitivesSab` constructor arg added in Task 5;** instead the backend holds a reference to the shared memory and constructs `SabMutex`/`SabCondvar` views per-call.

- [ ] **Step 3: Update factory + loader** to pass `workerSabMemory` into `WorkerSabThreadsBackend` so it can derive views.

- [ ] **Step 4: Re-run threads tests, fix call sites, commit.**

### Task 8: `host_thread_self()` — per-thread tid

**Files:**
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/kernel/src/process/threads/worker-sab.ts`

- [ ] **Step 1: Failing test** — spawn 2 workers via the backend, each calls `host_thread_self()` (a stub indirect call exposed for testing), assert they return different tids.

- [ ] **Step 2: Implement.** The current `WorkerSabThreadsBackend.self()` uses `ThreadIdScope` which is JS-async-context scoped — it is only meaningful inside the main JS isolate. Keep it for main-thread compatibility, but make the Worker path independent of async context: the `start` message carries `tid`, and `createWorkerYurtImports(tid, memory, importProxy)` closes over that tid when implementing `host_thread_self`.

For *main-thread* `self()`, return 0 (main is always tid 0). Worker-side `self()` is implemented in the worker host script's closure.

- [ ] **Step 3: Run, verify pass; commit.**

---

## Phase 4: Host-import thread safety

### Task 9: Audit which host imports worker threads can reach

**Files:**
- Create: `packages/kernel/src/process/threads/worker-host-proxy.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/kernel/src/process/threads/worker-thread-host.ts`

- [ ] **Step 1: Route worker-side host imports through `postMessage` back to main.** Workers cannot directly call into `kernel-imports.ts` closures (those live in the main JS context). Instead, `createWorkerYurtImports(tid, memory, importProxy)` provides stub imports that send `{ type: "host-call", op, request }` messages to main and `Atomics.wait` on a per-thread response SAB. Main has a `message` handler that dispatches into the existing import bodies and writes the response.

- [ ] **Step 2: Build the per-thread request/response SAB** (one per worker, allocated when the worker is spawned). Layout: 8 bytes header (status, length) + 4096 bytes payload. Worker writes request, calls `Atomics.notify`, then `Atomics.wait`s on response status.

- [ ] **Step 3: Add a typed binary request/response codec. Do not use JSON.** Encode the operation id and scalar arguments in fixed `i32` slots, and pass byte payloads by copying from the worker's shared linear memory into the request payload region. Start with the worker-reachable imports needed by pthread canaries and pyzmq bootstrap:

```ts
export const enum WorkerHostOp {
  ThreadSelf = 1,
  ThreadYield = 2,
  ThreadExit = 3,
  WriteFd = 10,
  ReadFd = 11,
  SocketOpen = 20,
  SocketClose = 21,
  SocketRecv = 22,
  SocketSend = 23,
}

export interface WorkerHostImportProxy {
  requestSab: SharedArrayBuffer;
  postHostCall(op: WorkerHostOp): void;
}
```

Request payload layout:

```text
header[0] status: 0 idle, 1 request-ready, 2 response-ready, -1 error
header[1] errno_or_result
payload[0..3] op
payload[4..7] argc
payload[8..] fixed i32 args, followed by copied byte payload when needed
```

`host_write_fd(fd, ptr, len)` writes `{ op=WriteFd, argc=3, fd, ptr, len }`, copies `memory.buffer[ptr..ptr+len]` after the fixed args, and the main dispatcher calls the existing `host_write_fd` body with the original pid/kernel state.

- [ ] **Step 4: Write a test** that spawns a worker, has it call `host_write_fd(1, "hello")`, asserts main's fd 1 received "hello".

- [ ] **Step 5: Implement; verify; commit.**

### Task 10: Coarse-grained main-thread lock around mutating import bodies

**Files:**
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`

- [ ] **Step 1:** Add a `kernelMutex` (a plain JS `Promise`-chain semaphore — not SAB-backed; main-side only). Every import body that mutates `opts.kernel.fdTable`/`opts.kernel.processMap`/`socketBackend.registry` awaits it.

- [ ] **Step 2: Test** — two workers concurrently call `host_socket_open(...)`, assert no fd collisions.

- [ ] **Step 3: Implement; verify; commit.**

---

## Phase 5: Multi-thread C canary verification

### Task 11: Bump existing pthread-canary to NUM_THREADS=4

**Files:**
- Modify: `abi/conformance/c/pthread-canary.c:8`
- Modify: `packages/kernel/src/__tests__/abi_test.ts` (the assertion bumps to 4 × ITERS_PER_THREAD)

- [ ] **Step 1: Edit `pthread-canary.c`**

```c
#define NUM_THREADS 4
```

- [ ] **Step 2: Rebuild canaries**

```bash
make -C abi all copy-fixtures
```

- [ ] **Step 3: Update the test fixture assertion**

```ts
// in abi_test.ts where the canary's stdout is parsed
expect(counter).toBe(4 * 10000);  // was 1 * 10000
```

- [ ] **Step 4: Run, verify the test now exercises 4-way mutex contention end-to-end**

```bash
deno test --allow-all --no-check packages/kernel/src/__tests__/abi_test.ts
```

- [ ] **Step 5: Commit**

```bash
git add abi/conformance/c/pthread-canary.c \
        packages/kernel/src/platform/__tests__/fixtures/pthread-canary.wasm \
        packages/kernel/src/__tests__/abi_test.ts
git commit -m "test(threads): pthread-canary NUM_THREADS=4 via Worker/SAB backend"
```

### Task 12: New `pthread-multi-canary.c` — condvar barrier

**Files:**
- Create: `abi/conformance/c/pthread-multi-canary.c`
- Create: `abi/conformance/pthread-multi.spec.toml`
- Modify: `abi/Makefile`
- Modify: `packages/kernel/src/__tests__/abi_test.ts`

- [ ] **Step 1: Write the canary**

```c
// abi/conformance/c/pthread-multi-canary.c
#include <pthread.h>
#include <stdio.h>

#define N 4
static int ready;
static pthread_mutex_t lk = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;

static void *waiter(void *arg) {
  pthread_mutex_lock(&lk);
  while (!ready) pthread_cond_wait(&cv, &lk);
  pthread_mutex_unlock(&lk);
  return arg;
}

int main(void) {
  pthread_t t[N];
  for (int i = 0; i < N; i++) pthread_create(&t[i], NULL, waiter, (void*)(long)i);
  pthread_mutex_lock(&lk);
  ready = 1;
  pthread_cond_broadcast(&cv);
  pthread_mutex_unlock(&lk);
  for (int i = 0; i < N; i++) {
    void *r;
    pthread_join(t[i], &r);
    if ((long)r != i) { printf("FAIL: %d != %ld\n", i, (long)r); return 1; }
  }
  printf("OK\n");
  return 0;
}
```

- [ ] **Step 2: Add to `abi/Makefile` CANARY_NAMES**

- [ ] **Step 3: Add abi_test.ts step**

```ts
await t.step("runs the pthread-multi-canary condvar barrier", async () => {
  const result = await runCanary("pthread-multi-canary.wasm");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("OK");
});
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
make -C abi all copy-fixtures
deno test --allow-all --no-check packages/kernel/src/__tests__/abi_test.ts
git add abi/conformance/c/pthread-multi-canary.c \
        abi/conformance/pthread-multi.spec.toml \
        abi/Makefile \
        packages/kernel/src/__tests__/abi_test.ts \
        packages/kernel/src/platform/__tests__/fixtures/pthread-multi-canary.wasm
git commit -m "test(threads): pthread-multi-canary covers condvar broadcast under contention"
```

### Task 13: Verification suite, full local gate, push

- [ ] **Step 1: Local gate**

```bash
make -C abi all
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --tests
deno fmt --check $IMAGE_RUNTIME_FILES
deno lint --rules-exclude=no-import-prefix,no-sloppy-imports,require-await $IMAGE_RUNTIME_FILES
deno check $IMAGE_RUNTIME_FILES
deno test --allow-all --no-check packages/kernel/src/process/threads/
deno test --allow-all --no-check packages/kernel/src/__tests__/abi_test.ts
deno test --allow-all --no-check packages/kernel/src/process/__tests__/loader_test.ts
```

- [ ] **Step 2: Push branch + open PR.** PR body lists what's in scope, what's deferred (cpython rebuild + Jupyter end-to-end), and links the follow-up plans.

- [ ] **Step 3: After PR review, write the follow-up plan** at `docs/superpowers/plans/2026-05-XX-cpython-threads.md` covering the yurt-ports/ports/cpython rebuild with `yurt.features.threads`, shared memory imports, `Setup.local` enabling `_thread`, and the pyzmq rebuild against the threaded interpreter.

---

## Self-Review Checklist

- [ ] **Spec coverage:** Every IN-scope item maps to a task: SAB mutex (Tasks 1-2), SAB condvar (Task 3), Worker host script (Task 4), `spawnThread` wiring (Task 5), shared memory in loader (Task 6), backend ↔ shared memory (Task 7), `host_thread_self` (Task 8), worker-side host imports (Task 9), main-thread lock (Task 10), 4-thread canary (Task 11), condvar canary (Task 12), full gate + push (Task 13). All present.
- [ ] **Placeholder scan:** No placeholder markers, incomplete test bodies, or open codec choices remain. Task 3 includes a concrete condvar Worker fixture and test body. Task 9 names the initial worker-reachable import set and fixes the request/response channel to a typed binary layout with no JSON.
- [ ] **Type consistency:** `SabMutex`/`SabCondvar` constructor signatures consistent across Tasks 1-7. `WorkerSabThreadsBackendOptions.spawnThread` matches the type in the existing `worker-sab.ts` (file at HEAD). `LoadProcessOptions.workerSabThreads` matches the existing field added in PR #37. `WorkerHostImportProxy` is introduced before `worker-thread-host.ts` depends on it.
- [ ] **Validation:** Each phase has a runnable test that exits 0 before proceeding to the next phase. Final task runs the full local gate.

---

## Follow-up plans (not in this PR)

1. **`2026-05-XX-cpython-threads.md`** (yurt-ports) — rebuild cpython 3.14.4 with `yurt.features.threads` custom section, `--enable-shared-memory`, `_thread` module enabled in `Setup.local` calling through to `host_thread_*`, and a yurt-cc flag (`YURT_CC_USE_THREADS=1`) that emits the marker. Plus a pyzmq rebuild against the threaded interpreter.

2. **`2026-05-XX-jupyter-end-to-end.md`** — after cpython lands, bump the `ipykernel-launch-dry-run.py` to call `IPKernelApp.initialize()` with default `IO_THREADS=1` (no longer `0`), assert it actually binds 5 TCP sockets through yurt-loopback, and run a `BlockingKernelClient` `execute_request("1+1")` against the live kernel. Touches `yurt-jupyter` repo's smoke + this kernel's `jupyter_smoke_test.ts`.
