/**
 * Slice B0 — unit tests for the parity baseline allowlist logic.
 *
 * Pure logic, no kernel artifacts required, so this runs in the fast tier.
 * The gate (parity-differ_test.ts) is slow-tier; this locks the rule that
 * makes the gate safe: an un-allowlisted divergence fails, and an
 * allowlisted pair that has started matching ALSO fails (forces the
 * allowlist to only ever shrink).
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  evaluateGate,
  evaluateOrphans,
  evaluateUnestablished,
  formatBaselineSeed,
  type Observed,
  parseBaseline,
} from "./_parity_baseline.ts";

const SAME: Observed = { exitCode: 0, stdout: "ok", stderr: "" };
const DIFF: Observed = { exitCode: 1, stdout: "bad", stderr: "boom" };

describe("parseBaseline", () => {
  it("parses divergence entries and requires slice + reason", () => {
    const toml = `
[[divergence]]
canary = "dup2-canary"
case = "invalid_fd"
slice = "B2"
reason = "TS returns EBADF=9, Rust returns 8"
`;
    const entries = parseBaseline(toml);
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({
      canary: "dup2-canary",
      case: "invalid_fd",
      slice: "B2",
      reason: "TS returns EBADF=9, Rust returns 8",
    });
  });

  it("rejects an entry missing slice or reason", () => {
    const toml = `
[[divergence]]
canary = "x-canary"
case = "c"
`;
    expect(() => parseBaseline(toml)).toThrow(/slice|reason/);
  });

  it("treats an empty/absent table as no entries", () => {
    expect(parseBaseline("").length).toBe(0);
  });
});

describe("evaluateGate", () => {
  it("passes when both kernels agree and nothing is allowlisted", () => {
    const { failures } = evaluateGate(
      [{ canary: "c", case: "k", ts: SAME, wasm: SAME }],
      [],
    );
    expect(failures).toEqual([]);
  });

  it("fails on an un-allowlisted divergence", () => {
    const { failures } = evaluateGate(
      [{ canary: "c", case: "k", ts: SAME, wasm: DIFF }],
      [],
    );
    expect(failures.length).toBe(1);
    expect(failures[0].kind).toBe("unexpected-divergence");
    expect(failures[0].canary).toBe("c");
    expect(failures[0].case).toBe("k");
  });

  it("tolerates a divergence that is on the allowlist", () => {
    const { failures } = evaluateGate(
      [{ canary: "c", case: "k", ts: SAME, wasm: DIFF }],
      [{ canary: "c", case: "k", slice: "B1", reason: "known" }],
    );
    expect(failures).toEqual([]);
  });

  it("fails when an allowlisted pair has started matching (forces shrink)", () => {
    const { failures } = evaluateGate(
      [{ canary: "c", case: "k", ts: SAME, wasm: SAME }],
      [{ canary: "c", case: "k", slice: "B1", reason: "known" }],
    );
    expect(failures.length).toBe(1);
    expect(failures[0].kind).toBe("stale-allowlist-entry");
  });

  it("ignores single-kernel rows (no peer to diff)", () => {
    const { failures } = evaluateGate(
      [{ canary: "c", case: "k", ts: SAME }],
      [],
    );
    expect(failures).toEqual([]);
  });

  it("diffs exitCode, stdout and stderr independently", () => {
    const onlyStderr: Observed = { exitCode: 0, stdout: "ok", stderr: "x" };
    const { failures } = evaluateGate(
      [{ canary: "c", case: "k", ts: SAME, wasm: onlyStderr }],
      [],
    );
    expect(failures.length).toBe(1);
    expect(failures[0].kind).toBe("unexpected-divergence");
  });
});

describe("evaluateUnestablished", () => {
  it("fails an unestablished case that is not baselined", () => {
    const { failures } = evaluateUnestablished(
      [{ canary: "fork-canary", case: "split", reason: "harness error: x" }],
      [],
    );
    expect(failures.length).toBe(1);
    expect(failures[0].kind).toBe("unestablished-case");
    expect(failures[0].canary).toBe("fork-canary");
  });

  it("tolerates an unestablished case that IS baselined", () => {
    const { failures } = evaluateUnestablished(
      [{ canary: "fork-canary", case: "split", reason: "needs wiring" }],
      [{ canary: "fork-canary", case: "split", slice: "B5", reason: "wip" }],
    );
    expect(failures).toEqual([]);
  });
});

describe("evaluateOrphans", () => {
  it("flags a baseline entry no case produced", () => {
    const { failures } = evaluateOrphans(
      [{ canary: "gone", case: "k", slice: "B1", reason: "r" }],
      [{ canary: "other", case: "k" }],
    );
    expect(failures.length).toBe(1);
    // Distinct from evaluateGate's now-matching `stale-allowlist-entry`
    // (PR #53 review 🟢): an orphan is a renamed/removed case, a
    // conceptually different failure mode, so it gets its own kind.
    expect(failures[0].kind).toBe("orphan-allowlist-entry");
    expect(failures[0].canary).toBe("gone");
  });

  it("does not flag a baseline entry that was seen", () => {
    const { failures } = evaluateOrphans(
      [{ canary: "c", case: "k", slice: "B1", reason: "r" }],
      [{ canary: "c", case: "k" }],
    );
    expect(failures).toEqual([]);
  });
});

describe("formatBaselineSeed", () => {
  it("emits a parseable [[divergence]] block for seedable failures", () => {
    const seed = formatBaselineSeed([
      {
        kind: "unexpected-divergence",
        canary: "dup2-canary",
        case: "happy",
        detail: "ts exit=1 stdout=… vs wasm exit=0 stdout=…(long blob)",
      },
    ]);
    expect(seed).toContain("[[divergence]]");
    expect(seed).toContain(`canary = "dup2-canary"`);
    expect(seed).toContain(`case = "happy"`);
    // PR #53 review 🟢: `reason` is a short copy-pasteable placeholder,
    // NOT the full diff blob. The observed detail is preserved as a
    // trimmed `# observed:` comment so no diagnostic is lost.
    expect(seed).not.toContain(`reason = "ts exit=1 stdout=`);
    expect(seed).toMatch(/reason = "TODO: /);
    expect(seed).toContain("# observed: ts exit=1 stdout=");
    // Round-trips through parseBaseline once a slice is filled in.
    const filled = seed.replace(`"TODO"`, `"B2"`).replace(
      /^# .*$/gm,
      "",
    );
    const parsed = parseBaseline(filled);
    expect(parsed[0].canary).toBe("dup2-canary");
    expect(parsed[0].slice).toBe("B2");
  });

  it("returns empty when nothing is seedable", () => {
    expect(
      formatBaselineSeed([
        {
          kind: "stale-allowlist-entry",
          canary: "c",
          case: "k",
          slice: "B1",
          detail: "x",
        },
      ]),
    ).toBe("");
  });
});
