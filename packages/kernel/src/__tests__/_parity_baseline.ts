/**
 * Slice B0 — parity baseline allowlist.
 *
 * The gate (parity-differ_test.ts) runs every conformance canary case
 * through the TS kernel and the Rust kernel.wasm and compares observable
 * output. Today many `partial` rows diverge; a permanently-red gate is
 * useless. The baseline (`abi/conformance/parity-baseline.toml`) lists the
 * currently-known divergent (canary, case) pairs, each tagged with the
 * owning slice and a reason.
 *
 * Invariants this module enforces:
 *  - an un-allowlisted divergence FAILS the gate;
 *  - an allowlisted pair that has *started matching* also FAILS the gate
 *    (so the allowlist can only ever shrink — fixed rows must be removed).
 *
 * Test-support only (not product code); the `_` prefix mirrors
 * `_parity_harness.ts`.
 */

import { parse as parseToml } from "@std/toml";

export interface BaselineEntry {
  canary: string;
  case: string;
  slice: string;
  reason: string;
}

export interface Observed {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ParityRow {
  canary: string;
  case: string;
  ts?: Observed;
  wasm?: Observed;
}

export type GateFailureKind =
  | "unexpected-divergence"
  // An allowlisted (canary, case) that now matches — the allowlist must
  // shrink, so the entry must be deleted (emitted by evaluateGate).
  | "stale-allowlist-entry"
  // A baseline entry no run row or unestablished case produced this run
  // (canary/case renamed or removed). Conceptually distinct from a
  // now-matching entry — kept separate so diagnostics are precise
  // (PR #53 review 🟢). Also must be deleted from the baseline.
  | "orphan-allowlist-entry"
  // A case whose parity could not be established at all (harness error
  // spawning/instantiating, or its fixture wasn't built). Must be an
  // explicit baseline entry or it fails — never silently skipped.
  | "unestablished-case";

/** A (canary, case) whose parity could not be evaluated, with why. */
export interface UnestablishedCase {
  canary: string;
  case: string;
  reason: string;
}

export interface GateFailure {
  kind: GateFailureKind;
  canary: string;
  case: string;
  /** Owning slice, when the failure relates to an allowlist entry. */
  slice?: string;
  detail: string;
}

/**
 * Parse `abi/conformance/parity-baseline.toml`. Required fields
 * (canary/case/slice/reason) are validated as non-empty strings;
 * unknown keys are ignored (not a closed schema).
 */
export function parseBaseline(tomlText: string): BaselineEntry[] {
  const doc = parseToml(tomlText) as Record<string, unknown>;
  const raw = doc.divergence;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("parity-baseline: `divergence` must be an array of tables");
  }
  return raw.map((item, i) => {
    const e = item as Record<string, unknown>;
    for (const field of ["canary", "case", "slice", "reason"] as const) {
      if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
        throw new Error(
          `parity-baseline: divergence[${i}] missing required string \`${field}\``,
        );
      }
    }
    return {
      canary: e.canary as string,
      case: e.case as string,
      slice: e.slice as string,
      reason: e.reason as string,
    };
  });
}

function diverges(a: Observed, b: Observed): boolean {
  return a.exitCode !== b.exitCode || a.stdout !== b.stdout ||
    a.stderr !== b.stderr;
}

function key(canary: string, caseName: string): string {
  return `${canary}\u0000${caseName}`;
}

/**
 * Apply the baseline rule to differ results. Rows with only one kernel
 * present (no peer) are ignored — they cannot diverge.
 */
export function evaluateGate(
  rows: ParityRow[],
  baseline: BaselineEntry[],
): { failures: GateFailure[] } {
  const allow = new Map<string, BaselineEntry>();
  for (const e of baseline) allow.set(key(e.canary, e.case), e);

  const failures: GateFailure[] = [];
  for (const row of rows) {
    if (!row.ts || !row.wasm) continue;
    const k = key(row.canary, row.case);
    const entry = allow.get(k);
    const hasDiff = diverges(row.ts, row.wasm);

    if (hasDiff && !entry) {
      failures.push({
        kind: "unexpected-divergence",
        canary: row.canary,
        case: row.case,
        detail: `ts=${JSON.stringify(row.ts)} wasm=${JSON.stringify(row.wasm)}`,
      });
    } else if (!hasDiff && entry) {
      failures.push({
        kind: "stale-allowlist-entry",
        canary: row.canary,
        case: row.case,
        slice: entry.slice,
        detail:
          `now matches; remove this entry from parity-baseline.toml (slice ${entry.slice})`,
      });
    }
  }
  return { failures };
}

/**
 * Cases whose parity could not be evaluated (harness threw, or fixture
 * absent) are NOT silently skipped: each must be an explicit baseline
 * entry (tracked, with a slice + reason) or it fails the gate. This is
 * what stops CI reporting parity while quietly omitting every canary
 * that needs special wiring (PR #53 review P1).
 */
export function evaluateUnestablished(
  cases: UnestablishedCase[],
  baseline: BaselineEntry[],
): { failures: GateFailure[] } {
  const allow = new Map<string, BaselineEntry>();
  for (const e of baseline) allow.set(key(e.canary, e.case), e);

  const failures: GateFailure[] = [];
  for (const c of cases) {
    if (allow.has(key(c.canary, c.case))) continue; // tracked → tolerated
    failures.push({
      kind: "unestablished-case",
      canary: c.canary,
      case: c.case,
      detail:
        `parity could not be established (${c.reason}) and it is not in ` +
        `parity-baseline.toml — add a tracked entry or fix the wiring`,
    });
  }
  return { failures };
}

/**
 * Emit copy-pasteable `[[divergence]]` TOML for the failing cases so the
 * first slow-tier CI run yields the exact baseline to commit (PR #53
 * review P2 — the baseline is *seeded from a real run*, never
 * auto-populated by CI).
 */
export function formatBaselineSeed(failures: GateFailure[]): string {
  const seedable = failures.filter(
    (f) =>
      f.kind === "unexpected-divergence" || f.kind === "unestablished-case",
  );
  if (seedable.length === 0) return "";
  // PR #53 review 🟢: keep the seed copy-pasteable. The full diff blob
  // goes in a one-lined, length-capped `# observed:` comment (no
  // diagnostic lost); `reason` is a short TODO placeholder the human
  // replaces with the real justification.
  const oneLine = (s: string) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
  };
  const blocks = seedable.map((f) =>
    `[[divergence]]\n` +
    `canary = ${JSON.stringify(f.canary)}\n` +
    `case = ${JSON.stringify(f.case)}\n` +
    `slice = "TODO"  # owning slice that will fix this row\n` +
    `# observed: ${oneLine(f.detail)}\n` +
    `reason = "TODO: why this divergence is tolerated"\n`
  );
  return `# --- candidate parity-baseline.toml seed (review & set slice) ---\n` +
    blocks.join("\n");
}

/**
 * Baseline entries never matched by a run row or an unestablished case
 * this gate run. Orphans (canary/case renamed or removed) would linger
 * forever, silently breaking the "allowlist only ever shrinks"
 * guarantee (PR #53 review 🟠#2). Flagged so they must be deleted.
 */
export function evaluateOrphans(
  baseline: BaselineEntry[],
  seen: Iterable<{ canary: string; case: string }>,
): { failures: GateFailure[] } {
  const seenKeys = new Set<string>();
  for (const s of seen) seenKeys.add(key(s.canary, s.case));
  const failures: GateFailure[] = [];
  for (const e of baseline) {
    if (!seenKeys.has(key(e.canary, e.case))) {
      failures.push({
        kind: "orphan-allowlist-entry",
        canary: e.canary,
        case: e.case,
        slice: e.slice,
        detail: `orphan: no spec case produced this (renamed/removed?). ` +
          `Delete it from parity-baseline.toml (slice ${e.slice})`,
      });
    }
  }
  return { failures };
}
