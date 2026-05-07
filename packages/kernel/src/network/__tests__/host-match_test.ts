import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { HOST_MATCH_SOURCE, matchesHostList } from "../host-match.js";

/**
 * host-match.ts is the single source of truth for network policy host
 * matching, used both on the main thread (NetworkGateway) and inside the
 * eval'd worker (HOST_MATCH_SOURCE). Edge cases here become security
 * footguns if they ever drift.
 */

describe("matchesHostList — exact match", () => {
  it("matches identical strings", () => {
    expect(matchesHostList("example.com", ["example.com"])).toBe(true);
  });

  it("does not perform case folding (URL.hostname is already lowercase)", () => {
    // matchesHostList is strict-equal — patterns must use the same case as
    // the hostname being checked. URL parsing lowercases hostnames, so
    // passing lowercased patterns is the safe convention. Mixed-case
    // patterns silently fail to match.
    expect(matchesHostList("example.com", ["Example.COM"])).toBe(false);
  });

  it("returns false on empty list", () => {
    expect(matchesHostList("example.com", [])).toBe(false);
  });

  it("matches if any of multiple patterns matches", () => {
    expect(matchesHostList("a.example.com", ["other.com", "*.example.com"]))
      .toBe(true);
  });
});

describe("matchesHostList — wildcard semantics", () => {
  it("bare * matches anything", () => {
    expect(matchesHostList("anything", ["*"])).toBe(true);
    expect(matchesHostList("", ["*"])).toBe(true);
    expect(matchesHostList("localhost", ["*"])).toBe(true);
  });

  it("*.example.com requires at least one subdomain label", () => {
    expect(matchesHostList("api.example.com", ["*.example.com"])).toBe(true);
    expect(matchesHostList("example.com", ["*.example.com"])).toBe(false);
  });

  it("*.example.com matches arbitrarily-deep subdomains", () => {
    // The wildcard implementation is "ends-with suffix and a dot before it",
    // so it does not bound the number of labels.
    expect(matchesHostList("a.b.c.example.com", ["*.example.com"])).toBe(true);
  });

  it("*.example.com does not match a sibling with the same suffix string", () => {
    expect(matchesHostList("notexample.com", ["*.example.com"])).toBe(false);
    expect(matchesHostList("evil-example.com", ["*.example.com"])).toBe(false);
  });

  it("does not strip ports — caller must pass URL.hostname", () => {
    // Sanity guard: matchesHostList is host-only. If a caller mistakenly
    // hands it "example.com:8080", that is treated as a literal string and
    // does NOT match a 'example.com' pattern.
    expect(matchesHostList("example.com:8080", ["example.com"])).toBe(false);
  });

  it("treats wildcards inside the middle as literal characters", () => {
    // Only the leading *. wildcard is supported; '*' embedded mid-pattern
    // is matched literally.
    expect(matchesHostList("foo*bar.com", ["foo*bar.com"])).toBe(true);
    expect(matchesHostList("fooXbar.com", ["foo*bar.com"])).toBe(false);
  });
});

// Shared fixtures used by both the canonical-impl assertions and the
// HOST_MATCH_SOURCE parity test. Adding a row here automatically grows
// the parity check, so the worker mirror cannot silently drift.
const PARITY_CASES: Array<{ host: string; list: string[] }> = [
  // Exact match
  { host: "example.com", list: ["example.com"] },
  { host: "evil.com", list: ["example.com"] },
  { host: "EXAMPLE.com", list: ["example.com"] },
  { host: "example.com", list: ["Example.COM"] },
  { host: "example.com", list: [] },
  { host: "a.example.com", list: ["other.com", "*.example.com"] },
  // Wildcard
  { host: "a.example.com", list: ["*.example.com"] },
  { host: "a.b.c.example.com", list: ["*.example.com"] },
  { host: "example.com", list: ["*.example.com"] },
  { host: "notexample.com", list: ["*.example.com"] },
  { host: "evil-example.com", list: ["*.example.com"] },
  // Bare *
  { host: "anything", list: ["*"] },
  { host: "", list: ["*"] },
  { host: "localhost", list: ["*"] },
  // Adversarial
  { host: "example.com:8080", list: ["example.com"] },
  { host: "foo*bar.com", list: ["foo*bar.com"] },
  { host: "fooXbar.com", list: ["foo*bar.com"] },
];

describe("HOST_MATCH_SOURCE — worker mirror stays in sync", () => {
  it("agrees with the canonical implementation on every fixture", () => {
    // Evaluate the worker source string in an isolated scope and exercise
    // it against the canonical implementation.
    const fn = new Function(
      `${HOST_MATCH_SOURCE}\n return matchesHostList;`,
    )() as (host: string, list: string[]) => boolean;

    for (const c of PARITY_CASES) {
      const expected = matchesHostList(c.host, c.list);
      const actual = fn(c.host, c.list);
      expect(actual).toBe(expected);
    }
  });
});
