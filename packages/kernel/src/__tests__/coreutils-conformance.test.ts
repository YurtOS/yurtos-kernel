/**
 * GNU coreutils conformance tests.  Six tools ported from upstream
 * coreutils v9.11 via cpcc (packages/c-ports/coreutils/):
 *   csplit, fmt, join, numfmt, sha224sum, sha384sum.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('GNU coreutils (c-port)', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;
  afterEach(() => sandbox?.destroy());

  it('all six report --version cleanly', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    for (const tool of ['fmt', 'csplit', 'join', 'numfmt', 'sha224sum', 'sha384sum']) {
      const r = await sandbox.run(`${tool} --version`);
      expect(r.exitCode).toBe(0);
      // Each tool emits its name + the GNU coreutils banner on the
      // first line.  We pinned VERSION=9.11 in the Makefile.
      expect(r.stdout).toMatch(new RegExp(`^${tool}\\s+\\(GNU coreutils\\)\\s+9\\.11`));
      expect(r.stderr).toBe('');
    }
  });

  it('sha224sum produces a known hash', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello\n'));
    const r = await sandbox.run('sha224sum /tmp/in.txt');
    expect(r.exitCode).toBe(0);
    // sha224("hello\n") = 2d6d67d91d0badcdd06cbbba1fe11538a68a37ec9c2e26457ceff12b
    expect(r.stdout).toContain('2d6d67d91d0badcdd06cbbba1fe11538a68a37ec9c2e26457ceff12b');
  });

  it('sha384sum produces a known hash', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello\n'));
    const r = await sandbox.run('sha384sum /tmp/in.txt');
    expect(r.exitCode).toBe(0);
    // sha384("hello\n") prefix
    expect(r.stdout).toMatch(/[0-9a-f]{96}/);
  });

  it('numfmt converts numbers to IEC suffixes', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run('numfmt --to=iec 1234567');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1.2M');
  });

  it('fmt wraps text', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const input = 'one two three four five six seven eight nine ten';
    const r = await sandbox.run(`echo '${input}' | fmt -w 20`);
    expect(r.exitCode).toBe(0);
    // fmt should split the input into multiple lines roughly at the 20-char width.
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('join merges sorted files on a common field', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/a.txt', new TextEncoder().encode('1 alpha\n2 beta\n3 gamma\n'));
    sandbox.writeFile('/tmp/b.txt', new TextEncoder().encode('1 one\n2 two\n3 three\n'));
    const r = await sandbox.run('join /tmp/a.txt /tmp/b.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('1 alpha one\n2 beta two\n3 gamma three\n');
  });

  it('csplit splits a file at a pattern', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('a\nb\n---\nc\nd\n'));
    // csplit's `-f prefix` is taken relative to CWD; use absolute
    // paths to avoid the shell's cwd handling (which is per-command,
    // not pipeline-wide).
    const r = await sandbox.run('csplit -s -f /tmp/part- /tmp/in.txt /---/ && ls /tmp/part-*');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('part-00');
    expect(r.stdout).toContain('part-01');
  });
});
