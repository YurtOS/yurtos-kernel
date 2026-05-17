# Async Worker-Host Dispatcher (Task 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL:
> superpowers:test-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Promote the worker-host dispatcher to an async, per-process-serialized
model so a dispatcher body can `await` mid-flight without freezing main's event
loop or letting a peer worker observe half-mutated kernel state — the final
layer of the worker-host deadlock chain (the post-bind ZMQ reactor stall
identified by PR74).

**Architecture:** `WorkerHostDispatcherBodies` methods become awaitable
(`T | Promise<T>`). `attachWorkerHostDispatcher`'s message handler becomes
async: it decodes the request, runs the body inside a per-process
`WorkerHostSerializer` (a Promise-chain mutex), then writes the SAB response and
`Atomics.notify`s. One serializer is shared across all worker pthreads of a
process (created in `defaultSpawnThread`), so kernel-state mutations stay
FIFO-serialized even though bodies may now suspend.

**Tech Stack:** Deno + TypeScript, SharedArrayBuffer + Atomics, existing
worker-host SAB protocol.

**Why this is the fix (code-traced):** libzmq 4.3.5 `tcp_listener.cpp:107→125`
calls `listen()` synchronously one statement after `bind()`. "bind ok, never
listen" ⇒ the heartbeat pthread is parked in a worker-host round-trip the
_synchronous_ dispatcher can't drain. `worker-bodies.ts:28-45` documents exactly
this remediation as "Task 10". Earlier layers (SabMutex/SabCondvar async, bridge
`requestSync` async, WASI `path_*` async-wrap) already landed.

**Verification note:** End-to-end cpython/pyzmq proof is blocked by an unrelated
WASI-SDK-33 toolchain gap (see `project-cpython-sdk33-blocker` memory). This
plan is verified by unit tests that exercise the documented reentrance invariant
directly.

---

## File Structure

- `packages/kernel/src/process/threads/worker-host-serializer.ts` (create) —
  `WorkerHostSerializer`: a Promise-chain mutex, `run<T>(fn) => Promise<T>`,
  rejection-isolated chain.
- `packages/kernel/src/process/threads/worker-host-proxy.ts` (modify) —
  `WorkerHostDispatcherBodies` return types → awaitable;
  `WorkerHostDispatcherContext` gains an optional `serializer?` override;
  `attachWorkerHostDispatcher` handler → async + serialized + awaits bodies; the
  per-process serializer defaults to one-per-`bodies`-object via a module
  `WeakMap` (`serializerForBodies`). **Design refinement:** keying the lock off
  the `bodies` identity already gives per-process scope
  (`makeWorkerDispatcherBodies` returns one `bodies` per process; every worker
  pthread attaches with it), so **no `worker-sab.ts` change is needed** —
  superseding the original Task 3 plumbing.
- `packages/kernel/src/process/threads/__tests__/worker-host-serializer_test.ts`
  (create) — serializer unit tests.
- `packages/kernel/src/process/threads/__tests__/worker-host-proxy_test.ts`
  (modify) — existing dispatcher tests `await` the now-async handler; add the
  reentrance-invariant test.

---

### Task 1: WorkerHostSerializer

**Files:**

- Create: `packages/kernel/src/process/threads/worker-host-serializer.ts`
- Test:
  `packages/kernel/src/process/threads/__tests__/worker-host-serializer_test.ts`

- [ ] **Step 1: Failing test** — serializes overlapping calls; a slow first call
      delays the second; rejection of one call does not break the chain;
      concurrent event-loop work still runs while a call awaits.
- [ ] **Step 2: Run, verify RED**
      (`deno test .../worker-host-serializer_test.ts` → fails: module missing).
- [ ] **Step 3: Implement** the Promise-chain mutex.
- [ ] **Step 4: Verify GREEN.**
- [ ] **Step 5: Commit.**

### Task 2: Awaitable bodies + async dispatcher

**Files:**

- Modify: `packages/kernel/src/process/threads/worker-host-proxy.ts`
- Test:
  `packages/kernel/src/process/threads/__tests__/worker-host-proxy_test.ts`

- [ ] **Step 1: Failing test** — reentrance invariant: two dispatchers sharing
      one serializer; worker A's body `await`s a deferred, worker B posts a sync
      host-call meanwhile. Assert (a) B's body does not execute until A's
      deferred resolves (serialization), (b) after resolve A's SAB result is the
      resolved value and then B is serviced (liveness — dispatcher drained, no
      deadlock), (c) an independent `Promise`/timer scheduled while A awaits did
      run (event loop not frozen).
- [ ] **Step 2: Verify RED** (sync dispatcher writes a coerced Promise + no
      serialization).
- [ ] **Step 3: Implement** — interface returns `T | Promise<T>`;
      `WorkerHostDispatcherContext.serializer?`; async handler awaits body
      inside `(context.serializer ?? new WorkerHostSerializer()).run(...)`.
- [ ] **Step 4: Migrate existing dispatcher tests** to `await invoke()` (handler
      now returns its processing promise).
- [ ] **Step 5: Verify GREEN** (whole `worker-host-proxy_test.ts` +
      `worker-bodies_test.ts` + `worker-thread-host_test.ts`).
- [ ] **Step 6: Commit.**

### Task 3: Per-process serializer default (per-`bodies`)

**Files:**

- Modify: `packages/kernel/src/process/threads/worker-host-proxy.ts`
  (`serializerForBodies` `WeakMap` default)
- Test:
  `packages/kernel/src/process/threads/__tests__/worker-host-proxy_test.ts`
  (per-process / shared-`bodies` serialization case)

**Refinement:** the original plan threaded a serializer through
`defaultSpawnThread`; instead the default serializer is keyed off the `bodies`
object identity (`WeakMap`). Since every worker pthread of a process attaches
with the same per-process `bodies` (from `makeWorkerDispatcherBodies` via
`defaultSpawnThread`), this yields the required per-process scope with **zero
`worker-sab.ts` / loader plumbing**, and stays overridable via
`context.serializer`.

- [x] **Step 1: Failing test** — two dispatchers, two SABs, same `bodies`, NO
      explicit serializer ⇒ bodies must be FIFO-serialized.
- [x] **Step 2: Verify RED** (per-attach `new WorkerHostSerializer()` let worker
      B's body run while A awaited).
- [x] **Step 3: Implement** — module `WeakMap<bodies, serializer>`;
      `context.serializer ?? serializerForBodies(bodies)`.
- [x] **Step 4: Verify GREEN** (58 threads/bodies tests pass; `deno
      check`
      clean on proxy + worker-bodies + worker-sab ripple).
- [ ] **Step 5: Full local gate** (changed-file fmt/lint/check + the kernel unit
      suite guest-compat runs).
- [ ] **Step 6: Commit.**
