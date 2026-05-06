#!/usr/bin/env -S deno run -A
/**
 * Run BusyBox's upstream testsuite inside a yurt sandbox.
 *
 * The BusyBox binary shipped in the yurt fixtures is built from upstream
 * BusyBox with Yurt's .config. Tests that also fail on a pristine Linux
 * BusyBox build are reported as XFAIL; the runner is meant to catch Yurt-only
 * regressions, not upstream BusyBox expectations that fail on Linux too.
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

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { Sandbox } from '../packages/kernel/src/sandbox.js';
import { NodeAdapter } from '../packages/kernel/src/platform/node-adapter.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(REPO_ROOT, 'packages/kernel/src/platform/__tests__/fixtures');
const BUSYBOX_WASM = resolve(REPO_ROOT, 'test-fixtures/c-ports/busybox/build/busybox.wasm');
const BUSYBOX_WASM_FIXTURE = resolve(FIXTURES, 'busybox.wasm');
const TESTSUITE_DIR = resolve(REPO_ROOT, 'test-fixtures/c-ports/busybox/src/testsuite');
const ASH_TEST_DIR = resolve(REPO_ROOT, 'test-fixtures/c-ports/busybox/src/shell/ash_test');
const BUSYBOX_CONFIG = resolve(REPO_ROOT, 'test-fixtures/c-ports/busybox/src/.config');
const FINDINGS_DIR = resolve(REPO_ROOT, 'docs/superpowers/findings');
const FINDINGS_FILE = resolve(FINDINGS_DIR, '2026-04-22-busybox-testsuite-on-yurt.md');
const ASH_HELPER_DIR = resolve(REPO_ROOT, 'test-fixtures/c-ports/busybox/build/ash-test-helpers');
const YURT_CC = resolve(REPO_ROOT, 'target/release/yurt-cc');

// Per-test timeout in ms — guards against bc/interactive test hangs.
// Some upstream ash tests intentionally run large generated matrices; keep
// those as real tests with a larger budget instead of classifying them away.
const PER_TEST_TIMEOUT_MS = Number(Deno.env.get('BUSYBOX_TEST_TIMEOUT_MS') ?? 30_000);
const TEST_FILTER = Deno.env.get('BUSYBOX_TEST_FILTER') ?? '';
const SINGLE_ASH_TEST = Deno.env.get('BUSYBOX_ASH_SINGLE_TEST') ?? '';
const RUNTIME_BACKEND = Deno.env.get('YURT_RUNTIME_BACKEND') ?? 'deno-cooperative';
const RUN_INTERNET_TESTS = Deno.env.get('BUSYBOX_RUN_INTERNET_TESTS') === '1';
const INTERNET_TEST_HOSTS = ['www.google.com', 'google.com'];

const SLOW_TEST_TIMEOUTS_MS = new Map<string, number>([
  ['ash/ash-z_slow/many_ifs.tests', 120_000],
]);

function timeoutForTest(source: string): number {
  return SLOW_TEST_TIMEOUTS_MS.get(source) ?? PER_TEST_TIMEOUT_MS;
}

const HOST_BASELINE_FAILURES = new Map<string, string>([
  [
    'ash/ash-heredoc/heredoc_backslash1.tests',
    'Reproduces on pristine BusyBox 1.37.0 ash on arm64 Linux; not a Yurt-only regression.',
  ],
  [
    'ash/ash-heredoc/heredoc_bkslash_newline2.tests',
    'Reproduces on pristine BusyBox 1.37.0 ash on arm64 Linux; not a Yurt-only regression.',
  ],
  [
    'ash/ash-quoting/bkslash_in_varexp.tests',
    'Reproduces on BusyBox ash on arm64 Linux: libc fnmatch("[a\\]]") matches "]" and "a", not "a]". Not a Yurt-only regression.',
  ],
]);

function hostBaselineReason(source: string): string | undefined {
  return HOST_BASELINE_FAILURES.get(source);
}

const PREEMPTIVE_BACKEND_REQUIRED = new Map<string, string>([
  [
    'ash/ash-signals/continue_and_trap1.tests',
    'Requires a backend that can preempt guest wasm without cooperative host imports. Expected to pass on a Wasmtime epoch-interruption backend.',
  ],
]);

function backendSupportsPreemption(backend: string): boolean {
  return backend.toLowerCase().includes('wasmtime');
}

function preemptiveBackendRequiredReason(source: string): string | undefined {
  if (backendSupportsPreemption(RUNTIME_BACKEND)) return undefined;
  return PREEMPTIVE_BACKEND_REQUIRED.get(source);
}


// ---------------------------------------------------------------------------
// Step 1: ensure busybox.wasm is built
// ---------------------------------------------------------------------------

if (!existsSync(BUSYBOX_WASM)) {
  console.log('[busybox-testsuite] busybox.wasm not found at build/, running make...');
  execSync('make -C test-fixtures/c-ports/busybox all', { cwd: REPO_ROOT, stdio: 'inherit' });
}
if (!existsSync(BUSYBOX_WASM_FIXTURE)) {
  console.log('[busybox-testsuite] copying busybox.wasm to fixtures...');
  execSync(`cp "${BUSYBOX_WASM}" "${BUSYBOX_WASM_FIXTURE}"`);
}

function ensureAshHelper(name: 'printenv' | 'recho' | 'zecho'): string {
  const out = resolve(ASH_HELPER_DIR, `${name}.wasm`);
  const src = resolve(ASH_TEST_DIR, `${name}.c`);
  if (!existsSync(out) || statSync(out).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(ASH_HELPER_DIR, { recursive: true });
    if (!existsSync(YURT_CC)) {
      execSync('cargo build --release -p yurt-toolchain', { cwd: REPO_ROOT, stdio: 'inherit' });
    }
    execSync(`"${YURT_CC}" -std=gnu89 "${src}" -o "${out}"`, { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  return out;
}

const ASH_HELPERS = {
  printenv: ensureAshHelper('printenv'),
  recho: ensureAshHelper('recho'),
  zecho: ensureAshHelper('zecho'),
};

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
//     for tests whose applet is provided outside the multicall binary).
// Skip only if NEITHER source provides the applet; otherwise the tests would
// fall over with "applet not found" / "command not found" through no fault of
// our runtime. Missing optional applets such as tsort are canonical examples:
// if neither BusyBox nor a standalone fixture provides them, report UNTESTED.
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
  const normalized = applet.replace(/-/g, '_');
  return enabledApplets.has(applet) || enabledApplets.has(normalized) ||
    standaloneTools.has(applet) || standaloneTools.has(normalized);
}

const OUT_OF_SCOPE_APPLETS = new Map<string, string>([
  ['mkfs.minix', 'filesystem image construction is not a YurtOS kernel/runtime compatibility target'],
  ['mkfs_minix', 'filesystem image construction is not a YurtOS kernel/runtime compatibility target'],
]);

function unavailableAppletRecord(testFile: string, applet: string): RunRecord {
  const reason = OUT_OF_SCOPE_APPLETS.get(applet) ?? OUT_OF_SCOPE_APPLETS.get(applet.replace(/-/g, '_'));
  if (reason) {
    return {
      testFile,
      stdout: `SKIPPED: ${testFile} (${reason})\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return {
    testFile,
    stdout: `UNTESTED: ${testFile} (applet not available — neither in BusyBox config nor standalone fixture)\n`,
    stderr: '',
    exitCode: 0,
  };
}

const baseEnvStr = [
  'bindir=/tmp/testsuite',
  'tsdir=/tmp/testsuite',
  'LINKSDIR=/tmp/testsuite/runtest-tempdir-links',
  'PATH="/tmp/testsuite/runtest-tempdir-links:/usr/bin:/bin:$PATH"',
  'VERBOSE=1',
  RUN_INTERNET_TESTS ? '' : 'SKIP_INTERNET_TESTS=1',
  `OPTIONFLAGS="${optionFlags}"`,
].filter(Boolean).join(' ');

const configEnv = Object.fromEntries(
  configContent.split('\n')
    .filter(l => l.match(/^CONFIG_[A-Z0-9_]+=/))
    .map(l => {
      const eq = l.indexOf('=');
      const key = l.slice(0, eq);
      let value = l.slice(eq + 1);
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      return [key, value];
    }),
);

async function setupSandbox(): Promise<Sandbox> {
  const sb = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    timeoutMs: PER_TEST_TIMEOUT_MS,
    ...(RUN_INTERNET_TESTS ? { network: { allowedHosts: INTERNET_TEST_HOSTS } } : {}),
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

async function setupAshSandbox(): Promise<Sandbox> {
  const sb = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    timeoutMs: PER_TEST_TIMEOUT_MS,
  });
  uploadDir(sb, ASH_TEST_DIR, '/tmp/ash_test');
  sb.writeFile('/tmp/ash_test/ash', new Uint8Array(readFileSync(BUSYBOX_WASM_FIXTURE)));
  sb.writeFile('/tmp/ash_test/printenv', new Uint8Array(readFileSync(ASH_HELPERS.printenv)));
  sb.writeFile('/tmp/ash_test/recho', new Uint8Array(readFileSync(ASH_HELPERS.recho)));
  sb.writeFile('/tmp/ash_test/zecho', new Uint8Array(readFileSync(ASH_HELPERS.zecho)));
  if (existsSync(BUSYBOX_CONFIG)) {
    sb.writeFile('/tmp/ash_test/.config', new Uint8Array(readFileSync(BUSYBOX_CONFIG)));
  }
  sb.chmod('/tmp/ash_test/ash', 0o755);
  sb.chmod('/tmp/ash_test/printenv', 0o755);
  sb.chmod('/tmp/ash_test/recho', 0o755);
  sb.chmod('/tmp/ash_test/zecho', 0o755);
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

function normalizeAshOutput(output: string): string {
  return output
    .split('\n')
    .filter(line => line !== 'ash: using fallback suid method')
    .map(line => line.replace(/: invalid option '([^']+)'/g, ': invalid option $1'))
    .join('\n');
}

function diffPreview(actual: string, expected: string): string {
  if (actual === expected) return '';
  return [
    'expected:',
    expected.slice(0, 1000),
    'actual:',
    actual.slice(0, 1000),
  ].join('\n');
}

async function runAshTest(testPath: string): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean
}> {
  const sb = await setupAshSandbox();
  const relDir = testPath.substring(0, testPath.lastIndexOf('/'));
  const testName = testPath.substring(testPath.lastIndexOf('/') + 1);
  const rightName = testName.replace(/\.tests$/, '.right');
  const expectedPath = resolve(ASH_TEST_DIR, relDir, rightName);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('TEST_TIMEOUT')), PER_TEST_TIMEOUT_MS)
  );
  const env = {
    ...configEnv,
    PATH: '/tmp/ash_test:/usr/bin:/bin',
    THIS_SH: '/tmp/ash_test/ash',
  };
  try {
    const proc = await Promise.race([
      sb.spawn(['/tmp/ash_test/ash', `./${testName}`], {
        cwd: `/tmp/ash_test/${relDir}`,
        env,
        stderrToStdout: true,
      }),
      timeout,
    ]);
    const stdout = proc.fdReadAndClear(1).data;
    const stderr = proc.fdReadAndClear(2).data;
    sb.destroy();
    const exitCode = proc.exitCode ?? 0;
    if (exitCode === 77) {
      return {
        stdout: `SKIP: ash ${testPath} (feature disabled)\n`,
        stderr,
        exitCode: 0,
        timedOut: false,
      };
    }
    const actual = normalizeAshOutput(stdout + stderr);
    const expected = normalizeAshOutput(readFileSync(expectedPath, 'utf-8'));
    if (actual === expected) {
      return { stdout: `PASS: ash ${testPath}\n`, stderr: '', exitCode: 0, timedOut: false };
    }
    return {
      stdout: `FAIL: ash ${testPath}\n${diffPreview(actual, expected)}\n`,
      stderr,
      exitCode,
      timedOut: false,
    };
  } catch (e: unknown) {
    try { sb.destroy(); } catch { }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'TEST_TIMEOUT' || msg?.includes('RuntimeError') || msg?.includes('unreachable')) {
      return {
        stdout: `FAIL: ash ${testPath}\n${msg.substring(0, 200)}`,
        stderr: '',
        exitCode: -1,
        timedOut: true,
      };
    }
    if (e instanceof SyntaxError || msg.startsWith('Unexpected token')) {
      return {
        stdout: `FAIL: ash ${testPath}\nJSON-decode failure (likely non-UTF-8 stdout)`,
        stderr: '',
        exitCode: -1,
        timedOut: true,
      };
    }
    throw e;
  }
}

function parseRunRecordJson(stdout: string): {
  stdout: string; stderr: string; exitCode: number; timedOut: boolean
} | null {
  const lines = stdout.trimEnd().split('\n').reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (
        typeof parsed.stdout === 'string' &&
        typeof parsed.stderr === 'string' &&
        typeof parsed.exitCode === 'number' &&
        typeof parsed.timedOut === 'boolean'
      ) {
        return parsed;
      }
    } catch {
      // Keep scanning: compiler warnings can precede the JSON line.
    }
  }
  return null;
}

async function runAshTestIsolated(testPath: string): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean
}> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ['run', '-A', fileURLToPath(import.meta.url)],
    cwd: REPO_ROOT,
    env: {
      ...Deno.env.toObject(),
      BUSYBOX_ASH_SINGLE_TEST: testPath,
      BUSYBOX_TEST_TIMEOUT_MS: String(timeoutForTest(`ash/${testPath}`)),
      NO_COLOR: '1',
    },
    stdout: 'piped',
    stderr: 'piped',
  });
  const child = command.spawn();
  const timeoutMs = timeoutForTest(`ash/${testPath}`) + 5_000;
  let timeoutId: number | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const output = child.output();
  const raced = await Promise.race([output, timeout]);
  if (raced === 'timeout') {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
    try {
      await output;
    } catch {
      // The kill path can reject depending on process timing.
    }
    return {
      stdout: `FAIL: ash ${testPath}\nTEST_TIMEOUT`,
      stderr: '',
      exitCode: -1,
      timedOut: true,
    };
  }
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  const stdout = new TextDecoder().decode(raced.stdout);
  const stderr = new TextDecoder().decode(raced.stderr);
  const parsed = parseRunRecordJson(stdout);
  if (parsed) return parsed;
  return {
    stdout: `FAIL: ash ${testPath}\nChild runner did not return JSON\n${stdout.slice(0, 1000)}`,
    stderr,
    exitCode: raced.code,
    timedOut: false,
  };
}

if (SINGLE_ASH_TEST) {
  const result = await runAshTest(SINGLE_ASH_TEST);
  console.log(JSON.stringify(result));
  Deno.exit(0);
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
  if (TEST_FILTER && !testFile.includes(TEST_FILTER)) continue;
  const applet = appletForTestFile(testFile);
  if (applet !== 'busybox' && !appletAvailable(applet)) {
    // Mirror runtest's "# CONFIG_<APPLET> is not set" skip path. Recorded
    // as a synthetic UNTESTED line so the aggregate counter sees it, except
    // for applets we have deliberately classified outside the kernel/runtime
    // compatibility target.
    allResults.push(unavailableAppletRecord(testFile, applet));
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
      if (TEST_FILTER && !`${dir}/${testCase}`.includes(TEST_FILTER)) continue;
      allResults.push(unavailableAppletRecord(`${dir}/${testCase}`, dir.toLowerCase()));
    }
    continue;
  }
  const items = readdirSync(join(TESTSUITE_DIR, dir));
  for (const testCase of items) {
    if (testCase.startsWith('.') || testCase.endsWith('~')) continue;
    if (TEST_FILTER && !`${dir}/${testCase}`.includes(TEST_FILTER)) continue;
    console.log(`[busybox-testsuite]   ${dir}/${testCase}...`);
    const r = await runOldStyleTest(dir, testCase);
    allResults.push({ testFile: `${dir}/${testCase}`, ...r });
  }
}

// ash's upstream shell tests live outside testsuite/ and compare each
// executable .tests script with a sibling .right file. Run them directly and
// do the comparison on the host side; ash_test/run-all assumes native gcc,
// diff, sed -i, and host executable bits.
const ashTestFiles: string[] = [];
for (const module of readdirSync(ASH_TEST_DIR).filter(f => f.startsWith('ash-')).sort()) {
  const moduleDir = join(ASH_TEST_DIR, module);
  if (!statSync(moduleDir).isDirectory()) continue;
  for (const entry of readdirSync(moduleDir).sort()) {
    if (!entry.endsWith('.tests')) continue;
    const full = join(moduleDir, entry);
    const right = join(moduleDir, entry.replace(/\.tests$/, '.right'));
    if (!existsSync(right)) continue;
    if ((statSync(full).mode & 0o111) === 0) continue;
    ashTestFiles.push(`${module}/${entry}`);
  }
}

for (const testPath of ashTestFiles) {
  if (TEST_FILTER && !`ash/${testPath}`.includes(TEST_FILTER)) continue;
  console.log(`[busybox-testsuite]   ash ${testPath}...`);
  const r = await runAshTestIsolated(testPath);
  const first = r.stdout.split('\n')[0] ?? '';
  if (r.timedOut) {
    console.log(`[busybox-testsuite]   TIMEOUT/CRASH: ash ${testPath}`);
  } else {
    console.log(`[busybox-testsuite]   ${first}`);
  }
  allResults.push({ testFile: `ash/${testPath}`, ...r });
}

const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`[busybox-testsuite] testsuite finished in ${elapsedSec}s`);

// ---------------------------------------------------------------------------
// Parse results
// ---------------------------------------------------------------------------

interface TestResult {
  status: 'PASS' | 'FAIL' | 'XFAIL' | 'SKIP' | 'UNTESTED';
  name: string;
  lines: string[];
  source: string;
  reason?: string;
}

const results: TestResult[] = [];

for (const r of allResults) {
  if (r.timedOut) {
    const applet = r.testFile.split('.')[0].split('/')[0];
    const xfailReason = preemptiveBackendRequiredReason(r.testFile);
    results.push({
      status: xfailReason ? 'XFAIL' : 'FAIL',
      name: `${r.testFile} (TIMEOUT/CRASH)`,
      lines: [`FAIL: ${r.testFile} (TIMEOUT/CRASH)`, r.stderr],
      source: r.testFile,
      reason: xfailReason,
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
      const xfailReason = hostBaselineReason(r.testFile) ?? preemptiveBackendRequiredReason(r.testFile);
      results.push({
        status: xfailReason ? 'XFAIL' : 'FAIL',
        name: failMatch[1].trim(),
        lines: [line, ...diagLines],
        source: r.testFile,
        reason: xfailReason,
      });
    } else if (skipMatch) {
      results.push({ status: 'SKIP', name: skipMatch[1].trim(), lines: [line], source: r.testFile });
    } else if (untestedMatch) {
      results.push({ status: 'UNTESTED', name: untestedMatch[1].trim(), lines: [line], source: r.testFile });
    }
  }
}

const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
const xfailed = results.filter(r => r.status === 'XFAIL').length;
const skipped = results.filter(r => r.status === 'SKIP').length;
const untested = results.filter(r => r.status === 'UNTESTED').length;
const total = passed + failed + xfailed + skipped + untested;
const timedOutCount = allResults.filter(r => r.timedOut).length;
const unexpectedTimedOutCount = results.filter(r => r.status === 'FAIL' && r.name.includes('(TIMEOUT/CRASH)')).length;

console.log(`[busybox-testsuite] Results: ${passed} pass / ${failed} fail / ${xfailed} xfail / ${skipped} skip / ${untested} untested / ${total} total`);
console.log(`[busybox-testsuite] Timed out / crashed: ${timedOutCount}`);

// ---------------------------------------------------------------------------
// Classify failures
// ---------------------------------------------------------------------------

type Classification = 'host-baseline' | 'needs-fork' | 'preemptive-backend' | 'runtime-gap' | 'test-env' | 'unknown';

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
  .filter(r => r.status === 'FAIL' || r.status === 'XFAIL')
  .map(r => {
    const classified = r.status === 'XFAIL'
      ? PREEMPTIVE_BACKEND_REQUIRED.has(r.source)
        ? { classification: 'preemptive-backend' as const, reason: r.reason ?? 'Requires a preemptive backend' }
        : { classification: 'host-baseline' as const, reason: r.reason ?? 'Fails on host baseline too' }
      : classifyFailure(r.name, r.source, r.lines);
    return {
      name: r.name,
      applet: extractApplet(r.source),
      source: r.source,
      excerpt: r.lines.slice(0, 12).join('\n'),
      classification: classified.classification,
      reason: classified.reason,
    };
  });

const tally = { 'host-baseline': 0, 'needs-fork': 0, 'preemptive-backend': 0, 'runtime-gap': 0, 'test-env': 0, 'unknown': 0 };
for (const e of failEntries) tally[e.classification]++;

// ---------------------------------------------------------------------------
// Write findings doc
// ---------------------------------------------------------------------------

mkdirSync(FINDINGS_DIR, { recursive: true });

const failSections = failEntries.map(e => `
### ${e.classification === 'host-baseline' || e.classification === 'preemptive-backend' ? 'XFAIL' : 'FAIL'}: ${e.name}

- **Source**: \`${e.source}\`
- **Applet**: \`${e.applet}\`
- **Classification**: \`${e.classification}\`
- **Reason**: ${e.reason}

\`\`\`
${e.excerpt}
\`\`\`
`).join('\n---\n');

const exitNote = failed === 0
  ? `**Exit policy**: no Yurt-only failures. ${xfailed} expected failure(s) are reported as XFAIL. Exiting 0.`
  : `**Exit policy**: ${failed} Yurt-only failure(s) + ${unexpectedTimedOutCount} unexpected crash(es)/timeout(s). Exiting 1. Expected failures are reported as XFAIL.`;

const sampleOutput = allResults
  .flatMap(r => r.stdout.split('\n').filter(l => l.match(/^(PASS|FAIL|SKIP|SKIPPED|UNTESTED):/)))
  .slice(0, 200)
  .join('\n');

const doc = `# BusyBox Upstream Testsuite on Yurt — ${new Date().toISOString().split('T')[0]}

**Runner**: \`scripts/run-busybox-testsuite-in-sandbox.ts\`
**Runtime backend**: \`${RUNTIME_BACKEND}\`
**Elapsed**: ${elapsedSec}s
**BusyBox binary**: \`test-fixtures/c-ports/busybox/build/busybox.wasm\`
**Sandbox fixtures**: \`packages/kernel/src/platform/__tests__/fixtures/\`

## Important Context: BusyBox Build Scope

The BusyBox binary in the yurt fixtures is built from upstream BusyBox with Yurt's .config. The runner treats enabled BusyBox applets and standalone Yurt fixtures as available test targets; tests for applets that neither source provides are reported as UNTESTED, matching the upstream testsuite's "applet not available" behavior.

Host-baseline failures are checked against a pristine BusyBox 1.37.0 build on arm64 Linux and reported as XFAIL rather than Yurt regressions.

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
| XFAIL | ${xfailed} |
| SKIP | ${skipped} |
| UNTESTED | ${untested} |
| **Total** | **${total}** |
| Timed out / crashed | ${timedOutCount} |
| Unexpected timed out / crashed | ${unexpectedTimedOutCount} |

### Failure breakdown

| Classification | Count |
|---|---|
| \`host-baseline\` | ${tally['host-baseline']} |
| \`needs-fork\` | ${tally['needs-fork']} |
| \`preemptive-backend\` | ${tally['preemptive-backend']} |
| \`runtime-gap\` | ${tally['runtime-gap']} |
| \`test-env\` | ${tally['test-env']} |
| \`unknown\` | ${tally['unknown']} |

${exitNote}

## Classification Key

- **\`host-baseline\`**: Reproduces on pristine BusyBox 1.37.0 on Linux. Not counted as a Yurt-only regression.
- **\`needs-fork\`**: Genuine §Non-Goals per spec lines 76–88 (\`fork()\`/\`execve()\`/job control). Legit skip.
- **\`preemptive-backend\`**: Requires an engine that can interrupt guest wasm while it is not calling host imports. The current cooperative Deno runner cannot prove this; a Wasmtime epoch-interruption runner should require it to pass.
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
  console.error(`\n[busybox-testsuite] FAIL: ${failed} Yurt-only test failure(s).`);
  console.error(`  host-baseline: ${tally['host-baseline']}, needs-fork: ${tally['needs-fork']}, preemptive-backend: ${tally['preemptive-backend']}, runtime-gap: ${tally['runtime-gap']}, test-env: ${tally['test-env']}, unknown: ${tally['unknown']}`);
  Deno.exit(1);
} else {
  console.log(`\n[busybox-testsuite] OK: ${passed} pass, ${xfailed} xfail, ${skipped} skip, ${untested} untested`);
  Deno.exit(0);
}
