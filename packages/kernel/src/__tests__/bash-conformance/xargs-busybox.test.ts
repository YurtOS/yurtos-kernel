/**
 * xargs conformance tests.
 * Based on busybox/GNU coreutils test patterns.
 *
 * Note: in this WASM shell, xargs constructs command lines and writes them to
 * stdout rather than executing them. When no command is given, it simply joins
 * stdin tokens with spaces (useful for line-to-single-line conversions).
 *
 * Covers:
 *   - Default: join all whitespace-split tokens on one line
 *   - Multiline stdin collapsed to single space-joined output
 *   - -n N: chunk items N at a time (one chunk per line)
 *   - -I TOKEN: replace TOKEN in template, one line per input line
 *   - Empty stdin: no output
 *   - Multiple whitespace collapsed
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

describe('xargs busybox', () => {
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
  // Default: join all tokens (no command argument)
  // ---------------------------------------------------------------------------
  describe('default: join stdin tokens', () => {
    it('multiline stdin collapsed to space-separated single line', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | xargs");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a b c\n');
    });

    it('space-separated tokens on one line pass through joined', async () => {
      const r = await runner.run("printf 'x y z\\n' | xargs");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x y z\n');
    });

    it('multiple whitespace between tokens collapsed', async () => {
      const r = await runner.run("printf 'a  b   c\\n' | xargs");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a b c\n');
    });

    it('seq output collapsed to single line', async () => {
      const r = await runner.run('seq 5 | xargs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 2 3 4 5\n');
    });

    it('empty stdin: no output', async () => {
      const r = await runner.run("printf '' | xargs");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('whitespace-only stdin: no output', async () => {
      const r = await runner.run("printf '   \\n   \\n' | xargs");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // -n N: chunk items N at a time
  // ---------------------------------------------------------------------------
  describe('-n N chunk mode', () => {
    it('-n 2: chunks of 2, each on its own line', async () => {
      const r = await runner.run('seq 6 | xargs -n 2');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 2\n3 4\n5 6\n');
    });

    it('-n 1: each item on its own line', async () => {
      const r = await runner.run('seq 3 | xargs -n 1');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n2\n3\n');
    });

    it('-n 3: chunks of 3 with remainder', async () => {
      // 5 items: [1 2 3], [4 5]
      const r = await runner.run('seq 5 | xargs -n 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 2 3\n4 5\n');
    });

    it('-n larger than item count: single output line', async () => {
      const r = await runner.run('seq 3 | xargs -n 10');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 2 3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -I TOKEN: replace token in template, one replacement per input line
  // ---------------------------------------------------------------------------
  describe('-I TOKEN replace mode', () => {
    it('replaces token in command template with each input line', async () => {
      // cmd_parts = ["echo", "LINE"], token="LINE"
      // each line replaces LINE → "echo x", "echo y", "echo z"
      const r = await runner.run("printf 'x\\ny\\nz\\n' | xargs -I LINE echo LINE");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('echo x\necho y\necho z\n');
    });

    it('replaces {} token when using {} placeholder', async () => {
      const r = await runner.run("printf 'foo\\nbar\\n' | xargs -I{} echo {}");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('echo foo\necho bar\n');
    });

    it('replaces token in middle of command template', async () => {
      const r = await runner.run("printf 'test\\n' | xargs -I X cmd X arg");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('cmd test arg\n');
    });

    it('skips empty lines in -I mode', async () => {
      const r = await runner.run("printf 'a\\n\\nb\\n' | xargs -I X echo X");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('echo a\necho b\n');
    });
  });
});
