import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');
const ZSH_SRC_DIR = resolve(import.meta.dirname!, '../../../../test-fixtures/c-ports/zsh/src');
const ZSH_TEST_DIR = join(ZSH_SRC_DIR, 'Test');
const ZSH_TEST_ROOT = '/tmp/zsh-src';

/**
 * The upstream harness lives in the extracted/configured zsh source tree,
 * produced only by `make -C test-fixtures/c-ports/zsh` (tarball extract +
 * configure + `make -C Src prep`). In CI the build step is skipped on a
 * zsh-fixture cache hit, so the cache `path:` in
 * .github/workflows/guest-compat.yml MUST restore
 * `test-fixtures/c-ports/zsh/src` alongside zsh.wasm. If it does not, fail
 * with an explicit message naming the missing tree instead of a bare
 * `ENOENT … runtests.zsh` (the #210-class regression this guard names).
 */
function assertZshSourceTreePresent(): void {
  const runtests = join(ZSH_TEST_DIR, 'runtests.zsh');
  if (!existsSync(runtests)) {
    throw new Error(
      `zsh upstream source tree missing: ${runtests} not found.\n` +
        `Expected the extracted zsh source under ${ZSH_SRC_DIR}. In CI this ` +
        `tree is produced by \`make -C test-fixtures/c-ports/zsh\` and, on a ` +
        `zsh-fixture cache hit (build skipped), must be restored by the ` +
        `"Cache zsh fixture" actions/cache \`path:\` in ` +
        `.github/workflows/guest-compat.yml (it must list ` +
        `test-fixtures/c-ports/zsh/src, not only zsh.wasm). ` +
        `Locally, run: make -C test-fixtures/c-ports/zsh copy-fixtures`,
    );
  }
}

const enc = (s: string) => new TextEncoder().encode(s);

const ZSH_CORE_TESTS = [
  'A01grammar.ztst',
  'A02alias.ztst',
  'A03quoting.ztst',
  'A04redirect.ztst',
  'A05execution.ztst',
  'A06assign.ztst',
  'A07control.ztst',
  'B01cd.ztst',
  'B02typeset.ztst',
  'B03print.ztst',
  'B04read.ztst',
  'B05eval.ztst',
  'B06fc.ztst',
  'B07emulate.ztst',
  'B08shift.ztst',
  'B09hash.ztst',
  'B10getopts.ztst',
  'B11kill.ztst',
  'B12limit.ztst',
  'B13whence.ztst',
  'C01arith.ztst',
  'C02cond.ztst',
  'C03traps.ztst',
  'C04funcdef.ztst',
  'C05debug.ztst',
  'D02glob.ztst',
  'D04parameter.ztst',
  'D05array.ztst',
  'D06subscript.ztst',
  'D08cmdsubst.ztst',
  'D09brace.ztst',
];

function selectedZshTests(): string[] {
  const selected = Deno.env.get('ZSH_UPSTREAM_TESTS');
  if (!selected) return ZSH_CORE_TESTS;
  return selected.split(',').map((name) => name.trim()).filter(Boolean);
}

async function zshTestFiles(names: string[]): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const name of ['runtests.zsh', 'ztst.zsh', ...names]) {
    files[`Test/${name}`] = await readFile(join(ZSH_TEST_DIR, name));
  }
  for (const name of ['globtests', 'globtests.ksh']) {
    files[`Misc/${name}`] = await readFile(join(ZSH_SRC_DIR, 'Misc', name));
  }
  files['config.modules'] = await readFile(join(ZSH_SRC_DIR, 'config.modules'));
  for (const path of await filesUnder(join(ZSH_SRC_DIR, 'Functions'))) {
    files[relative(ZSH_SRC_DIR, path)] = await readFile(path);
  }
  for (const path of await filesUnder(join(ZSH_SRC_DIR, 'Src'))) {
    if (path.endsWith('.mdd')) {
      files[relative(ZSH_SRC_DIR, path)] = await readFile(path);
    }
  }
  return files;
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await filesUnder(path));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

function mkdirp(sandbox: Sandbox, path: string): void {
  let current = '';
  for (const part of path.split('/')) {
    if (part === '') continue;
    current += `/${part}`;
    try {
      sandbox.mkdir(current);
    } catch {
      // Existing directories are fine for test fixture installation.
    }
  }
}

async function installZshTestTree(sandbox: Sandbox, names: string[]): Promise<void> {
  const files = await zshTestFiles(names);
  for (const [path, data] of Object.entries(files)) {
    const target = `${ZSH_TEST_ROOT}/${path}`;
    mkdirp(sandbox, dirname(target));
    sandbox.writeFile(target, data);
    sandbox.chmod(target, 0o444);
  }

  const zshWasm = await readFile(resolve(FIXTURES, 'zsh.wasm'));
  mkdirp(sandbox, `${ZSH_TEST_ROOT}/Src`);
  sandbox.writeFile(`${ZSH_TEST_ROOT}/Src/zsh`, zshWasm);
  sandbox.chmod(`${ZSH_TEST_ROOT}/Src/zsh`, 0o555);
}

async function allZshTestNames(): Promise<string[]> {
  const entries = await readdir(ZSH_TEST_DIR);
  return entries
    .filter((name) => name.endsWith('.ztst'))
    .sort();
}

describe('zsh upstream test harness', { sanitizeOps: false, sanitizeResources: false }, () => {
  let sandbox: Sandbox | null = null;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = null;
  });

  async function runZshTests(names: string[]) {
    assertZshSourceTreePresent();
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      timeoutMs: 360_000,
    });
    sandbox.startHostSession();
    await installZshTestTree(sandbox, names);

    const testList = names.map((name) => `${ZSH_TEST_ROOT}/Test/${name}`).join('\n');
    const verbose = Deno.env.get('ZSH_UPSTREAM_VERBOSE');
    sandbox.writeFile('/tmp/run-zsh-tests.zsh', enc([
      'emulate zsh',
      `ZTST_testlist=$'${testList}'`,
      `ZTST_srcdir=${ZSH_TEST_ROOT}/Test`,
      'ZTST_exe=/usr/bin/zsh',
      ...(verbose ? [`ZTST_verbose=${verbose}`] : []),
      'export ZTST_testlist ZTST_srcdir ZTST_exe ZTST_verbose',
      `cd ${ZSH_TEST_ROOT}/Test`,
      `/usr/bin/zsh +Z -f ${ZSH_TEST_ROOT}/Test/runtests.zsh`,
      '',
    ].join('\n')));

    return await sandbox.run('zsh -f /tmp/run-zsh-tests.zsh 2>&1');
  }

  it('runs zsh upstream grammar and execution tests inside Yurt', async () => {
    const tests = selectedZshTests();
    const result = await runZshTests(tests);
    if (result.exitCode !== 0) {
      throw new Error(
        `zsh upstream execution tests exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.stdout).toContain('0 failures');
    const summary = result.stdout.match(/(\d+) successful test scripts?, 0 failures, (\d+) skipped/);
    expect(summary).not.toBeNull();
    expect(Number(summary![1]) + Number(summary![2])).toBe(tests.length);
  });

  it.ignore('runs the full upstream zsh test list inside Yurt', async () => {
    const result = await runZshTests(await allZshTestNames());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('0 failures');
  });
});
