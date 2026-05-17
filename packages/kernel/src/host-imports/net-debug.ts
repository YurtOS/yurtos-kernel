/**
 * Net-debug channel: enabled by `YURT_NET_DEBUG=1` in the host
 * environment. Emits structured-ish lines on stderr around socket
 * bind / listen / accept so we can see why ipykernel's TCP setup
 * fails or stalls. No-op when the env var isn't set; safe in both
 * Deno and browser (where neither env source exists).
 *
 * Kept in its own module so `kernel-imports.ts` contains no JSON helpers —
 * the host-json-boundary contract test relies on that file having zero
 * `JSON.parse` / `JSON.stringify` mentions.
 */

const YURT_NET_DEBUG = (() => {
  try {
    const denoEnv = (globalThis as {
      Deno?: { env: { get(k: string): string | undefined } };
    }).Deno?.env;
    if (denoEnv?.get("YURT_NET_DEBUG")) return true;
  } catch { /* Deno.env may throw on insufficient permissions */ }
  try {
    const procEnv = (globalThis as {
      process?: { env: Record<string, string | undefined> };
    }).process?.env;
    if (procEnv?.YURT_NET_DEBUG) return true;
  } catch { /* no-op */ }
  return false;
})();

export function netLog(op: string, fields: Record<string, unknown>): void {
  if (!YURT_NET_DEBUG) return;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  console.error(`[yurt-net] ${op} ${parts.join(" ")}`);
}
