/**
 * xxd conformance tests — hexdump output.
 * Based on xxd implementation details.
 *
 * Output format per line:
 *   {offset:08x}: {hex-bytes-grouped-by-2}  {ascii}
 *
 * - Offset: 8-hex-digit address, colon, space → "00000000: "
 * - Hex section: 16 bytes per line, pairs separated by a space, total 40 chars
 *   (even-indexed byte: 2 hex chars; odd-indexed byte: 2 hex chars + space)
 * - ASCII section: space prefix + printable chars (0x20-0x7e) as-is, others as "."
 * - Partial line: hex section padded to full 40 chars with spaces
 *
 * Known vectors:
 *   - "ABCDEFGHIJKLMNOP" (16 bytes) → full line, no padding
 *   - "hello" (5 bytes) → partial line with 29 spaces before ASCII
 *   - Non-printable bytes → "." in ASCII column
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

describe('xxd conformance', () => {
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
  // Full 16-byte line — no padding
  // ---------------------------------------------------------------------------
  describe('full 16-byte line', () => {
    it('"ABCDEFGHIJKLMNOP" produces exact hex and ASCII', async () => {
      const r = await runner.run("printf 'ABCDEFGHIJKLMNOP' | xxd");
      expect(r.exitCode).toBe(0);
      // Hex: 4142 4344 4546 4748 494a 4b4c 4d4e 4f50  (trailing space from i=15)
      // Sep: space; ASCII: ABCDEFGHIJKLMNOP
      expect(r.stdout).toBe(
        '00000000: 4142 4344 4546 4748 494a 4b4c 4d4e 4f50  ABCDEFGHIJKLMNOP\n',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Partial lines — padding fills hex section to 40 chars
  // ---------------------------------------------------------------------------
  describe('partial lines', () => {
    it('"hello" (5 bytes) → 29 spaces between hex and ASCII', async () => {
      const r = await runner.run("printf 'hello' | xxd");
      expect(r.exitCode).toBe(0);
      // Hex for 5 bytes: 6865 6c6c 6f (12 chars used) + 28 pad spaces = 40 total
      // Sep + ASCII: " hello" → 29 spaces before ASCII
      expect(r.stdout).toBe(
        '00000000: 6865 6c6c 6f                             hello\n',
      );
    });

    it('"AB" (2 bytes) → heavy padding', async () => {
      const r = await runner.run("printf 'AB' | xxd");
      expect(r.exitCode).toBe(0);
      // Hex: 4142  (5 chars: 41 + 42 + space from i=1) + 35 pad spaces = 40
      // After 4142: 1 (sep from i=1) + 35 (pad i=2..15) + 1 (final sep) = 37 spaces before AB
      expect(r.stdout).toBe(
        '00000000: 4142                                     AB\n',
      );
    });

    it('single byte: 39 spaces before ASCII', async () => {
      const r = await runner.run("printf 'A' | xxd");
      expect(r.exitCode).toBe(0);
      // Hex: 41 (2 chars, i=0 even no sep) + 38 pad spaces (i=1..15) + 1 final sep = 39 spaces
      expect(r.stdout).toBe(
        '00000000: 41                                       A\n',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-line output — offset increments by 16
  // ---------------------------------------------------------------------------
  describe('multi-line offset', () => {
    it('17 bytes produce two lines with correct offsets', async () => {
      const r = await runner.run("printf 'ABCDEFGHIJKLMNOPQ' | xxd");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.split('\n').filter((l: string) => l.length > 0);
      expect(lines.length).toBe(2);
      // First line: offset 0x00000000
      expect(lines[0]).toBe(
        '00000000: 4142 4344 4546 4748 494a 4b4c 4d4e 4f50  ABCDEFGHIJKLMNOP',
      );
      // Second line: offset 0x00000010 (16 decimal)
      expect(lines[1]).toContain('00000010:');
      expect(lines[1]).toContain('51'); // Q = 0x51
      expect(lines[1]).toContain('Q');
    });

    it('second line offset is 0x10 for 17-byte input', async () => {
      const r = await runner.run("printf 'ABCDEFGHIJKLMNOPQ' | xxd");
      expect(r.exitCode).toBe(0);
      const line2 = r.stdout.split('\n')[1];
      expect(line2).toBe(
        '00000010: 51                                       Q',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Non-printable bytes → dots in ASCII column
  // ---------------------------------------------------------------------------
  describe('non-printable bytes show as dots', () => {
    it('null byte becomes dot in ASCII', async () => {
      vfs.writeFile('/home/user/bin.bin', new Uint8Array([0x00, 0x41]));
      const r = await runner.run('xxd /home/user/bin.bin');
      expect(r.exitCode).toBe(0);
      // ASCII column: null → dot, A stays A
      expect(r.stdout).toContain('.A');
    });

    it('0x7f DEL becomes dot', async () => {
      vfs.writeFile('/home/user/del.bin', new Uint8Array([0x7f]));
      const r = await runner.run('xxd /home/user/del.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('7f');
      expect(r.stdout).toContain('.');
    });

    it('printable range 0x20-0x7e shown as-is', async () => {
      // Space (0x20) and tilde (0x7e) are both printable
      vfs.writeFile('/home/user/edges.bin', new Uint8Array([0x20, 0x7e]));
      const r = await runner.run('xxd /home/user/edges.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(' ~');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/msg.txt', new TextEncoder().encode('AB'));
      const r = await runner.run('xxd /home/user/msg.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(
        '00000000: 4142                                     AB\n',
      );
    });
  });
});
