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
