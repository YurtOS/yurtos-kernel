/**
 * Sandboxed-kernel microkernel — Deno-specific extensions.
 *
 * This package is for capabilities only Deno can provide:
 *   - real TCP sockets (`Deno.connect`, `Deno.listen`)
 *   - real filesystem access (`Deno.readFile`, `Deno.open`)
 *   - subprocess invocation (`Deno.Command`)
 *   - terminal / TTY integration
 *
 * The portable JS+wasm core lives in `packages/microkernel-js/`. This
 * package re-exports it so existing import paths (`@yurt/microkernel-
 * deno`) keep working, and adds Deno-only extensions on top as the
 * relevant syscalls get wired (real sockets via `kh_socket_*`, real
 * disk via `kh_real_*`, etc.).
 *
 * For browser-specific equivalents (Service-Worker fetch routing,
 * OPFS, IndexedDB persistence), see the eventual
 * `packages/microkernel-browser/`.
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
