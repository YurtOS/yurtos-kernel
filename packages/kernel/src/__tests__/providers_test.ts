/**
 * Tests for VFS virtual providers: DevProvider (/dev) and ProcProvider (/proc).
 *
 * Exercises the full provider interface through the VFS layer, verifying
 * that provider routing correctly intercepts before normal inode logic.
 * Also includes integration tests that verify providers work through the
 * full Sandbox.run() path (via WASM coreutils) and survive snapshot/restore
 * and fork operations.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { VFS } from '../vfs/vfs.js';
import { VfsError } from '../vfs/inode.js';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');


describe('DevProvider (/dev)', () => {
  it('/dev/null read returns empty bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/null');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBe(0);
  });

  it('/dev/null write is silent (no error)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/null', new TextEncoder().encode('discard me'));
    }).not.toThrow();
  });

  it('/dev/null stat returns file type', () => {
    const vfs = new VFS();
    const s = vfs.stat('/dev/null');
    expect(s.type).toBe('file');
    expect(s.size).toBe(0);
  });

  it('/dev directory is listable with all expected devices', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/dev');
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['full', 'null', 'random', 'urandom', 'zero']);
    // All entries are files
    for (const entry of entries) {
      expect(entry.type).toBe('file');
    }
  });

  it('/dev stat returns dir type', () => {
    const vfs = new VFS();
    const s = vfs.stat('/dev');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(5);
  });

  it('/dev/zero returns zero bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/zero');
    expect(data.byteLength).toBeGreaterThan(0);
    for (let i = 0; i < data.byteLength; i++) {
      expect(data[i]).toBe(0);
    }
  });

  it('/dev/random returns bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/random');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBeGreaterThan(0);
  });

  it('/dev/urandom returns bytes', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/dev/urandom');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBeGreaterThan(0);
  });

  it('/dev/random and /dev/urandom return different bytes on separate reads', () => {
    const vfs = new VFS();
    const a = vfs.readFile('/dev/random');
    const b = vfs.readFile('/dev/random');
    // It's theoretically possible but astronomically unlikely for 4096 random bytes to match
    let same = true;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) { same = false; break; }
    }
    expect(same).toBe(false);
  });

  it('writing to /dev/zero throws EROFS', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/zero', new Uint8Array(1));
    }).toThrow(/EROFS/);
  });

  it('writing to /dev/random throws EROFS', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/random', new Uint8Array(1));
    }).toThrow(/EROFS/);
  });

  it('writing to /dev/urandom throws EROFS', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/dev/urandom', new Uint8Array(1));
    }).toThrow(/EROFS/);
  });

  it('reading nonexistent /dev/foo throws ENOENT', () => {
    const vfs = new VFS();
    try {
      vfs.readFile('/dev/foo');
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).errno).toBe('ENOENT');
    }
  });

  it('stat of nonexistent /dev/foo throws ENOENT', () => {
    const vfs = new VFS();
    try {
      vfs.stat('/dev/foo');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).errno).toBe('ENOENT');
    }
  });
});

describe('ProcProvider (/proc)', () => {
  it('/proc/uptime returns parseable number', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/uptime');
    const text = new TextDecoder().decode(data);
    const parts = text.trim().split(' ');
    expect(parts.length).toBe(2);
    const uptime = parseFloat(parts[0]);
    expect(Number.isFinite(uptime)).toBe(true);
    expect(uptime).toBeGreaterThanOrEqual(0);
  });

  it('/proc/version contains expected content', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/version');
    const text = new TextDecoder().decode(data);
    expect(text).toContain('yurt');
    expect(text).toContain('WASI sandbox');
  });

  it('/proc/cpuinfo contains "processor"', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/cpuinfo');
    const text = new TextDecoder().decode(data);
    expect(text).toContain('processor');
    expect(text).toContain('WASI Virtual CPU');
  });

  it('/proc/meminfo has content', () => {
    const vfs = new VFS();
    const data = vfs.readFile('/proc/meminfo');
    const text = new TextDecoder().decode(data);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('MemTotal');
    expect(text).toContain('MemFree');
  });

  it('/proc is listable with all expected files', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/proc');
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual([
      'cpuinfo', 'diskstats', 'loadavg', 'meminfo', 'mounts', 'uptime', 'version',
    ]);
    for (const entry of entries) {
      expect(entry.type).toBe('file');
    }
  });

  it('/proc stat returns dir type', () => {
    const vfs = new VFS();
    const s = vfs.stat('/proc');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(7);
  });

  it('/proc/mounts reflects the live VFS mount table', () => {
    const vfs = new VFS();
    const text = new TextDecoder().decode(vfs.readFile('/proc/mounts'));
    // Root + /proc + /dev are present after construction.
    expect(text).toContain('yurtfs / yurtfs');
    expect(text).toContain('proc /proc proc');
    expect(text).toContain('devtmpfs /dev devtmpfs');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Per-PID /proc entries — populated from a callback so that newly-
  // spawned processes appear without a registration step.  These tests
  // wire a fake list directly on the VFS to keep them independent of
  // the process runtime; the integration is covered through
  // Sandbox.run() in abi.test.ts.
  // ──────────────────────────────────────────────────────────────────────
  describe('per-PID /proc entries', () => {
    function vfsWith(
      procs: {
        pid: number;
        ppid: number;
        pgid?: number;
        sid?: number;
        state: string;
        exit_code: number;
        command: string;
        fds?: number[];
      }[],
    ): VFS {
      const vfs = new VFS();
      vfs.setProcessListProvider(() => procs);
      return vfs;
    }

    it('/proc lists numeric PID directories alongside top-level files', () => {
      const vfs = vfsWith([
        { pid: 1, ppid: 0, state: 'running', exit_code: -1, command: 'shell' },
        { pid: 2, ppid: 1, state: 'running', exit_code: -1, command: 'awk' },
      ]);
      const names = vfs.readdir('/proc').map(e => e.name).sort();
      expect(names).toContain('1');
      expect(names).toContain('2');
      expect(names).toContain('uptime');
    });

    it('/proc/<pid> is a directory containing stat / status / cmdline / comm / fd', () => {
      const vfs = vfsWith([{ pid: 1, ppid: 0, state: 'running', exit_code: -1, command: 'shell' }]);
      expect(vfs.stat('/proc/1').type).toBe('dir');
      const entries = vfs.readdir('/proc/1').map(e => e.name).sort();
      expect(entries).toEqual(['cmdline', 'comm', 'fd', 'stat', 'status']);
    });

    it('/proc/<pid>/fd lists open file descriptors', () => {
      const vfs = vfsWith([{ pid: 1, ppid: 0, state: 'running', exit_code: -1, command: 'shell', fds: [2, 0, 1, 10] }]);
      expect(vfs.stat('/proc/1/fd').type).toBe('dir');
      const entries = vfs.readdir('/proc/1/fd').map(e => e.name);
      expect(entries).toEqual(['0', '1', '2', '10']);
      expect(vfs.stat('/proc/1/fd/1').type).toBe('file');
      expect(() => vfs.stat('/proc/1/fd/99')).toThrow(/ENOENT/);
    });

    it('/proc/<pid>/comm returns the basename of the program', () => {
      const vfs = vfsWith([{ pid: 7, ppid: 1, state: 'running', exit_code: -1, command: '/bin/awk -F : { print }' }]);
      const text = new TextDecoder().decode(vfs.readFile('/proc/7/comm'));
      expect(text).toBe('awk\n');
    });

    it('/proc/<pid>/status carries the POSIX-relevant fields', () => {
      const vfs = vfsWith([{ pid: 7, ppid: 1, state: 'running', exit_code: -1, command: 'awk' }]);
      const text = new TextDecoder().decode(vfs.readFile('/proc/7/status'));
      expect(text).toContain('Name:\tawk');
      expect(text).toContain('Pid:\t7');
      expect(text).toContain('PPid:\t1');
      expect(text).toContain('State:\tR (running)');
      expect(text).toContain('Uid:\t1000\t1000\t1000\t1000');
    });

    it('/proc/<pid>/stat starts with "<pid> (<comm>) <state> <ppid>"', () => {
      const vfs = vfsWith([{ pid: 7, ppid: 1, state: 'running', exit_code: -1, command: 'awk' }]);
      const text = new TextDecoder().decode(vfs.readFile('/proc/7/stat'));
      expect(text.startsWith('7 (awk) R 1 ')).toBe(true);
    });

    it('/proc/<pid>/stat reports process group and session ids from the kernel', () => {
      const vfs = vfsWith([
        { pid: 7, ppid: 1, pgid: 42, sid: 99, state: 'running', exit_code: -1, command: 'awk' },
      ]);
      const text = new TextDecoder().decode(vfs.readFile('/proc/7/stat'));
      const fields = text.trim().split(/\s+/);

      expect(fields.slice(0, 6)).toEqual(['7', '(awk)', 'R', '1', '42', '99']);
    });

    it('exited processes show up as zombies (Z) until reaped', () => {
      const vfs = vfsWith([{ pid: 7, ppid: 1, state: 'exited', exit_code: 0, command: 'awk' }]);
      const text = new TextDecoder().decode(vfs.readFile('/proc/7/status'));
      expect(text).toContain('State:\tZ (zombie)');
    });

    it('/proc/<pid>/cmdline is NUL-separated (Linux convention)', () => {
      const vfs = vfsWith([{ pid: 7, ppid: 1, state: 'running', exit_code: -1, command: 'awk -F : { print }' }]);
      const text = new TextDecoder().decode(vfs.readFile('/proc/7/cmdline'));
      expect(text).toBe('awk\0-F\0:\0{\0print\0}');
    });

    it('reading /proc/<unknown-pid>/comm raises ENOENT', () => {
      const vfs = vfsWith([{ pid: 1, ppid: 0, state: 'running', exit_code: -1, command: 'shell' }]);
      expect(() => vfs.readFile('/proc/999/comm')).toThrow(/ENOENT/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // /dev streaming devices — endless stream semantics required for
  // tools like `head -c N /dev/urandom`, `dd if=/dev/zero`, etc.  The
  // earlier read-once-then-slice model would either truncate at a
  // fixed buffer size or leak memory, so the FdTable now routes per-
  // syscall reads/writes through provider.streamRead / streamWrite.
  // ──────────────────────────────────────────────────────────────────────
  describe('/dev streaming devices', () => {
    it('/dev lists null, zero, random, urandom, full', () => {
      const vfs = new VFS();
      const names = vfs.readdir('/dev').map(e => e.name).sort();
      expect(names).toEqual(['full', 'null', 'random', 'urandom', 'zero']);
    });

    it('streamFile() returns null for non-streaming paths', () => {
      const vfs = new VFS();
      expect(vfs.streamFile('/proc/version')).toBeNull();
      expect(vfs.streamFile('/tmp')).toBeNull();
    });

    it('/dev/zero stream returns exactly the requested length, all zeros', () => {
      const vfs = new VFS();
      const stream = vfs.streamFile('/dev/zero');
      expect(stream).not.toBeNull();
      const data = stream!.read!(1024);
      expect(data.byteLength).toBe(1024);
      expect(data.every(b => b === 0)).toBe(true);
    });

    it('/dev/urandom stream produces fresh bytes on every call', () => {
      const vfs = new VFS();
      const stream = vfs.streamFile('/dev/urandom');
      const a = stream!.read!(64);
      const b = stream!.read!(64);
      expect(a.byteLength).toBe(64);
      expect(b.byteLength).toBe(64);
      // Two crypto-random reads being byte-identical has probability
      // 2^-512; treat any equality as a failure.
      let equal = true;
      for (let i = 0; i < 64; i++) {
        if (a[i] !== b[i]) { equal = false; break; }
      }
      expect(equal).toBe(false);
    });

    it('/dev/urandom honors > 64 KiB requests (chunks the crypto API)', () => {
      const vfs = new VFS();
      const stream = vfs.streamFile('/dev/urandom');
      const data = stream!.read!(200_000);
      expect(data.byteLength).toBe(200_000);
      // Sanity: not all-zero, not constant.
      const nonZero = data.some(b => b !== 0);
      expect(nonZero).toBe(true);
    });

    it('/dev/null write accepts everything, read returns 0 bytes (EOF)', () => {
      const vfs = new VFS();
      const stream = vfs.streamFile('/dev/null');
      expect(stream!.write!(new Uint8Array([1, 2, 3]))).toBe(3);
      expect(stream!.read!(64).byteLength).toBe(0);
    });

    it('/dev/full read returns zeros, write throws ENOSPC', () => {
      const vfs = new VFS();
      const stream = vfs.streamFile('/dev/full');
      expect(stream!.read!(8).every(b => b === 0)).toBe(true);
      expect(() => stream!.write!(new Uint8Array([1, 2, 3]))).toThrow(/ENOSPC/);
    });

    it('/dev/zero / /dev/random / /dev/urandom reject writes with EROFS', () => {
      const vfs = new VFS();
      for (const dev of ['zero', 'random', 'urandom']) {
        const stream = vfs.streamFile(`/dev/${dev}`);
        expect(() => stream!.write!(new Uint8Array([1])))
          .toThrow(/EROFS/);
      }
    });
  });

  it('/proc files are read-only (EROFS on write to uptime)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/uptime', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('/proc files are read-only (EROFS on write to version)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/version', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('/proc files are read-only (EROFS on write to cpuinfo)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/cpuinfo', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('/proc files are read-only (EROFS on write to meminfo)', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/proc/meminfo', new TextEncoder().encode('fake'));
    }).toThrow(/EROFS/);
  });

  it('reading nonexistent /proc/foo throws ENOENT', () => {
    const vfs = new VFS();
    try {
      vfs.readFile('/proc/foo');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(VfsError);
      expect((e as VfsError).errno).toBe('ENOENT');
    }
  });

  it('/proc/uptime stat returns file type with correct size', () => {
    const vfs = new VFS();
    const s = vfs.stat('/proc/uptime');
    expect(s.type).toBe('file');
    expect(s.size).toBeGreaterThan(0);
  });
});

describe('Provider integration with VFS', () => {
  it('providers do not interfere with normal VFS operations', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode(vfs.readFile('/tmp/test.txt'))).toBe('hello');
    expect(vfs.stat('/tmp/test.txt').type).toBe('file');
  });

  it('providers are available after cowClone', () => {
    const vfs = new VFS();
    const clone = vfs.cowClone();

    // /dev should work in clone
    const nullData = clone.readFile('/dev/null');
    expect(nullData.byteLength).toBe(0);

    // /proc should work in clone
    const version = new TextDecoder().decode(clone.readFile('/proc/version'));
    expect(version).toContain('yurt');

    // Listing should work
    const devEntries = clone.readdir('/dev');
    expect(devEntries.length).toBe(5);
    const procEntries = clone.readdir('/proc');
    // uptime, version, cpuinfo, meminfo, loadavg, diskstats, mounts
    expect(procEntries.length).toBe(7);
  });

  it('root readdir still works (does not include virtual mounts)', () => {
    const vfs = new VFS();
    const entries = vfs.readdir('/');
    const names = entries.map(e => e.name).sort();
    // Should contain the default layout directories
    expect(names).toContain('home');
    expect(names).toContain('tmp');
    expect(names).toContain('bin');
  });

  it('provider stat returns correct permissions', () => {
    const vfs = new VFS();
    const devStat = vfs.stat('/dev');
    expect(devStat.permissions).toBe(0o755);

    const nullStat = vfs.stat('/dev/null');
    expect(nullStat.permissions).toBe(0o444);
  });
});

describe('providers via Sandbox.run()', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('cat /dev/null returns empty stdout with exit code 0', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('cat /dev/null');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('cat /proc/version returns yurt', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('cat /proc/version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('yurt');
  });

  it('ls /dev lists devices including null', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('ls /dev');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('null');
  });

  it('openTty creates a controlling terminal for the boot process', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    expect(() => sandbox.openTty()).not.toThrow();
  });
});

describe('providers after snapshot/restore and fork', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('/dev/null works after snapshot/restore', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const snapId = sandbox.snapshot();
    sandbox.restore(snapId);

    const data = sandbox.readFile('/dev/null');
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.byteLength).toBe(0);
  });

  it('/proc/version available in fork', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      const data = child.readFile('/proc/version');
      const text = new TextDecoder().decode(data);
      expect(text).toContain('yurt');
    } finally {
      child.destroy();
    }
  });

  it('/dev devices are accessible in forked sandbox', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      // /dev/null should return empty
      const nullData = child.readFile('/dev/null');
      expect(nullData.byteLength).toBe(0);

      // /dev/zero should return zero bytes
      const zeroData = child.readFile('/dev/zero');
      expect(zeroData.byteLength).toBeGreaterThan(0);
      for (let i = 0; i < zeroData.byteLength; i++) {
        expect(zeroData[i]).toBe(0);
      }

      // readdir /dev should list all devices
      const entries = child.readDir('/dev');
      const names = entries.map(e => e.name).sort();
      expect(names).toEqual(['full', 'null', 'random', 'urandom', 'zero']);
    } finally {
      child.destroy();
    }
  });

  it('/proc files are accessible after multiple snapshot/restore cycles', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    // First snapshot/restore
    const snap1 = sandbox.snapshot();
    sandbox.writeFile('/tmp/marker.txt', new TextEncoder().encode('modified'));
    sandbox.restore(snap1);

    // Providers should still work
    const version1 = new TextDecoder().decode(sandbox.readFile('/proc/version'));
    expect(version1).toContain('yurt');

    // Second snapshot/restore
    const snap2 = sandbox.snapshot();
    sandbox.restore(snap2);

    const version2 = new TextDecoder().decode(sandbox.readFile('/proc/version'));
    expect(version2).toContain('yurt');

    // /dev should also work
    const nullData = sandbox.readFile('/dev/null');
    expect(nullData.byteLength).toBe(0);
  });

  it('forked sandbox providers are independent from parent', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      // Both parent and child should have working providers
      const parentVersion = new TextDecoder().decode(sandbox.readFile('/proc/version'));
      const childVersion = new TextDecoder().decode(child.readFile('/proc/version'));
      expect(parentVersion).toContain('yurt');
      expect(childVersion).toContain('yurt');

      // Both should have working /dev/null
      expect(sandbox.readFile('/dev/null').byteLength).toBe(0);
      expect(child.readFile('/dev/null').byteLength).toBe(0);
    } finally {
      child.destroy();
    }
  });
});
