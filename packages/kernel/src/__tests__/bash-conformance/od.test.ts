/**
 * od conformance tests — octal dump.
 * Based on POSIX specification and busybox/GNU coreutils test patterns.
 *
 * Default output format:
 *   {addr:07o} {word1:06o} {word2:06o} ...
 *   Words are 2-byte little-endian: word = (byte[i+1] << 8) | byte[i]
 *   Final line is just the total byte count in the address format.
 *
 * Covers:
 *   - Default: octal address + octal 2-byte words
 *   - -t x1: hex bytes one-per-byte (space-separated)
 *   - -t c: C-style char escapes for control chars, 3 spaces + char for printable
 *   - -t a: named chars (nul, ht, nl, sp, etc.), each formatted to 3 chars with prefix
 *   - -A x / -A d / -A n: hex, decimal, or no address
 *   - -N COUNT: limit bytes read
 *   - File input
 *
 * Known octal word values:
 *   - 'A' (0x41=65) alone: 000101
 *   - 'A','B' (0x41, 0x42): word = (0x42<<8)|0x41 = 0x4241 = 16961 = 041101 octal
 *   - 'h','e' (0x68, 0x65): word = 0x6568 = 26216 = 063150 octal
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

describe('od conformance', () => {
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
  // Default: octal 2-byte words, octal address
  // ---------------------------------------------------------------------------
  describe('default output (octal words, octal address)', () => {
    it('single byte "A" (0x41 = 000101 octal)', async () => {
      const r = await runner.run("printf 'A' | od");
      expect(r.exitCode).toBe(0);
      // Odd byte → print as u16 = 0x41 = 65 = 101 octal → 000101
      expect(r.stdout).toBe('0000000 000101\n0000001\n');
    });

    it('"AB": little-endian word = (0x42<<8)|0x41 = 0x4241 = 041101 octal', async () => {
      const r = await runner.run("printf 'AB' | od");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000 041101\n0000002\n');
    });

    it('empty input: just the final address', async () => {
      const r = await runner.run("printf '' | od");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -t x1: hex, one byte at a time
  // ---------------------------------------------------------------------------
  describe('-t x1 hex bytes', () => {
    it('"A" → address + " 41" + final address', async () => {
      const r = await runner.run("printf 'A' | od -t x1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000 41\n0000001\n');
    });

    it('"AB" → " 41 42"', async () => {
      const r = await runner.run("printf 'AB' | od -t x1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000 41 42\n0000002\n');
    });

    it('"hello" → hex for each byte', async () => {
      const r = await runner.run("printf 'hello' | od -t x1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000 68 65 6c 6c 6f\n0000005\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -t c: C-style char representation
  // ---------------------------------------------------------------------------
  describe('-t c char representation', () => {
    it('"A" → "   A" (3 spaces + char)', async () => {
      const r = await runner.run("printf 'A' | od -t c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000   A\n0000001\n');
    });

    it('"AB" → "   A   B"', async () => {
      const r = await runner.run("printf 'AB' | od -t c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000   A   B\n0000002\n');
    });

    it('newline byte → " \\n" escape (space + backslash + n)', async () => {
      const r = await runner.run("printf '\\n' | od -t c");
      expect(r.exitCode).toBe(0);
      // char_repr('\n') = "\n" (2 chars: backslash, literal n), right-justified in 3-char field
      expect(r.stdout).toBe('0000000 \\n\n0000001\n');
    });

    it('"hello" printable chars', async () => {
      const r = await runner.run("printf 'hello' | od -t c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000   h   e   l   l   o\n0000005\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -t a: named char representation
  // ---------------------------------------------------------------------------
  describe('-t a named chars', () => {
    it('newline → " nl" name (with space prefix, formatted to 3)', async () => {
      const r = await runner.run("printf '\\n' | od -t a");
      expect(r.exitCode).toBe(0);
      // named_char(0x0a) = " nl"; print!(" {:>3}", " nl") = "  nl"
      expect(r.stdout).toBe('0000000  nl\n0000001\n');
    });

    it('"A" → named char "  A" (space+space+A)', async () => {
      const r = await runner.run("printf 'A' | od -t a");
      expect(r.exitCode).toBe(0);
      // named_char('A') = "A" (single char), right-justified in 3-char field = "  A"
      expect(r.stdout).toBe('0000000   A\n0000001\n');
    });

    it('space byte (0x20) → " sp" name', async () => {
      const r = await runner.run("printf ' ' | od -t a");
      expect(r.exitCode).toBe(0);
      // named_char(0x20) = " sp"; print!(" {:>3}", " sp") = "  sp"
      expect(r.stdout).toBe('0000000  sp\n0000001\n');
    });

    it('null byte (0x00) → "nul" name', async () => {
      vfs.writeFile('/home/user/null.bin', new Uint8Array([0x00]));
      const r = await runner.run('od -t a /home/user/null.bin');
      expect(r.exitCode).toBe(0);
      // named_char(0x00) = "nul" (3 chars), right-justified in 3-char field = "nul"
      expect(r.stdout).toBe('0000000 nul\n0000001\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -A: address radix
  // ---------------------------------------------------------------------------
  describe('-A address radix', () => {
    it('-A n: no address printed', async () => {
      const r = await runner.run("printf 'AB' | od -A n");
      expect(r.exitCode).toBe(0);
      // No address, no final address line
      expect(r.stdout).toBe(' 041101\n');
    });

    it('-A x: hex address for offset > 9', async () => {
      // Write 17 bytes to get a second line at offset 16 = 0x10
      vfs.writeFile(
        '/home/user/long.bin',
        new Uint8Array(Array.from({ length: 17 }, (_, i) => 0x41 + i)),
      );
      const r = await runner.run('od -A x -t x1 /home/user/long.bin');
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.split('\n').filter((l: string) => l.length > 0);
      // Second data line address should be 0000010 (hex 10 = decimal 16)
      expect(lines[1]).toMatch(/^0000010 /);
      // Final address should be 0000011 (hex 11 = decimal 17)
      expect(lines[lines.length - 1]).toBe('0000011');
    });

    it('-A d: decimal address for offset 16 → 0000016', async () => {
      vfs.writeFile(
        '/home/user/long.bin',
        new Uint8Array(Array.from({ length: 17 }, (_, i) => 0x41 + i)),
      );
      const r = await runner.run('od -A d -t x1 /home/user/long.bin');
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.split('\n').filter((l: string) => l.length > 0);
      // Second data line address: 16 decimal = 0000016
      expect(lines[1]).toMatch(/^0000016 /);
    });
  });

  // ---------------------------------------------------------------------------
  // -N COUNT: limit bytes
  // ---------------------------------------------------------------------------
  describe('-N COUNT byte limit', () => {
    it('-N 2: reads only first 2 bytes of "hello"', async () => {
      const r = await runner.run("printf 'hello' | od -N 2");
      expect(r.exitCode).toBe(0);
      // First 2 bytes: 'h'=0x68, 'e'=0x65 → word = (0x65<<8)|0x68 = 0x6568 = 062550 octal
      expect(r.stdout).toBe('0000000 062550\n0000002\n');
    });

    it('-N 1: reads only first byte', async () => {
      const r = await runner.run("printf 'hello' | od -N 1 -t x1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000 68\n0000001\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/data.bin', new TextEncoder().encode('AB'));
      const r = await runner.run('od /home/user/data.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0000000 041101\n0000002\n');
    });
  });
});
