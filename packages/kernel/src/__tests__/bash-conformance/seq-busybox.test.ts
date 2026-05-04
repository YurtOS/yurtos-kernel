/**
 * seq tests ported from busybox/testsuite/seq.tests (GPLv2).
 *
 * Covers:
 *   - seq N: 1 to N (step 1)
 *   - seq M N: M to N (step 1)
 *   - seq M STEP N: M to N by STEP
 *   - Descending sequences (negative step)
 *   - N=0 / step=0 edge cases
 *   - Negative start values
 */
import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';

import { ResidentBashRunner } from '../../resident-bash-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures');
const SHELL_EXEC_WASM = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures/yurt-shell-exec.wasm');

const TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'true', 'false',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr',
  'diff', 'du', 'df',
  'gzip', 'gunzip', 'tar',
  'bc', 'dc',
  'sqlite3',
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
  'rg',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

describe('seq busybox', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }
    await mgr.preloadModules();
    runner = await ResidentBashRunner.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
    });
  });

  // ---------------------------------------------------------------------------
  // seq N: 1 to N
  // ---------------------------------------------------------------------------
  describe('seq N (1 to N)', () => {
    it('seq 5 produces 1 through 5', async () => {
      const r = await runner.run('seq 5');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n2\n3\n4\n5\n');
    });

    it('seq 1 produces only 1', async () => {
      const r = await runner.run('seq 1');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('seq 0 produces no output (1 > 0)', async () => {
      const r = await runner.run('seq 0');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('seq 3 produces 1 2 3', async () => {
      const r = await runner.run('seq 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n2\n3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // seq M N: M to N step 1
  // ---------------------------------------------------------------------------
  describe('seq M N (range)', () => {
    it('seq 3 7 produces 3 through 7', async () => {
      const r = await runner.run('seq 3 7');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n4\n5\n6\n7\n');
    });

    it('seq 5 5 produces a single number', async () => {
      const r = await runner.run('seq 5 5');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n');
    });

    it('seq 5 3 produces no output (start > end with positive step)', async () => {
      const r = await runner.run('seq 5 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('seq -2 2 includes negative numbers', async () => {
      const r = await runner.run('seq -2 2');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('-2\n-1\n0\n1\n2\n');
    });

    it('seq -3 -1 counts negative range', async () => {
      const r = await runner.run('seq -3 -1');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('-3\n-2\n-1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // seq M STEP N: custom step
  // ---------------------------------------------------------------------------
  describe('seq M STEP N (custom step)', () => {
    it('seq 1 2 9 steps by 2', async () => {
      const r = await runner.run('seq 1 2 9');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n3\n5\n7\n9\n');
    });

    it('seq 1 3 10 steps by 3', async () => {
      const r = await runner.run('seq 1 3 10');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n4\n7\n10\n');
    });

    it('seq 0 5 20 steps by 5', async () => {
      const r = await runner.run('seq 0 5 20');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0\n5\n10\n15\n20\n');
    });

    it('step larger than range: produces only start', async () => {
      const r = await runner.run('seq 1 10 5');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Descending sequences (negative step)
  // ---------------------------------------------------------------------------
  describe('descending sequences', () => {
    it('seq 5 -1 1 counts down from 5 to 1', async () => {
      const r = await runner.run('seq 5 -1 1');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n4\n3\n2\n1\n');
    });

    it('seq 10 -2 2 counts down by 2', async () => {
      const r = await runner.run('seq 10 -2 2');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('10\n8\n6\n4\n2\n');
    });

    it('seq 3 -1 3 produces single value', async () => {
      const r = await runner.run('seq 3 -1 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n');
    });

    it('negative step with start < end: no output', async () => {
      const r = await runner.run('seq 1 -1 5');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline usage
  // ---------------------------------------------------------------------------
  describe('pipeline usage', () => {
    it('seq output can be piped to head', async () => {
      const r = await runner.run('seq 10 | head -n 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n2\n3\n');
    });

    it('seq output can be piped to wc -l', async () => {
      const r = await runner.run('seq 5 | wc -l');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       5\n');
    });
  });
});
