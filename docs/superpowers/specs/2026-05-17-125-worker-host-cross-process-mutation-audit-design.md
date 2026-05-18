# #125 — Audit: cross-process kernel-state mutations across `await` in the worker-host dispatcher

**Status:** Audit complete — decision below. No code change required now; one regression test + one forward-looking invariant recommended.

**Refs:** PR #119 (Task 10 per-process `WorkerHostSerializer`), #124 (watchdog), #162 (async `socketListen`).

## Question (from #125)

Task 10's serializer is **per-process** (`serializersByBodies` `WeakMap`, keyed by the `bodies` closure identity — `worker-host-proxy.ts:511-527`). Pre-Task-10 the synchronous dispatcher serialized **all** host-call handlers globally via JS run-to-completion. Now, once any body `await`s, two *different* processes' bodies can interleave on shared kernel state (`kernel: ProcessKernel`, the global socket / port / loopback-route tables). Audit which mutations cross an `await` and touch global state; decide whether a global serialization tier is needed.

## Method

Enumerated every `WorkerHostOp` body in `packages/kernel/src/host-imports/worker-bodies.ts` (the dispatched closures) and classified each by (a) does it contain an `await` / return a Promise, and (b) does its post-await continuation mutate process-global kernel state.

## Findings

### 1. All socket ops except `socketListen` are synchronous by construction

`requireSyncSocketResult` (`worker-bodies.ts:83-93`) actively **rejects** a Promise result from the socket backend (`"worker dispatcher cannot await async socket backend"`). Consequently `socketOpen`, `socketClose`, `socketSend`, `socketRecv`, `socketSendUnix`, `socketRecvUnix`, `socketBind`, `socketIsDgram`, `setFdDescriptorFlags`, `poll`, `getPid`, `threadYield`, `threadExit`, `writeFd`, `readFd` execute **start-to-finish in a single JS turn**. They mutate global kernel tables (e.g. `socketOpen` → `allocInetStreamSocket(kernel, …)`, `socketBind` → `target.bound*`), but with **no `await` between read and write**, so JS run-to-completion still globally serializes them regardless of the per-process serializer. **No cross-process interleave is possible for these.**

### 2. `socketListen` is the sole body that awaits across a global mutation

`socketListen` (`worker-bodies.ts:409-492`) is async only on the #162 path where `opts.socketBackend.listen()` returns a Promise; it then `.then(apply, failListen)`. `apply` writes `target.listener/boundHost/boundPort/localHost/localPort/closeListener` and the backend registers the listener in the **global loopback-route / ephemeral-port registry**.

Mitigations already present:

- **Per-process fd TOCTOU re-check:** `apply` re-validates `kernel.getFdTarget(getPid(), fd) !== target` *after* the await (line 435) and bails `-EBADF` (closing the freshly-created listener) if the fd was closed/reused for this process during the await.
- **Atomic continuation:** all of `apply`'s global writes happen **synchronously within one JS turn** (no `await` inside the mutation). The only interleave window is *between* two `listen` awaits, never *within* one body's mutation.

### 3. `threadSpawn` does not mutate global state across an await

`threadSpawn` only *attaches* a dispatcher listener (consistent with the `WorkerHostSerializer` "no re-entrancy" note); it does not re-enter `run` nor await across a global-table write.

## Decision

**A global serializer tier is NOT required today.** Rationale:

1. The cross-process interleave surface is exactly **one** body (`socketListen`'s async path). Everything else is synchronous and therefore already globally serialized by JS run-to-completion.
2. `socketListen` already defends the only process-local hazard (fd reuse/close across the await) and performs its global writes atomically in a single post-await turn.
3. The residual cross-process concern is **not** in `worker-bodies.ts` but in the **socket backend's** ephemeral-port assignment + loopback-route insertion being consistent under two concurrently-awaiting `listen()` calls. In single-threaded JS each backend `listen()` continuation runs atomically; a hazard would only arise if a backend mutated the shared route map *before* its await and finalized *after*. The in-tree backend allocates/install inside the resolved continuation, so it is safe.

A global tier would add head-of-line blocking across unrelated processes (re-introducing the very coupling Task 10's per-process keying removed) for a one-body, already-mitigated surface — net negative.

## Recommendations (tracked, not blocking)

1. **Regression test:** two processes issuing concurrent async `socketListen` on port 0 must receive **distinct** ephemeral ports and consistent, non-cross-wired route entries (locks in finding #2's "atomic continuation" property against future backend changes).
2. **Forward-looking invariant (important):** the documented "future task" to relax `requireSyncSocketResult` and let `socketRecv`/`socketSend`/etc. `await` the async backend MUST, for *each* newly-async body, add the same post-await `kernel.getFdTarget(getPid(), fd) !== <captured target>` re-check that `socketListen` has — **or** a global serialization tier becomes mandatory at that point. This requirement should be a checklist item on any PR that makes a previously-sync body async. Recommend encoding it as a comment on `requireSyncSocketResult`.
3. **Backend contract:** document that `socketBackend.listen()` (and any future async backend op) must perform global route/port-registry mutation **only** in its resolved continuation, never straddling its own internal await.

## Conclusion

`#125` resolved as: audited; **no global tier needed**; the per-process serializer is sound given `requireSyncSocketResult` keeps all-but-`socketListen` synchronous and `socketListen` already guards its post-await window. The two recommendations above are the maintenance guardrails that keep this true as the dispatcher is made more async.
