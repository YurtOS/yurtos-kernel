/**
 * base64 conformance tests.
 * Based on POSIX/RFC 4648 and busybox test patterns.
 *
 * Covers:
 *   - Encoding: standard Base64 alphabet, 76-char line wrap
 *   - Decoding: -d flag, ignores whitespace in input
 *   - Known vectors: "hello" → "aGVsbG8=", "hello\n" → "aGVsbG8K"
 *   - Empty input: no output
 *   - Round-trip: encode then decode recovers original
 *   - Padding: 1-byte remainder → "==", 2-byte remainder → "="
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

describe('base64 conformance', () => {
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
  // Encoding known vectors
  // ---------------------------------------------------------------------------
  describe('encoding known vectors', () => {
    it('"hello" (no newline) → "aGVsbG8="', async () => {
      const r = await runner.run("printf 'hello' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('aGVsbG8=\n');
    });

    it('"hello\\n" (with newline) → "aGVsbG8K"', async () => {
      const r = await runner.run("printf 'hello\\n' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('aGVsbG8K\n');
    });

    it('"Man" (3 bytes, no padding) → "TWFu"', async () => {
      const r = await runner.run("printf 'Man' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('TWFu\n');
    });

    it('"Ma" (2 bytes, one pad) → "TWE="', async () => {
      const r = await runner.run("printf 'Ma' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('TWE=\n');
    });

    it('"M" (1 byte, two pads) → "TQ=="', async () => {
      const r = await runner.run("printf 'M' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('TQ==\n');
    });

    it('empty input: no output', async () => {
      const r = await runner.run("printf '' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('"abc" → "YWJj"', async () => {
      const r = await runner.run("printf 'abc' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('YWJj\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Decoding
  // ---------------------------------------------------------------------------
  describe('decoding', () => {
    it('decodes "aGVsbG8=" → "hello"', async () => {
      const r = await runner.run("printf 'aGVsbG8=\\n' | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('decodes "aGVsbG8K" → "hello\\n"', async () => {
      const r = await runner.run("printf 'aGVsbG8K\\n' | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('decodes "TWFu" → "Man"', async () => {
      const r = await runner.run("printf 'TWFu\\n' | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Man');
    });

    it('decodes "TQ==" → "M"', async () => {
      const r = await runner.run("printf 'TQ==\\n' | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('M');
    });

    it('--decode long flag works too', async () => {
      const r = await runner.run("printf 'YWJj\\n' | base64 --decode");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc');
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip: encode then decode
  // ---------------------------------------------------------------------------
  describe('round-trip encode then decode', () => {
    it('round-trip recovers original text', async () => {
      vfs.writeFile('/home/user/orig.txt', new TextEncoder().encode('hello world\n'));
      const r = await runner.run('cat /home/user/orig.txt | base64 | base64 -d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('round-trip with binary-like content', async () => {
      // "abc" → "YWJj" → "abc"
      const r = await runner.run("printf 'abc' | base64 | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc');
    });
  });

  // ---------------------------------------------------------------------------
  // Long input: 76-char line wrapping
  // ---------------------------------------------------------------------------
  describe('line wrapping at 76 characters', () => {
    it('output longer than 76 chars is split across multiple lines', async () => {
      // "hello world! " repeated gives > 76 base64 chars
      vfs.writeFile('/home/user/long.txt', new TextEncoder().encode('hello world! hello world! hello world! hello world! hello world!\n'));
      const r = await runner.run('cat /home/user/long.txt | base64');
      expect(r.exitCode).toBe(0);
      // Each line should be at most 76 chars (plus newline)
      for (const line of r.stdout.split('\n').filter((l: string) => l.length > 0)) {
        expect(line.length).toBeLessThanOrEqual(76);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // File piped via cat (base64 reads stdin only)
  // ---------------------------------------------------------------------------
  describe('file piped via cat', () => {
    it('encodes a file via cat pipe', async () => {
      vfs.writeFile('/home/user/msg.txt', new TextEncoder().encode('hello'));
      const r = await runner.run('cat /home/user/msg.txt | base64');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('aGVsbG8=\n');
    });
  });
});
