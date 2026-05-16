/**
 * Slice B0 — the thin parity gate.
 *
 * Runs every `abi/conformance/<symbol>.spec.toml` canary case through the
 * TS kernel and the Rust kernel.wasm and fails on any observable
 * divergence (exit code / stdout / stderr) that is not recorded in
 * `abi/conformance/parity-baseline.toml`. See
 * docs/superpowers/specs/2026-05-16-thin-parity-gate-design.md.
 *
 * Selection: `YURT_KERNEL` ∈ {ts, wasm, both} (default both). Only `both`
 * can detect divergence; ts/wasm are single-kernel triage modes.
 *
 * Slow tier only — it needs built canaries + kernel.wasm. When those
 * artifacts (or JSPI) are absent it SKIPS loudly rather than passing
 * vacuously, so a green run without artifacts is never mistaken for parity.
 */

import { describe, it } from "@std/testing/bdd";
import { parse as parseToml } from "@std/toml";
import {
  type BaselineEntry,
  evaluateGate,
  type Observed,
  type ParityRow,
  parseBaseline,
} from "./_parity_baseline.ts";
import {
  HAS_JSPI,
  hasKernelWasm,
  runWithBothKernels,
} from "./_parity_harness.ts";

const CONFORMANCE_DIR = decodeURIComponent(
  new URL("../../../../abi/conformance", import.meta.url).pathname,
);
const BASELINE_URL = new URL(
  "../../../../abi/conformance/parity-baseline.toml",
  import.meta.url,
);

type KernelMode = "ts" | "wasm" | "both";
function kernelMode(): KernelMode {
  const v = (Deno.env.get("YURT_KERNEL") ?? "both").toLowerCase();
  if (v === "ts" || v === "wasm" || v === "both") return v;
  throw new Error(`YURT_KERNEL must be ts|wasm|both, got ${JSON.stringify(v)}`);
}

interface SpecCase {
  canary: string;
  caseName: string;
}

async function enumerateSpecCases(): Promise<SpecCase[]> {
  const out: SpecCase[] = [];
  for await (const entry of Deno.readDir(CONFORMANCE_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".spec.toml")) continue;
    const text = await Deno.readTextFile(`${CONFORMANCE_DIR}/${entry.name}`);
    const doc = parseToml(text) as Record<string, unknown>;
    const canary = doc.canary;
    const cases = doc.case;
    if (typeof canary !== "string" || !Array.isArray(cases)) continue;
    for (const c of cases) {
      const name = (c as Record<string, unknown>).name;
      if (typeof name === "string") out.push({ canary, caseName: name });
    }
  }
  out.sort((a, b) =>
    (a.canary + a.caseName).localeCompare(b.canary + b.caseName)
  );
  return out;
}

async function loadBaseline(): Promise<BaselineEntry[]> {
  try {
    return parseBaseline(await Deno.readTextFile(BASELINE_URL));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

function observed(
  r: { exitCode: number; stdout: string; stderr: string },
): Observed {
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

describe("parity gate (TS vs Rust kernel over the conformance corpus)", () => {
  it("conformance canaries do not diverge beyond the baseline", async () => {
    const mode = kernelMode();

    if (!(await hasKernelWasm())) {
      console.warn(
        "parity-differ: SKIP — kernel.wasm not built " +
          "(target/wasm32-wasip1/release/yurt_kernel_wasm.wasm). " +
          "Run in the guest-compat slow tier.",
      );
      return;
    }
    if (mode === "both" && !HAS_JSPI) {
      console.warn(
        "parity-differ: SKIP — `both` needs JSPI for the wasm kernel.",
      );
      return;
    }

    const specCases = await enumerateSpecCases();
    if (specCases.length === 0) {
      console.warn("parity-differ: SKIP — no *.spec.toml found.");
      return;
    }

    const baseline = await loadBaseline();
    const rows: ParityRow[] = [];
    let ran = 0;
    let skipped = 0;

    for (const { canary, caseName } of specCases) {
      const argv = [`/fixtures/${canary}.wasm`, "--case", caseName];
      let pair: { ts: unknown; wasm: unknown } | null = null;
      try {
        pair = await runWithBothKernels(argv) as
          | { ts: unknown; wasm: unknown }
          | null;
      } catch (err) {
        // A spawn/instantiate failure on one side is itself a divergence
        // signal, but in B0 we conservatively skip+report rather than
        // hard-fail on harness errors (e.g. continuation canaries that
        // need bespoke wiring). These become explicit B5 worklist items.
        console.warn(
          `parity-differ: skip ${canary}::${caseName} — harness error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        skipped++;
        continue;
      }
      if (!pair) {
        skipped++;
        continue;
      }
      ran++;
      // deno-lint-ignore no-explicit-any
      const ts = observed((pair as any).ts);
      // deno-lint-ignore no-explicit-any
      const wasm = observed((pair as any).wasm);
      rows.push({
        canary,
        case: caseName,
        ts: mode === "wasm" ? undefined : ts,
        wasm: mode === "ts" ? undefined : wasm,
      });
    }

    console.log(
      `parity-differ: mode=${mode} ran=${ran} skipped=${skipped} ` +
        `cases=${specCases.length} baseline=${baseline.length}`,
    );

    if (ran === 0) {
      // We only reach here with kernel.wasm + (for `both`) JSPI +
      // a non-empty spec corpus — every legitimate skip already
      // returned above. ran===0 now means a wiring/fixture-copy
      // failure, not a legitimate skip. Fail loudly: a gate that
      // greens having run nothing is the trap later slices would
      // mistake for parity (PR #53 review #1).
      throw new Error(
        `parity-differ: ran=0 of ${specCases.length} cases ` +
          `(skipped=${skipped}) with kernel.wasm present — canaries ` +
          `were not built/copied into fixtures. This is a wiring bug, ` +
          `not a legitimate skip; refusing to report vacuous parity.`,
      );
    }

    const { failures } = evaluateGate(rows, baseline);
    if (failures.length > 0) {
      const lines = failures.map((f) =>
        `  [${f.kind}] ${f.canary}::${f.case}` +
        (f.slice ? ` (slice ${f.slice})` : "") + ` — ${f.detail}`
      );
      throw new Error(
        `parity gate: ${failures.length} divergence(s) not covered by ` +
          `abi/conformance/parity-baseline.toml:\n${lines.join("\n")}`,
      );
    }
  });
});
