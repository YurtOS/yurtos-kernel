#!/usr/bin/env -S deno run --allow-read --allow-env=YURT_ROOT --allow-net=crates.io,jsr.io,registry.npmjs.org
/**
 * Scan every sibling yurt-* repo + yurtos-kernel for declared dependency
 * versions, then query each ecosystem registry for the latest stable
 * release. Prints a table of deps that are behind.
 *
 * Sources scanned per repo:
 *   - `Cargo.toml` (root and workspace members) → crates.io
 *   - `deno.json` `imports` map                  → jsr.io / npm
 *
 * Skips path / git / workspace-local dependencies. Skips deps whose
 * version string is "*" or unset.
 *
 * Usage:
 *   scripts/check-package-versions.ts
 *   scripts/check-package-versions.ts --behind-only      (default; only show outdated)
 *   scripts/check-package-versions.ts --all              (show every dep)
 *   YURT_ROOT=/path scripts/check-package-versions.ts
 */

import { readDir } from "node:fs/promises";
import { resolve } from "node:path";

const YURT_ROOT = Deno.env.get("YURT_ROOT") ??
  resolve(import.meta.dirname!, "../..");

const SHOW_ALL = Deno.args.includes("--all");

interface DepRow {
  repo: string;
  source: string; // file path relative to repo
  registry: "crates.io" | "jsr" | "npm";
  name: string;
  declared: string;
  latest: string | null;
  status: "behind" | "current" | "unknown" | "skipped";
  note?: string;
}

async function listYurtRepos(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(YURT_ROOT)) {
    if (!entry.isDirectory) continue;
    if (entry.name === "yurtos-kernel" || entry.name.startsWith("yurt-")) {
      out.push(resolve(YURT_ROOT, entry.name));
    }
  }
  return out.sort();
}

async function walkCargoTomls(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  async function recurse(dir: string, depth: number): Promise<void> {
    if (depth > 4) return; // guard against runaway recursion
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "target" || e.name === "node_modules" || e.name === ".git") continue;
      if (e.name === "build" || e.name === "dist" || e.name === "stage") continue;
      const path = resolve(dir, e.name);
      if (e.isDirectory) {
        await recurse(path, depth + 1);
      } else if (e.name === "Cargo.toml") {
        found.push(path);
      }
    }
  }
  await recurse(repoRoot, 0);
  return found;
}

function parseCargoDeps(text: string): { name: string; version: string }[] {
  // Very lightweight scanner — we don't pull in a TOML library. Matches
  // both `foo = "1.2.3"` and `foo = { version = "1.2.3", ... }` lines
  // within [dependencies], [dev-dependencies], [build-dependencies], or
  // workspace.dependencies tables. Skips path/git/workspace specs.
  const out: { name: string; version: string }[] = [];
  let inDepsTable = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      inDepsTable = /^\[(workspace\.)?(dev-|build-)?dependencies\]/.test(line);
      continue;
    }
    if (!inDepsTable || !line) continue;
    // skip path/git/workspace specs
    if (/\bworkspace\s*=\s*true\b/.test(line)) continue;
    if (/\bpath\s*=\s*"/.test(line)) continue;
    if (/\bgit\s*=\s*"/.test(line)) continue;
    let m = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*"([^"]+)"\s*$/);
    if (m) {
      out.push({ name: m[1], version: m[2] });
      continue;
    }
    m = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*\{[^}]*\bversion\s*=\s*"([^"]+)"/);
    if (m) {
      out.push({ name: m[1], version: m[2] });
    }
  }
  return out;
}

interface DenoImports {
  imports?: Record<string, string>;
}

function parseDenoImports(text: string): { name: string; spec: string }[] {
  const out: { name: string; spec: string }[] = [];
  let json: DenoImports;
  try {
    json = JSON.parse(text) as DenoImports;
  } catch {
    return out;
  }
  for (const [name, spec] of Object.entries(json.imports ?? {})) {
    out.push({ name, spec });
  }
  return out;
}

// ── Registry lookups ─────────────────────────────────────────────────

const cratesCache = new Map<string, string | null>();
async function cratesIoLatest(name: string): Promise<string | null> {
  if (cratesCache.has(name)) return cratesCache.get(name)!;
  try {
    const r = await fetch(`https://crates.io/api/v1/crates/${name}`, {
      headers: { "User-Agent": "yurt-version-checker" },
    });
    if (!r.ok) {
      cratesCache.set(name, null);
      return null;
    }
    const j = await r.json() as { crate?: { max_stable_version?: string } };
    const v = j.crate?.max_stable_version ?? null;
    cratesCache.set(name, v);
    return v;
  } catch {
    cratesCache.set(name, null);
    return null;
  }
}

const jsrCache = new Map<string, string | null>();
async function jsrLatest(scope: string, pkg: string): Promise<string | null> {
  const key = `${scope}/${pkg}`;
  if (jsrCache.has(key)) return jsrCache.get(key)!;
  try {
    const r = await fetch(`https://jsr.io/${scope}/${pkg}/meta.json`);
    if (!r.ok) {
      jsrCache.set(key, null);
      return null;
    }
    const j = await r.json() as { latest?: string };
    const v = j.latest ?? null;
    jsrCache.set(key, v);
    return v;
  } catch {
    jsrCache.set(key, null);
    return null;
  }
}

const npmCache = new Map<string, string | null>();
async function npmLatest(name: string): Promise<string | null> {
  if (npmCache.has(name)) return npmCache.get(name)!;
  try {
    const r = await fetch(`https://registry.npmjs.org/${name}/latest`);
    if (!r.ok) {
      npmCache.set(name, null);
      return null;
    }
    const j = await r.json() as { version?: string };
    const v = j.version ?? null;
    npmCache.set(name, v);
    return v;
  } catch {
    npmCache.set(name, null);
    return null;
  }
}

// Coarse "is declared at the latest?" check. We treat `^x.y.z`, `~x.y.z`,
// and bare `x` (caret-semver) the same way: pass if the declared prefix
// is a prefix of `latest`. False negatives are fine — they nudge a
// human to look.
function isBehind(declared: string, latest: string): boolean {
  if (declared === latest) return false;
  const cleaned = declared.replace(/^[\^~=>]+/, "").replace(/^v/, "");
  if (latest.startsWith(cleaned)) return false;
  if (latest === cleaned) return false;
  // declared as major only? "28" vs latest "44.0.1" — behind.
  return true;
}

async function main() {
  const repos = await listYurtRepos();
  const rows: DepRow[] = [];

  for (const repoPath of repos) {
    const repo = repoPath.split("/").pop()!;

    // Cargo deps
    const tomls = await walkCargoTomls(repoPath);
    for (const toml of tomls) {
      const rel = toml.slice(repoPath.length + 1);
      let text: string;
      try {
        text = await Deno.readTextFile(toml);
      } catch {
        continue;
      }
      const deps = parseCargoDeps(text);
      for (const { name, version } of deps) {
        if (version === "*" || version.startsWith("0.0.")) {
          rows.push({
            repo, source: rel, registry: "crates.io", name,
            declared: version, latest: null,
            status: "skipped", note: "wildcard/dev",
          });
          continue;
        }
        const latest = await cratesIoLatest(name);
        const status: DepRow["status"] = latest === null
          ? "unknown"
          : (isBehind(version, latest) ? "behind" : "current");
        rows.push({
          repo, source: rel, registry: "crates.io", name,
          declared: version, latest, status,
        });
      }
    }

    // Deno imports
    const denoJson = resolve(repoPath, "deno.json");
    try {
      const text = await Deno.readTextFile(denoJson);
      const imports = parseDenoImports(text);
      for (const { name, spec } of imports) {
        if (spec.startsWith("./") || spec.startsWith("node:") ||
            spec.startsWith("file:")) {
          continue;
        }
        if (spec.startsWith("jsr:")) {
          const m = spec.match(/^jsr:(@[^/]+)\/([^@]+)(?:@(.+))?$/);
          if (!m) continue;
          const scope = m[1], pkg = m[2], declared = m[3] ?? "*";
          const latest = await jsrLatest(scope, pkg);
          const status: DepRow["status"] = declared === "*" ? "skipped"
            : latest === null ? "unknown"
            : (isBehind(declared, latest) ? "behind" : "current");
          rows.push({
            repo, source: "deno.json", registry: "jsr",
            name: `${scope}/${pkg}`, declared, latest, status,
          });
        } else if (spec.startsWith("npm:")) {
          const m = spec.match(/^npm:(@?[^@]+)(?:@(.+))?$/);
          if (!m) continue;
          const pkg = m[1], declared = m[2] ?? "*";
          const latest = await npmLatest(pkg);
          const status: DepRow["status"] = declared === "*" ? "skipped"
            : latest === null ? "unknown"
            : (isBehind(declared, latest) ? "behind" : "current");
          rows.push({
            repo, source: "deno.json", registry: "npm",
            name: pkg, declared, latest, status,
          });
        }
      }
    } catch {
      // no deno.json or unreadable — skip
    }
  }

  // Report
  const display = SHOW_ALL ? rows : rows.filter((r) => r.status === "behind");
  if (display.length === 0) {
    console.log("All scanned deps are current (or unknown).");
  } else {
    const header = ["repo", "name", "declared", "latest", "registry", "source"];
    const widths = header.map((h, i) =>
      Math.max(
        h.length,
        ...display.map((r) =>
          [r.repo, r.name, r.declared, r.latest ?? "?", r.registry, r.source][i].length
        ),
      )
    );
    const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
    console.log(header.map((h, i) => pad(h, widths[i])).join("  "));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    for (const r of display) {
      const cells = [r.repo, r.name, r.declared, r.latest ?? "?", r.registry, r.source];
      console.log(cells.map((c, i) => pad(c, widths[i])).join("  "));
    }
  }

  const counts = {
    behind: rows.filter((r) => r.status === "behind").length,
    current: rows.filter((r) => r.status === "current").length,
    unknown: rows.filter((r) => r.status === "unknown").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
  };
  console.log("");
  console.log(
    `[${rows.length} deps scanned: ${counts.behind} behind, ${counts.current} current, ${counts.unknown} unknown, ${counts.skipped} skipped]`,
  );
}

await main();
