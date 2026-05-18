import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NetworkBridge } from "../bridge.ts";
import { NetworkGateway } from "../gateway.ts";

/**
 * #111 regression — `requestSync`/`fetchSync` must serialize their
 * single-slot SharedArrayBuffer access on the main thread.
 *
 * `requestSync` writes the request into the bridge's one shared SAB
 * slot and then `await`s `Atomics.waitAsync`. Without a main-thread
 * queue, a second caller invoked before the worker has read+replied
 * overwrites the first's request bytes/length; the worker only ever
 * answers one request and BOTH callers resolve on that single reply,
 * so a caller gets a response belonging to a different request
 * (observed pre-fix as `ok === undefined` from clobbered JSON, or a
 * cross-wired reply).
 *
 * Drives the REAL bridge worker via the `unknown op` fast path
 * (`default: writeErr('unknown op: ' + op)` in bridge.ts) so every
 * request has a unique, instantly-distinguishable reply and no network
 * is involved. Many concurrent calls are issued back-to-back; with the
 * serialization queue each must resolve to ITS OWN reply.
 */
describe(
  "NetworkBridge requestSync SAB serialization (#111)",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("concurrent requestSync calls each receive their own reply", async () => {
      const gateway = new NetworkGateway({ allowedHosts: ["127.0.0.1"] });
      const bridge = new NetworkBridge(gateway);
      await bridge.start();
      try {
        const N = 24;
        const results = await Promise.all(
          Array.from(
            { length: N },
            (_, i) => bridge.requestSync({ op: `race-${i}` }),
          ),
        );
        results.forEach((r, i) => {
          expect(r.ok).toBe(false);
          expect(r.error).toBe(`unknown op: race-${i}`);
        });
      } finally {
        bridge.dispose();
      }
    });
  },
);
