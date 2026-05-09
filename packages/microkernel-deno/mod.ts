/**
 * Sandboxed-kernel microkernel — Deno-specific extensions.
 *
 * This package is for capabilities only Deno (and Node) can provide
 * natively:
 *   - real TCP sockets (`Deno.connect`, `Deno.listen`)
 *   - real filesystem access (`Deno.readFile`, `Deno.open`)
 *   - subprocess invocation (`Deno.Command`)
 *   - terminal / TTY integration
 *
 * The portable JS+wasm core lives in `packages/microkernel-js/` and
 * is what browsers use directly — there is no `microkernel-browser`,
 * because browsers and Deno share the JS engine, WebAssembly, fetch,
 * crypto, IndexedDB, and WebSocket. Anything genuinely browser-only
 * (Service-Worker fetch routing into a sandbox, OPFS persistence,
 * postMessage glue to a host page) belongs in the application layer
 * above the microkernel, not as a parallel microkernel.
 *
 * Today this file is a thin re-export — every existing fixture parity
 * test runs through the portable core. Deno-only extensions land here
 * as we port real-IO syscalls (the TS kernel's `host_socket_*`,
 * `host_network_fetch`, real-fs paths).
 */

export {
  defaultHostState,
  type ExtensionRegistry,
  type HostState,
  KERNEL_PID,
  KernelInstance,
  type LogSink,
  METHOD,
  Microkernel,
  s,
  UserProcess,
} from "../microkernel-js/mod.ts";
