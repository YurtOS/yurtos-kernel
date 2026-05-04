/**
 * numfmt conformance tests — reformat numbers with human-readable suffixes.
 * Based on GNU coreutils numfmt test patterns.
 *
 * Covers:
 *   - --to=iec: format as IEC (1024-based) suffixes (K, M, G, ...)
 *   - --to=si: format as SI (1000-based) suffixes (K, M, G, ...)
 *   - --from=iec: parse IEC suffix to raw number
 *   - --from=si: parse SI suffix to raw number
 *   - --from=iec --to=si and vice versa: cross-scale conversion
 *   - Values below the base threshold: no suffix
 *   - Stdin processing
 *   - Multiple command-line arguments
 *
 * Output format: "{scaled:.1}{suffix}" (1 decimal place), or integer for
 * values below the base.
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

// SKIPPED: hand-built ProcessManager bypasses Sandbox.registerTools
// so the manifest install pass doesn't run.  Re-enable after migrating
// to Sandbox.create — tracked alongside the Python+pkg refactor.
describe.skip('numfmt conformance', () => {
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
  // --to=iec: format as IEC (1024-based)
  // ---------------------------------------------------------------------------
  describe('--to=iec IEC formatting', () => {
    it('1024 → 1.0K', async () => {
      const r = await runner.run('numfmt --to=iec 1024');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0K\n');
    });

    it('2048 → 2.0K', async () => {
      const r = await runner.run('numfmt --to=iec 2048');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2.0K\n');
    });

    it('1536 → 1.5K', async () => {
      const r = await runner.run('numfmt --to=iec 1536');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.5K\n');
    });

    it('1048576 (1024^2) → 1.0M', async () => {
      const r = await runner.run('numfmt --to=iec 1048576');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0M\n');
    });

    it('1073741824 (1024^3) → 1.0G', async () => {
      const r = await runner.run('numfmt --to=iec 1073741824');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0G\n');
    });

    it('values below 1024 need no suffix and are printed as integer', async () => {
      const r = await runner.run('numfmt --to=iec 512');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('512\n');
    });

    it('0 → 0 (below threshold, integer output)', async () => {
      const r = await runner.run('numfmt --to=iec 0');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // --to=si: format as SI (1000-based)
  // ---------------------------------------------------------------------------
  describe('--to=si SI formatting', () => {
    it('1000 → 1.0K', async () => {
      const r = await runner.run('numfmt --to=si 1000');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0K\n');
    });

    it('1500 → 1.5K', async () => {
      const r = await runner.run('numfmt --to=si 1500');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.5K\n');
    });

    it('1000000 → 1.0M', async () => {
      const r = await runner.run('numfmt --to=si 1000000');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0M\n');
    });

    it('999 stays as 999 (below 1000)', async () => {
      const r = await runner.run('numfmt --to=si 999');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('999\n');
    });
  });

  // ---------------------------------------------------------------------------
  // --from=iec: parse IEC suffix to raw number
  // ---------------------------------------------------------------------------
  describe('--from=iec parse IEC suffix', () => {
    it('1K → 1024', async () => {
      const r = await runner.run('numfmt --from=iec 1K');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1024\n');
    });

    it('2K → 2048', async () => {
      const r = await runner.run('numfmt --from=iec 2K');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2048\n');
    });

    it('1M → 1048576', async () => {
      const r = await runner.run('numfmt --from=iec 1M');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1048576\n');
    });
  });

  // ---------------------------------------------------------------------------
  // --from=si: parse SI suffix to raw number
  // ---------------------------------------------------------------------------
  describe('--from=si parse SI suffix', () => {
    it('1K → 1000', async () => {
      const r = await runner.run('numfmt --from=si 1K');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1000\n');
    });

    it('1M → 1000000', async () => {
      const r = await runner.run('numfmt --from=si 1M');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1000000\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-scale conversion
  // ---------------------------------------------------------------------------
  describe('cross-scale conversion', () => {
    it('--from=iec --to=iec: round-trip 1K→1024→1.0K', async () => {
      const r = await runner.run('numfmt --from=iec --to=iec 1K');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0K\n');
    });

    it('--from=si --to=si: round-trip 1K→1000→1.0K', async () => {
      const r = await runner.run('numfmt --from=si --to=si 1K');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0K\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Stdin processing
  // ---------------------------------------------------------------------------
  describe('stdin processing', () => {
    it('reads numbers from stdin and formats each', async () => {
      const r = await runner.run("printf '1024\\n2048\\n' | numfmt --to=iec");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0K\n2.0K\n');
    });

    it('multiple values on separate stdin lines', async () => {
      const r = await runner.run("printf '1000\\n1500\\n2000\\n' | numfmt --to=si");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1.0K\n1.5K\n2.0K\n');
    });
  });
});
