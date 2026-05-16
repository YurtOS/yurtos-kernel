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
 * artifacts (or JSPI) are absent the affected `it()` `console.warn`s and
 * early-returns. Be precise about what that means: an early-returning
 * `it()` is a *passing* test in Deno's bdd runner, so this is a LOGGED
 * GREEN, not a red — there is no mechanism that turns "ran the slow tier
 * with missing artifacts" into a CI failure on its own. What does fail
 * loud is the gate logic: any spec case that can't be evaluated becomes
 * an `unestablished-case`, and with the committed (currently empty)
 * baseline that fails the run. The residual risk — a misconfigured slow
 * tier that builds no artifacts logs green — is real and accepted
 * because the CI step builds the artifacts immediately beforehand and
 * the job is env-gated. Do not read a green local run without
 * kernel.wasm as evidence of parity.
 */

import { describe, it } from "@std/testing/bdd";
import { parse as parseToml } from "@std/toml";
import {
  type BaselineEntry,
  evaluateGate,
  evaluateOrphans,
  evaluateUnestablished,
  formatBaselineSeed,
  type GateFailure,
  type Observed,
  type ParityRow,
  parseBaseline,
  parseSpecCases,
  type SpecCase,
  type UnestablishedCase,
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

async function enumerateSpecCases(): Promise<SpecCase[]> {
  const out: SpecCase[] = [];
  const errors: string[] = [];
  for await (const entry of Deno.readDir(CONFORMANCE_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".spec.toml")) continue;
    const text = await Deno.readTextFile(`${CONFORMANCE_DIR}/${entry.name}`);
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch (err) {
      errors.push(`${entry.name}: TOML parse error: ${err}`);
      continue;
    }
    // Never silently skip a spec the gate can't understand — that
    // would let the gate report green while omitting whole canaries
    // (PR #53 review 🔴 P1). parseSpecCases reports such files; we
    // collect every one and fail loud below.
    const parsed = parseSpecCases(entry.name, doc);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    out.push(...parsed.cases);
  }
  if (errors.length > 0) {
    throw new Error(
      `parity gate: ${errors.length} conformance spec file(s) could not ` +
        `be parsed — they would be silently omitted from the corpus. ` +
        `Fix or remove them:\n  ${errors.join("\n  ")}`,
    );
  }
  // Tuple compare (no delimiter-less concat — same smell the key()
  // NUL avoids): canary first, then case.
  out.sort((a, b) =>
    a.canary === b.canary
      ? a.caseName.localeCompare(b.caseName)
      : a.canary.localeCompare(b.canary)
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
    // Every (canary, case) we ATTEMPTED — feeds orphan detection so a
    // baseline entry that no longer corresponds to any case is flagged.
    const seen: { canary: string; case: string }[] = [];
    // Cases whose parity could not be evaluated (harness threw, or the
    // fixture wasn't built). NOT silently skipped: each must be a
    // tracked baseline entry or it fails the gate (PR #53 review P1).
    const unestablished: UnestablishedCase[] = [];
    let ran = 0;

    for (const { canary, caseName } of specCases) {
      seen.push({ canary, case: caseName });
      const argv = [`/fixtures/${canary}.wasm`, "--case", caseName];
      let pair: { ts: unknown; wasm: unknown } | null = null;
      try {
        pair = await runWithBothKernels(argv) as
          | { ts: unknown; wasm: unknown }
          | null;
      } catch (err) {
        unestablished.push({
          canary,
          case: caseName,
          reason: `harness error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
      if (!pair) {
        unestablished.push({
          canary,
          case: caseName,
          reason: "fixture wasm not built/copied for this case",
        });
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
      `parity-differ: mode=${mode} ran=${ran} ` +
        `unestablished=${unestablished.length} ` +
        `cases=${specCases.length} baseline=${baseline.length}`,
    );

    // Three independent gate checks (no silent skipping anywhere):
    //  - established rows diverge beyond the baseline,
    //  - cases whose parity could not be established aren't tracked,
    //  - baseline entries with no corresponding case (orphans).
    const failures: GateFailure[] = [
      ...evaluateGate(rows, baseline).failures,
      ...evaluateUnestablished(unestablished, baseline).failures,
      ...evaluateOrphans(baseline, seen).failures,
    ];
    if (failures.length > 0) {
      const lines = failures.map((f) =>
        `  [${f.kind}] ${f.canary}::${f.case}` +
        (f.slice ? ` (slice ${f.slice})` : "") + ` — ${f.detail}`
      );
      const seed = formatBaselineSeed(failures);
      throw new Error(
        `parity gate: ${failures.length} issue(s) not covered by ` +
          `abi/conformance/parity-baseline.toml:\n${lines.join("\n")}` +
          (seed ? `\n\n${seed}` : ""),
      );
    }
  });
});
