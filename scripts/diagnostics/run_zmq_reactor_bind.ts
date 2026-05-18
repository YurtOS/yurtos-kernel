#!/usr/bin/env -S deno run --no-check -A --unstable-sloppy-imports
/**
 * Diagnostic harness for the PR74 "post-bind ZMQ reactor flow" stall.
 *
 * Reproduces the ipykernel Heartbeat shape WITHOUT the full jupyter
 * stack: a libzmq Context with the default I/O reactor thread, plus a
 * ROUTER socket bound from a Python `threading.Thread` (a pthread
 * Worker), then polled — exactly the heartbeat thread's sequence.
 *
 * Needs only the staged cpython3.wasm + pyzmq sidecar (no yurt-jupyter
 * repo). Run from the repo root:
 *
 *   YURT_NET_DEBUG=1 deno run --no-check -A --unstable-sloppy-imports \
 *     scripts/diagnostics/run_zmq_reactor_bind.ts
 *
 * Expected trace markers (YURT_NET_DEBUG=1):
 *   pthread.spawn …                      ← libzmq I/O reactor pthread
 *   pthread.socket_open … result=ok      ← ROUTER listener fd
 *   pthread.bind … result=ok             ← PR74 fix made this pass
 *   pthread.listen … result=ok           ← the gate PR74 left open
 *
 * A clean run prints `hb: bound`, `hb: listening` (implied by the
 * netLog), `hb: poll done`, then `main: joined alive=False`. The bug
 * surfaces as the harness timeout with `pthread.bind result=ok` but no
 * `pthread.listen` line, and `main: joined alive=True` (or main never
 * returning from Thread.start()).
 */
import { resolve } from "node:path";
import { Sandbox } from "../../packages/kernel/src/sandbox.ts";
import { NodeAdapter } from "../../packages/kernel/src/platform/node-adapter.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../../packages/kernel/src/platform/__tests__/fixtures",
);

const program = [
  "import sys, threading, zmq",
  "print('zmq', zmq.zmq_version(), flush=True)",
  "def heartbeat():",
  "    print('hb: start', flush=True)",
  "    ctx = zmq.Context()              # default IO_THREADS=1 -> reactor pthread",
  "    print('hb: ctx', flush=True)",
  "    s = ctx.socket(zmq.ROUTER)",
  "    print('hb: socket', flush=True)",
  "    port = s.bind_to_random_port('tcp://127.0.0.1')",
  "    print(f'hb: bound port={port}', flush=True)",
  "    poller = zmq.Poller()",
  "    poller.register(s, zmq.POLLIN)",
  "    print('hb: polling', flush=True)",
  "    poller.poll(1500)",
  "    print('hb: poll done', flush=True)",
  "    s.close(); ctx.term()",
  "    print('hb: term', flush=True)",
  "t = threading.Thread(target=heartbeat, name='Heartbeat')",
  "t.start()",
  "print('main: thread started', flush=True)",
  "t.join(12)",
  "print(f'main: joined alive={t.is_alive()}', flush=True)",
].join("\n") + "\n";

const sandbox = await Sandbox.create({
  wasmDir: WASM_DIR,
  adapter: new NodeAdapter(),
  network: { allowedHosts: ["127.0.0.1", "localhost"] },
  serverSockets: { allowLoopback: true },
});

const TIMEOUT_MS = 35_000;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.log(
    `\n=== HARNESS TIMEOUT after ${TIMEOUT_MS}ms (stall reproduced) ===`,
  );
  try {
    sandbox.destroy();
  } catch { /* ignore */ }
  Deno.exit(99);
}, TIMEOUT_MS);

try {
  const r = await sandbox.run("cpython3 -", {
    stdinData: new TextEncoder().encode(program),
  });
  clearTimeout(timer);
  if (!timedOut) {
    console.log("=== exit", r.exitCode);
    console.log("=== stdout:\n" + r.stdout);
    console.log("=== stderr:\n" + r.stderr);
  }
} catch (e) {
  clearTimeout(timer);
  console.log("=== threw:", e instanceof Error ? e.message : String(e));
} finally {
  if (!timedOut) {
    try {
      sandbox.destroy();
    } catch { /* ignore */ }
  }
}
