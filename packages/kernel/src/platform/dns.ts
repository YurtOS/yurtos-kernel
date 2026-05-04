/**
 * Platform DNS trampoline — resolves a hostname to an IPv4 address.
 *
 * Dispatches to the right resolver based on the detected runtime:
 *   Deno   — Deno.resolveDns (built-in, no import needed)
 *   Node / Bun — node:dns/promises (both implement the Node API)
 *   Browser / wasmtime / unknown — returns null (no resolver available)
 *
 * Returns the first A record as a dotted-decimal string, or null on failure.
 */
export async function resolveHostname(hostname: string): Promise<string | null> {
  // Deno
  const deno = (globalThis as Record<string, unknown>).Deno as
    | { resolveDns?: (h: string, t: string) => Promise<string[]> }
    | undefined;
  if (typeof deno?.resolveDns === 'function') {
    try {
      const records = await deno.resolveDns(hostname, 'A');
      return records[0] ?? null;
    } catch {
      return null;
    }
  }

  // Node.js / Bun (both expose node:dns/promises)
  const proc = (globalThis as Record<string, unknown>).process as
    | { versions?: Record<string, unknown> }
    | undefined;
  if (proc?.versions != null) {
    try {
      const dns = await import('node:dns/promises');
      const result = await (dns as { lookup: (h: string, o: { family: number }) => Promise<{ address: string }> })
        .lookup(hostname, { family: 4 });
      return result.address ?? null;
    } catch {
      return null;
    }
  }

  // Browser / wasmtime / unknown
  return null;
}
