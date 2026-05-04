#!/usr/bin/env -S deno run -A
/**
 * Run BusyBox's upstream testsuite inside a yurt sandbox.
 *
 * The BusyBox binary shipped in the yurt fixtures is built with a minimal
 * .config (only grep, head, seq enabled). The full upstream testsuite has 66+
 * test files; only tests for those 3 applets (plus busybox.tests) produce
 * meaningful PASS/FAIL results. All others self-SKIP via CONFIG_ checks.
 *
 * Infrastructure constraint discovered during testing:
 *  - runtest's "implemented" detection uses a shell pipeline pattern that the
 *    sandbox doesn't support (xargs-within-while-read from a pipe, plus
 *    absolute-path subprocess spawning of VFS symlinks). We bypass runtest and
 *    invoke each .tests file directly.
 *  - Some tests (bc.tests) hang indefinitely because bc reads stdin without
 *    a proper EOF signal in the yurt shell. We run each .tests file in a
 *    fresh sandbox with a per-test timeout to protect against this.
 */

import { resolve, join } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Sandbox } from '../packages/kernel/src/sandbox.js';
import { NodeAdapter } from '../packages/kernel/src/platform/node-adapter.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/kernel/src/platform/__tests__/fixtures');
const BUSYBOX_WASM = resolve(REPO_ROOT, 'packages/c-ports/busybox/build/busybox.wasm');
const BUSYBOX_WASM_FIXTURE = resolve(FIXTURES, 'busybox.wasm');
const TESTSUITE_DIR = resolve(REPO_ROOT, 'packages/c-ports/busybox/src/testsuite');
const BUSYBOX_CONFIG = resolve(REPO_ROOT, 'packages/c-ports/busybox/src/.config');
const FINDINGS_DIR = resolve(REPO_ROOT, 'docs/superpowers/findings');
const FINDINGS_FILE = resolve(FINDINGS_DIR, '2026-04-22-busybox-testsuite-on-yurt.md');

// Per-test timeout in ms — guards against bc/interactive test hangs
const PER_TEST_TIMEOUT_MS = 30_000;

// Any upstream test failure makes CI fail. The runner's job is to report
// numbers; it is not the runner's job to decide what's "acceptable."
// Known-open failures get tracked in the findings doc + ledger, not hidden
// behind a tolerance knob that lets CI go green on red suites.


// ---------------------------------------------------------------------------
// Step 1: ensure busybox.wasm is built
// ---------------------------------------------------------------------------

if (!existsSync(BUSYBOX_WASM)) {
  console.log('[busybox-testsuite] busybox.wasm not found at build/, running make...');
  execSync('make -C packages/c-ports/busybox all', { cwd: REPO_ROOT, stdio: 'inherit' });
}
if (!existsSync(BUSYBOX_WASM_FIXTURE)) {
  console.log('[busybox-testsuite] copying busybox.wasm to fixtures...');
  execSync(`cp "${BUSYBOX_WASM}" "${BUSYBOX_WASM_FIXTURE}"`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sandboxMkdirp(sb: Sandbox, path: string): void {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try { sb.mkdir(current); } catch { /* already exists or not writable */ }
  }
}

function uploadDir(sb: Sandbox, hostDir: string, sandboxDir: string): void {
  sandboxMkdirp(sb, sandboxDir);
  for (const entry of readdirSync(hostDir)) {
    const hPath = join(hostDir, entry);
    const sPath = sandboxDir + '/' + entry;
    const st = statSync(hPath);
    if (st.isDirectory()) {
      uploadDir(sb, hPath, sPath);
    } else {
      sb.writeFile(sPath, new Uint8Array(readFileSync(hPath)));
    }
  }
}

// Compute OPTIONFLAGS from .config on the host side (avoids sandbox pipelines)
const configContent = existsSync(BUSYBOX_CONFIG) ? readFileSync(BUSYBOX_CONFIG, 'utf-8') : '';
const optionFlagsItems = configContent.split('\n')
  .filter(l => l.match(/^CONFIG_[A-Z0-9_]+=/) && !l.endsWith('=n') && !l.endsWith('=""'))
  .map(l => l.replace(/^CONFIG_/, '').replace(/=.*$/, ''));
const optionFlags = ':' + optionFlagsItems.join(':') + ':';

// `runtest` checks `# CONFIG_<APPLET> is not set` per .tests file and skips
// disabled applets as UNTESTED (its rationale: the .tests file expects the
// applet to exist). We bypass `runtest` for the infrastructure reasons in
// the findings doc, so reproduce that skip here.
//
// In our sandbox an applet may exist via either path:
//   - BusyBox built it in (CONFIG_<APPLET>=y), or
//   - A standalone wasm fixture is on PATH (e.g. /usr/bin/cat.wasm dispatches
//     for the cat tests even though our minimal BusyBox doesn't include cat).
// Skip only if NEITHER source provides the applet; otherwise the tests would
// fall over with "applet not found" / "command not found" through no fault of
// our runtime. tsort is the canonical example — not in our BusyBox, no
// standalone fixture either.
const enabledApplets = new Set(
  configContent.split('\n')
    .filter(l => /^CONFIG_[A-Z0-9_]+=y$/.test(l))
    .map(l => l.replace(/^CONFIG_/, '').replace(/=y$/, '').toLowerCase()),
);
const standaloneTools = new Set(
  readdirSync(FIXTURES)
    .filter(f => f.endsWith('.wasm'))
    .map(f => f.replace(/\.wasm$/, '').toLowerCase()),
);

function appletForTestFile(testFile: string): string {
  // BusyBox .tests filenames are `<applet>.tests`; suffix ".tests" stripped.
  return testFile.replace(/\.tests$/, '');
}

function appletAvailable(applet: string): boolean {
  return enabledApplets.has(applet) || standaloneTools.has(applet);
}

const baseEnvStr = [
  'bindir=/tmp/testsuite',
  'tsdir=/tmp/testsuite',
  'LINKSDIR=/tmp/testsuite/runtest-tempdir-links',
  'PATH="/tmp/testsuite/runtest-tempdir-links:/usr/bin:/bin:$PATH"',
  'VERBOSE=1',
  `OPTIONFLAGS="${optionFlags}"`,
].join(' ');

async function setupSandbox(): Promise<Sandbox> {
  const sb = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    timeoutMs: PER_TEST_TIMEOUT_MS,
  });
  uploadDir(sb, TESTSUITE_DIR, '/tmp/testsuite');
  // Shell wrapper for busybox (symlink absolute-path spawn doesn't work in sandbox)
  sb.writeFile('/tmp/testsuite/busybox', new TextEncoder().encode('#!/bin/sh\nexec busybox "$@"\n'));
  if (existsSync(BUSYBOX_CONFIG)) {
    sb.writeFile('/tmp/testsuite/.config', new Uint8Array(readFileSync(BUSYBOX_CONFIG)));
  }
  // Install BusyBox applet symlinks in a PATH-prefixed directory so that
  // `grep`/`head`/etc. from test scripts dispatch to busybox (multicall)
  // rather than to the standalone coreutils fixtures. Enumerated from the
  // live binary via `busybox --list` — whatever the current .config enables.
  await sb.run('mkdir -p /tmp/testsuite/runtest-tempdir-links');
  const listed = await sb.run('busybox --list');
  const applets = listed.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  for (const a of applets) {
    await sb.run(`ln -sf /usr/bin/busybox /tmp/testsuite/runtest-tempdir-links/${a} 2>/dev/null || true`);
  }
  return sb;
}

// ---------------------------------------------------------------------------
// Run a test file with a timeout; returns a fresh sandbox if the test hung.
// ---------------------------------------------------------------------------

async function runTestFile(testFile: string): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean
}> {
  const sb = await setupSandbox();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('TEST_TIMEOUT')), PER_TEST_TIMEOUT_MS)
  );
  try {
    const result = await Promise.race([
      sb.run(`cd /tmp/testsuite && ${baseEnvStr} sh ${testFile} 2>&1`),
      timeout,
    ]);
    sb.destroy();
    return { stdout: result.stdout, stderr: result.stderr ?? '', exitCode: result.exitCode, timedOut: false };
  } catch (e: unknown) {
    try { sb.destroy(); } catch { /* ignore */ }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'TEST_TIMEOUT' || msg?.includes('RuntimeError') || msg?.includes('unreachable')) {
      return { stdout: '', stderr: msg.substring(0, 200), exitCode: -1, timedOut: true };
    }
    // SyntaxError: the test produced non-UTF-8 bytes that broke
    // ShellInstance.run's JSON-decoding path.  Tracked separately as
    // a binary-safety bug in shell-exec; for the conformance harness,
    // treat the offending test as a crash rather than aborting the
    // whole run.
    if (e instanceof SyntaxError || msg.startsWith('Unexpected token')) {
      return { stdout: '', stderr: `JSON-decode failure (likely non-UTF-8 stdout): ${msg.substring(0, 200)}`, exitCode: -1, timedOut: true };
    }
    throw e;
  }
}

async function runOldStyleTest(dir: string, testCase: string): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean
}> {
  const sb = await setupSandbox();
  const sandboxTestDir = `/tmp/ts.${dir}.${testCase}`;
  const sandboxTestFile = `/tmp/testsuite/${dir}/${testCase}`;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('TEST_TIMEOUT')), PER_TEST_TIMEOUT_MS)
  );
  try {
    sandboxMkdirp(sb, sandboxTestDir);
    const result = await Promise.race([
      sb.run(
        `cd ${sandboxTestDir} && ${baseEnvStr} d=/tmp/testsuite ` +
        `sh -x -e ${sandboxTestFile}`
      ),
      timeout,
    ]);
    sb.destroy();
    if (result.exitCode === 0) {
      return { stdout: `PASS: ${testCase}\n`, stderr: result.stderr ?? '', exitCode: 0, timedOut: false };
    }
    return {
      stdout: [
        `FAIL: ${testCase}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n'),
      stderr: result.stderr ?? '',
      exitCode: result.exitCode,
      timedOut: false,
    };
  } catch (e: unknown) {
    try { sb.destroy(); } catch { }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'TEST_TIMEOUT' || msg?.includes('RuntimeError') || msg?.includes('unreachable')) {
      return {
        stdout: `FAIL: ${testCase}\n${msg.substring(0, 100)}`,
        stderr: '', exitCode: -1, timedOut: true,
      };
    }
    if (e instanceof SyntaxError || msg.startsWith('Unexpected token')) {
      return {
        stdout: `FAIL: ${testCase}\nJSON-decode failure (likely non-UTF-8 stdout)`,
        stderr: '', exitCode: -1, timedOut: true,
      };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Step 5: Run all tests
// ---------------------------------------------------------------------------

console.log('[busybox-testsuite] running testsuite...');
const startMs = Date.now();

interface RunRecord {
  testFile: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

const allResults: RunRecord[] = [];

// .tests files
const testFiles = readdirSync(TESTSUITE_DIR).filter(f => f.endsWith('.tests')).sort();

for (const testFile of testFiles) {
  const applet = appletForTestFile(testFile);
  if (applet !== 'busybox' && !appletAvailable(applet)) {
    // Mirror runtest's "# CONFIG_<APPLET> is not set" skip path. Recorded
    // as a synthetic UNTESTED line so the aggregate counter sees it.
    allResults.push({
      testFile,
      stdout: `UNTESTED: ${testFile} (applet not available — neither in BusyBox config nor standalone fixture)\n`,
      stderr: '',
      exitCode: 0,
    });
    continue;
  }
  console.log(`[busybox-testsuite]   ${testFile}...`);
  const r = await runTestFile(testFile);
  const lines = r.stdout.split('\n');
  const p = lines.filter(l => l.startsWith('PASS:')).length;
  const f = lines.filter(l => l.startsWith('FAIL:')).length;
  const s = lines.filter(l => l.match(/^SKIP/)).length;
  const u = lines.filter(l => l.startsWith('UNTESTED:')).length;
  if (r.timedOut) {
    console.log(`[busybox-testsuite]   TIMEOUT/CRASH: ${testFile}`);
  } else {
    console.log(`[busybox-testsuite]   ${testFile}: PASS=${p} FAIL=${f} SKIP=${s} UNTESTED=${u}`);
  }
  allResults.push({ testFile, ...r });
}

// Old-style test subdirectories
const testDirs = readdirSync(TESTSUITE_DIR)
  .filter(f => statSync(join(TESTSUITE_DIR, f)).isDirectory())
  .sort();

for (const dir of testDirs) {
  // Old-style tests live under <applet>/<case>; skip the directory entirely
  // when neither BusyBox nor a standalone fixture provides the applet.
  if (!appletAvailable(dir.toLowerCase())) {
    const items = readdirSync(join(TESTSUITE_DIR, dir))
      .filter(c => !c.startsWith('.') && !c.endsWith('~'));
    for (const testCase of items) {
      allResults.push({
        testFile: `${dir}/${testCase}`,
        stdout: `UNTESTED: ${dir}/${testCase} (applet not available — neither in BusyBox config nor standalone fixture)\n`,
        stderr: '',
        exitCode: 0,
      });
    }
    continue;
  }
  const items = readdirSync(join(TESTSUITE_DIR, dir));
  for (const testCase of items) {
    if (testCase.startsWith('.') || testCase.endsWith('~')) continue;
    console.log(`[busybox-testsuite]   ${dir}/${testCase}...`);
    const r = await runOldStyleTest(dir, testCase);
    allResults.push({ testFile: `${dir}/${testCase}`, ...r });
  }
}

const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`[busybox-testsuite] testsuite finished in ${elapsedSec}s`);

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

interface TestResult {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'UNTESTED';
  name: string;
  lines: string[];
  source: string;
}

const results: TestResult[] = [];

for (const r of allResults) {
  if (r.timedOut) {
    const applet = r.testFile.split('.')[0].split('/')[0];
    results.push({
      status: 'FAIL',
      name: `${r.testFile} (TIMEOUT/CRASH)`,
      lines: [`FAIL: ${r.testFile} (TIMEOUT/CRASH)`, r.stderr],
      source: r.testFile,
    });
    continue;
  }
  const lines = r.stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const passMatch = line.match(/^PASS:\s+(.+)$/);
    const failMatch = line.match(/^FAIL:\s+(.+)$/);
    const skipMatch = line.match(/^SKIP(?:PED)?:\s+(.+)$/);
    const untestedMatch = line.match(/^UNTESTED:\s+(.+)$/);

    if (passMatch) {
      results.push({ status: 'PASS', name: passMatch[1].trim(), lines: [line], source: r.testFile });
    } else if (failMatch) {
      const diagLines = lines.slice(i + 1, i + 16).filter(l => l.trim());
      results.push({ status: 'FAIL', name: failMatch[1].trim(), lines: [line, ...diagLines], source: r.testFile });
    } else if (skipMatch) {
      results.push({ status: 'SKIP', name: skipMatch[1].trim(), lines: [line], source: r.testFile });
    } else if (untestedMatch) {
      results.push({ status: 'UNTESTED', name: untestedMatch[1].trim(), lines: [line], source: r.testFile });
    }
  }
}

const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
const skipped = results.filter(r => r.status === 'SKIP').length;
const untested = results.filter(r => r.status === 'UNTESTED').length;
const total = passed + failed + skipped + untested;
const timedOutCount = allResults.filter(r => r.timedOut).length;

console.log(`[busybox-testsuite] Results: ${passed} pass / ${failed} fail / ${skipped} skip / ${untested} untested / ${total} total`);
console.log(`[busybox-testsuite] Timed out / crashed: ${timedOutCount}`);

// ---------------------------------------------------------------------------
// Classify failures
// ---------------------------------------------------------------------------

type Classification = 'needs-fork' | 'runtime-gap' | 'test-env' | 'unknown';

interface FailEntry {
  name: string;
  applet: string;
  source: string;
  excerpt: string;
  classification: Classification;
  reason: string;
}

function classifyFailure(name: string, source: string, diagLines: string[]): { classification: Classification; reason: string } {
  const text = diagLines.join('\n').toLowerCase();
  const nameLow = name.toLowerCase();
  const sourceLow = source.toLowerCase();

  if (nameLow.includes('timeout') || nameLow.includes('crash') || text.includes('timeout') || text.includes('runtimeerror')) {
    if (nameLow.includes('bc') || sourceLow.includes('bc')) {
      return { classification: 'runtime-gap', reason: 'bc hangs reading stdin — shell pipe EOF not delivered when bc reads interactively. Sandbox stdin-close gap.' };
    }
    return { classification: 'runtime-gap', reason: 'Command hung or WASM crashed — needs investigation' };
  }

  if (text.includes('applet not found') || (text.includes('no such file') && text.includes('directory'))) {
    return { classification: 'runtime-gap', reason: 'Applet missing or path resolution gap in sandbox subprocess spawning' };
  }

  if (sourceLow.includes('busybox.tests') && text.includes('expected')) {
    return { classification: 'runtime-gap', reason: 'busybox output format differs — multicall binary help text mismatch vs expected' };
  }

  // Grep path issues (CWD-based relative path vs absolute path in output)
  if (text.includes('/tmp/testsuite/') && (text.includes('input:') || text.includes('file:'))) {
    return { classification: 'test-env', reason: 'Test expects relative path "input:..." but sandbox produces absolute path "/tmp/testsuite/input:..." because CWD contains the full path' };
  }

  if (text.includes('could not open') && text.includes('grep')) {
    return { classification: 'runtime-gap', reason: 'grep file access issue — possible VFS path resolution gap' };
  }

  if (nameLow.includes('wget') || nameLow.includes('curl') || text.includes('network') || text.includes('socket') || text.includes('connect')) {
    return { classification: 'test-env', reason: 'Requires network access not available in sandbox' };
  }

  if (text.includes('tty') || text.includes('terminal') || nameLow.includes('stty')) {
    return { classification: 'test-env', reason: 'Requires TTY not available in sandbox' };
  }

  if (text.includes('permission denied') || text.includes('operation not permitted')) {
    return { classification: 'test-env', reason: 'Requires Unix permissions or root not available in sandbox' };
  }

  if (text.includes('@@ -') || text.includes('expected') || text.includes('--- ')) {
    return { classification: 'runtime-gap', reason: 'Output mismatch — runtime behavior differs from expected' };
  }

  return { classification: 'unknown', reason: 'Needs investigation — insufficient diagnostic output to classify' };
}

function extractApplet(source: string): string {
  const slashIdx = source.indexOf('/');
  if (slashIdx > 0) return source.substring(0, slashIdx);
  const dotIdx = source.indexOf('.tests');
  if (dotIdx > 0) return source.substring(0, dotIdx);
  return source.split(/[-_]/)[0];
}

const failEntries: FailEntry[] = results
  .filter(r => r.status === 'FAIL')
  .map(r => {
    const { classification, reason } = classifyFailure(r.name, r.source, r.lines);
    return {
      name: r.name,
      applet: extractApplet(r.source),
      source: r.source,
      excerpt: r.lines.slice(0, 12).join('\n'),
      classification,
      reason,
    };
  });

const tally = { 'needs-fork': 0, 'runtime-gap': 0, 'test-env': 0, 'unknown': 0 };
for (const e of failEntries) tally[e.classification]++;

// ---------------------------------------------------------------------------
// Write findings doc
// ---------------------------------------------------------------------------

mkdirSync(FINDINGS_DIR, { recursive: true });

const failSections = failEntries.map(e => `
### FAIL: ${e.name}

- **Source**: \`${e.source}\`
- **Applet**: \`${e.applet}\`
- **Classification**: \`${e.classification}\`
- **Reason**: ${e.reason}

\`\`\`
${e.excerpt}
\`\`\`
`).join('\n---\n');

const exitNote = failed === 0 && timedOutCount === 0
  ? `**Exit policy**: all upstream tests green. Exiting 0.`
  : `**Exit policy**: ${failed} upstream test failure(s) + ${timedOutCount} crash(es)/timeout(s). Exiting 1. Known-open items tracked in the acceptance ledger, not in runner-level tolerances.`;

const sampleOutput = allResults
  .flatMap(r => r.stdout.split('\n').filter(l => l.match(/^(PASS|FAIL|SKIP|UNTESTED):/)))
  .slice(0, 200)
  .join('\n');

const doc = `# BusyBox Upstream Testsuite on Yurt — ${new Date().toISOString().split('T')[0]}

**Runner**: \`scripts/run-busybox-testsuite-in-sandbox.ts\`
**Elapsed**: ${elapsedSec}s
**BusyBox binary**: \`packages/c-ports/busybox/build/busybox.wasm\`
**Sandbox fixtures**: \`packages/kernel/src/platform/__tests__/fixtures/\`

## Important Context: Minimal BusyBox Build

The BusyBox binary in the yurt fixtures is built with a **minimal .config** (only \`grep\`, \`head\`, \`seq\` enabled) as a canary for the guest-compat runtime. The full upstream testsuite has 66+ applet test files; only tests for those 3 applets produce meaningful results. All other applet tests self-SKIP via the CONFIG_ flag checks in the test harness.

**Follow-up tracked**: Full BusyBox build with all applets enabled is needed for comprehensive upstream testsuite validation. See docs/superpowers/plans/ for Phase B scope.

## Infrastructure Gap: runtest "implemented" Detection

The upstream \`runtest\` script uses a shell pipeline pattern that doesn't work in the sandbox:
1. **Absolute-path subprocess spawning**: \`/tmp/testsuite/busybox\` (a VFS symlink to \`/usr/bin/busybox\`) fails when the sandbox process manager tries to resolve it — the host error "No such file or directory" occurs because VFS symlinks don't resolve to host filesystem paths.
2. **xargs-within-while-read pipeline**: \`xargs\` inside a \`while read\` loop piped from a subprocess doesn't receive stdin from the pipe correctly.

**Workaround**: This runner bypasses \`runtest\` and invokes each \`.tests\` file directly with the proper env. Uses a shell wrapper at \`/tmp/testsuite/busybox\` (not a symlink) to work around issue 1.

**Classification**: \`runtime-gap\` — tracked follow-up for shell subprocess stdin routing and VFS symlink resolution in absolute-path spawn context.

## Infrastructure Gap: bc/interactive stdin hang

Tests that run interactive programs (e.g., \`bc.tests\`) hang indefinitely because the program waits for stdin to close, but the sandbox shell doesn't send EOF after the pipe input. This is a sandbox shell pipe EOF delivery gap.

Each \`.tests\` file is run in a fresh sandbox with a ${PER_TEST_TIMEOUT_MS / 1000}s timeout to protect against this.

**Classification**: \`runtime-gap\` — shell pipe EOF not delivered to subprocess stdin when shell command completes.

## Summary

| Category | Count |
|---|---|
| PASS | ${passed} |
| FAIL | ${failed} |
| SKIP | ${skipped} |
| UNTESTED | ${untested} |
| **Total** | **${total}** |
| Timed out / crashed | ${timedOutCount} |

### Failure breakdown

| Classification | Count |
|---|---|
| \`needs-fork\` | ${tally['needs-fork']} |
| \`runtime-gap\` | ${tally['runtime-gap']} |
| \`test-env\` | ${tally['test-env']} |
| \`unknown\` | ${tally['unknown']} |

${exitNote}

## Classification Key

- **\`needs-fork\`**: Genuine §Non-Goals per spec lines 76–88 (\`fork()\`/\`execve()\`/job control). Legit skip.
- **\`runtime-gap\`**: Yurt should support this, currently doesn't. Tracked follow-up needed.
- **\`test-env\`**: Test expects specific env (TTY, root, /proc, network) not provided by sandbox. Usually harness-setup fix.
- **\`unknown\`**: Insufficient info; needs investigation.

## Per-Failure Details

${failEntries.length === 0 ? '_No failures!_' : failSections}

## Test Result Summary

\`\`\`
${sampleOutput}
\`\`\`
`;

writeFileSync(FINDINGS_FILE, doc, 'utf-8');
console.log(`[busybox-testsuite] findings written to ${FINDINGS_FILE}`);

// ---------------------------------------------------------------------------
// Exit code
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n[busybox-testsuite] FAIL: ${failed} upstream test failure(s).`);
  console.error(`  needs-fork: ${tally['needs-fork']}, runtime-gap: ${tally['runtime-gap']}, test-env: ${tally['test-env']}, unknown: ${tally['unknown']}`);
  Deno.exit(1);
} else {
  console.log(`\n[busybox-testsuite] OK: ${passed} pass, ${skipped} skip, ${untested} untested`);
  Deno.exit(0);
}
