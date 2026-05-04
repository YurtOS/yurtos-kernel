/**
 * Tests for VFS state persistence: serializer, backends, manager, and Sandbox integration.
 */
import { describe, it, afterEach, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VFS } from '../vfs/vfs.js';
import { exportState, importState } from '../persistence/serializer.js';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { MemoryBackend } from '../persistence/backend.js';
import { FsBackend } from '../persistence/fs-backend.js';
import { PersistenceManager } from '../persistence/manager.js';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');


/** Helper: encode a string as UTF-8 bytes. */
const enc = (s: string) => new TextEncoder().encode(s);
/** Helper: decode UTF-8 bytes as a string. */
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Persistence serializer', () => {
  describe('exportState / importState round-trip', () => {
    it('round-trips VFS files and directories', () => {
      const src = new VFS();
      src.withWriteAccess(() => {
        src.mkdirp('/home/user/project');
        src.writeFile('/home/user/project/main.ts', enc('console.log("hello")'));
        src.writeFile('/tmp/data.bin', new Uint8Array([0, 1, 2, 255]));
      });

      const blob = exportState(src);

      const dst = new VFS();
      importState(dst, blob);

      // Verify files were restored
      expect(dec(dst.readFile('/home/user/project/main.ts'))).toBe('console.log("hello")');
      const binData = dst.readFile('/tmp/data.bin');
      expect(Array.from(binData)).toEqual([0, 1, 2, 255]);

      // Verify directory exists
      const stat = dst.stat('/home/user/project');
      expect(stat.type).toBe('dir');
    });

    it('round-trips env vars', () => {
      const src = new VFS();
      const env = new Map([['PATH', '/bin:/usr/bin'], ['HOME', '/home/user'], ['LANG', 'en_US.UTF-8']]);

      const blob = exportState(src, env);

      const dst = new VFS();
      const result = importState(dst, blob);

      expect(result.env).toBeDefined();
      expect(result.env!.get('PATH')).toBe('/bin:/usr/bin');
      expect(result.env!.get('HOME')).toBe('/home/user');
      expect(result.env!.get('LANG')).toBe('en_US.UTF-8');
    });

    it('returns empty object when no env was stored', () => {
      const src = new VFS();
      const blob = exportState(src);
      const dst = new VFS();
      const result = importState(dst, blob);
      expect(result.env).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('rejects blob that is too short', () => {
      expect(() => importState(new VFS(), new Uint8Array(4))).toThrow(/too short/);
    });

    it('rejects blob with bad magic bytes', () => {
      const bad = new Uint8Array(16);
      bad[0] = 0x00; // wrong magic
      expect(() => importState(new VFS(), bad)).toThrow(/bad magic/);
    });

    it('rejects blob with unsupported version', () => {
      // Valid magic, but version = 99
      const buf = new Uint8Array(16);
      buf.set([0x57, 0x53, 0x4e, 0x44], 0); // "WSND"
      const view = new DataView(buf.buffer);
      view.setUint32(4, 99, true);
      // Add minimal valid JSON
      const json = enc('{"version":99,"files":[]}');
      const full = new Uint8Array(8 + json.byteLength);
      full.set(buf.subarray(0, 8), 0);
      full.set(json, 8);
      expect(() => importState(new VFS(), full)).toThrow(/Unsupported state version/);
    });
  });

  describe('exclusions', () => {
    it('does not include /proc or /dev contents', () => {
      const vfs = new VFS();
      // VFS constructor registers /dev and /proc providers.
      // Write a normal file so the blob isn't empty.
      vfs.withWriteAccess(() => {
        vfs.writeFile('/tmp/keep.txt', enc('keep'));
      });

      const blob = exportState(vfs);
      const json = dec(blob.subarray(12));
      const state = JSON.parse(json);

      // No entry should have a path starting with /dev or /proc
      for (const entry of state.files) {
        expect(entry.path).not.toMatch(/^\/(dev|proc)(\/|$)/);
      }

      // But our file should be present
      expect(state.files.some((f: any) => f.path === '/tmp/keep.txt')).toBe(true);
    });
  });

  describe('safe import path filtering', () => {
    /** Helper: build a v2 blob from a SerializedState object. */
    function buildBlob(state: { version: number; files: Array<{ path: string; data: string; type: string; permissions?: number }> }): Uint8Array {
      const json = JSON.stringify(state);
      const jsonBytes = new TextEncoder().encode(json);
      // Compute CRC32
      const TABLE = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        TABLE[i] = c;
      }
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < jsonBytes.byteLength; i++) {
        crc = TABLE[(crc ^ jsonBytes[i]) & 0xFF] ^ (crc >>> 8);
      }
      crc = (crc ^ 0xFFFFFFFF) >>> 0;

      const blob = new Uint8Array(12 + jsonBytes.byteLength);
      blob.set([0x57, 0x53, 0x4E, 0x44], 0); // magic
      const view = new DataView(blob.buffer);
      view.setUint32(4, 2, true); // version 2
      view.setUint32(8, crc, true); // CRC32
      blob.set(jsonBytes, 12);
      return blob;
    }

    it('importState skips entries targeting system paths', () => {
      const blob = buildBlob({
        version: 2,
        files: [
          { path: '/bin/evil', data: btoa('malicious'), type: 'file' },
          { path: '/etc/shadow', data: btoa('secrets'), type: 'file' },
          { path: '/usr/bin/hack', data: btoa('hack'), type: 'file' },
          { path: '/home/user', data: '', type: 'dir' },
          { path: '/home/user/safe.txt', data: btoa('safe'), type: 'file' },
        ],
      });

      const vfs = new VFS();
      importState(vfs, blob);

      // Safe entry was imported
      expect(dec(vfs.readFile('/home/user/safe.txt'))).toBe('safe');
      // System paths were skipped
      expect(() => vfs.stat('/bin/evil')).toThrow();
      expect(() => vfs.stat('/etc/shadow')).toThrow();
      expect(() => vfs.stat('/usr/bin/hack')).toThrow();
    });

    it('importState normalizes paths to prevent .. escape', () => {
      const blob = buildBlob({
        version: 2,
        files: [
          { path: '/home/user/../../bin/evil', data: btoa('escaped'), type: 'file' },
          { path: '/tmp/./../../etc/passwd', data: btoa('passwd'), type: 'file' },
          { path: '/home/user/legit.txt', data: btoa('legit'), type: 'file' },
        ],
      });

      const vfs = new VFS();
      importState(vfs, blob);

      // Legitimate entry imported
      expect(dec(vfs.readFile('/home/user/legit.txt'))).toBe('legit');
      // Escaped paths were rejected (normalized to /bin/evil and /etc/passwd)
      expect(() => vfs.stat('/bin/evil')).toThrow();
      expect(() => vfs.stat('/etc/passwd')).toThrow();
    });

    it('importState allows entries under all safe prefixes', () => {
      const blob = buildBlob({
        version: 2,
        files: [
          { path: '/home', data: '', type: 'dir' },
          { path: '/home/user/file.txt', data: btoa('home'), type: 'file' },
          { path: '/tmp', data: '', type: 'dir' },
          { path: '/tmp/data.bin', data: btoa('tmp'), type: 'file' },
          { path: '/usr/lib/python', data: '', type: 'dir' },
          { path: '/usr/lib/python/mod.py', data: btoa('py'), type: 'file' },
          { path: '/usr/share/pkg', data: '', type: 'dir' },
          { path: '/usr/share/pkg/tool.wasm', data: btoa('wasm'), type: 'file' },
        ],
      });

      const vfs = new VFS();
      importState(vfs, blob);

      expect(dec(vfs.readFile('/home/user/file.txt'))).toBe('home');
      expect(dec(vfs.readFile('/tmp/data.bin'))).toBe('tmp');
      expect(dec(vfs.readFile('/usr/lib/python/mod.py'))).toBe('py');
      expect(dec(vfs.readFile('/usr/share/pkg/tool.wasm'))).toBe('wasm');
    });
  });

  describe('edge cases', () => {
    it('handles empty VFS gracefully', () => {
      const src = new VFS();
      const blob = exportState(src);

      const dst = new VFS();
      const result = importState(dst, blob);

      // Should not throw; env should be absent
      expect(result.env).toBeUndefined();
    });

    it('handles binary file content (all byte values)', () => {
      const src = new VFS();
      const allBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) allBytes[i] = i;

      src.withWriteAccess(() => {
        src.writeFile('/tmp/binary.bin', allBytes);
      });

      const blob = exportState(src);
      const dst = new VFS();
      importState(dst, blob);

      const restored = dst.readFile('/tmp/binary.bin');
      expect(Array.from(restored)).toEqual(Array.from(allBytes));
    });

    it('blob has correct magic bytes and version', () => {
      const vfs = new VFS();
      const blob = exportState(vfs);

      expect(blob[0]).toBe(0x57); // W
      expect(blob[1]).toBe(0x53); // S
      expect(blob[2]).toBe(0x4e); // N
      expect(blob[3]).toBe(0x44); // D

      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      expect(view.getUint32(4, true)).toBe(2);
    });

    it('round-trips permissions', () => {
      const src = new VFS();
      src.withWriteAccess(() => {
        src.writeFile('/tmp/readonly.txt', enc('locked'));
        src.chmod('/tmp/readonly.txt', 0o444);
        src.mkdirp('/tmp/restricted');
        src.chmod('/tmp/restricted', 0o555);
      });

      const blob = exportState(src);
      const dst = new VFS();
      importState(dst, blob);

      expect(dst.stat('/tmp/readonly.txt').permissions).toBe(0o444);
      expect(dst.stat('/tmp/restricted').permissions).toBe(0o555);
    });
  });
});

describe('Sandbox exportState / importState', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('round-trips files and env via Sandbox', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    sandbox.writeFile('/tmp/hello.txt', enc('world'));
    sandbox.setEnv('MY_KEY', 'my_value');

    const blob = sandbox.exportState();

    // Create a second sandbox and import
    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    try {
      sandbox2.importState(blob);

      expect(dec(sandbox2.readFile('/tmp/hello.txt'))).toBe('world');
      expect(sandbox2.getEnv('MY_KEY')).toBe('my_value');
    } finally {
      sandbox2.destroy();
    }
  });

  it('does not serialize deterministic bootstrap binaries', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const blob = sandbox.exportState();
    const state = JSON.parse(dec(blob.subarray(12)));
    expect(state.files.some((f: any) => f.path === '/bin/bash')).toBe(false);
    expect(state.files.some((f: any) => f.path === '/usr/share/misc/magic.mgc')).toBe(false);

    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    try {
      sandbox2.importState(blob);
      expect(sandbox2.stat('/bin/bash').type).toBe('file');
      expect(sandbox2.readFile('/bin/bash').length).toBeGreaterThan(8);
      expect(sandbox2.stat('/usr/share/misc/magic.mgc').type).toBe('file');
    } finally {
      sandbox2.destroy();
    }
  });

  it('importState overwrites existing files', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    sandbox.writeFile('/tmp/overwrite.txt', enc('original'));
    const blob = sandbox.exportState();

    // Create second sandbox with different content
    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    try {
      sandbox2.writeFile('/tmp/overwrite.txt', enc('should-be-overwritten'));
      sandbox2.importState(blob);

      expect(dec(sandbox2.readFile('/tmp/overwrite.txt'))).toBe('original');
    } finally {
      sandbox2.destroy();
    }
  });

  it('throws on destroyed sandbox', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.destroy();
    expect(() => sandbox.exportState()).toThrow(/destroyed/);
    expect(() => sandbox.importState(new Uint8Array(0))).toThrow(/destroyed/);
  });
});

describe('VFS onChange hook', () => {
  it('fires callback on writeFile', () => {
    const vfs = new VFS();
    let called = 0;
    vfs.setOnChange(() => called++);
    vfs.writeFile('/tmp/test.txt', enc('hello'));
    expect(called).toBe(1);
  });

  it('fires callback on mkdir, unlink, rmdir, rename, symlink, chmod', () => {
    const vfs = new VFS();
    let called = 0;
    vfs.setOnChange(() => called++);

    vfs.mkdir('/tmp/subdir');          // +1
    vfs.writeFile('/tmp/a.txt', enc('a')); // +1
    vfs.rename('/tmp/a.txt', '/tmp/b.txt'); // +1
    vfs.chmod('/tmp/b.txt', 0o644);   // +1
    vfs.symlink('/tmp/b.txt', '/tmp/link'); // +1
    vfs.unlink('/tmp/link');           // +1
    vfs.unlink('/tmp/b.txt');          // +1
    vfs.rmdir('/tmp/subdir');          // +1

    expect(called).toBe(8);
  });

  it('fires callback on mkdirp', () => {
    const vfs = new VFS();
    let called = 0;
    vfs.setOnChange(() => called++);
    vfs.mkdirp('/tmp/a/b/c');
    expect(called).toBe(1);
  });

  it('fires callback on restore', () => {
    const vfs = new VFS();
    const snapId = vfs.snapshot();
    let called = 0;
    vfs.setOnChange(() => called++);
    vfs.restore(snapId);
    expect(called).toBe(1);
  });

  it('does NOT fire during constructor init', () => {
    let called = 0;
    // Constructor creates default dirs — onChange should not fire for those
    const vfs = new VFS();
    vfs.setOnChange(() => called++);
    // Reading should not trigger
    vfs.readFile('/dev/null');
    vfs.readdir('/tmp');
    vfs.stat('/tmp');
    expect(called).toBe(0);
  });

  it('does NOT fire during withWriteAccess', () => {
    const vfs = new VFS();
    let called = 0;
    vfs.setOnChange(() => called++);
    vfs.withWriteAccess(() => {
      vfs.writeFile('/tmp/init.txt', enc('init'));
    });
    expect(called).toBe(0);
  });

  it('can be cleared by passing null', () => {
    const vfs = new VFS();
    let called = 0;
    vfs.setOnChange(() => called++);
    vfs.writeFile('/tmp/a.txt', enc('a'));
    expect(called).toBe(1);
    vfs.setOnChange(null);
    vfs.writeFile('/tmp/b.txt', enc('b'));
    expect(called).toBe(1); // unchanged
  });
});

describe('FsBackend', () => {
  let tmpDir: string;
  let backend: FsBackend;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yurt-test-'));
    backend = new FsBackend(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('save/load round-trip', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await backend.save('test-ns', data);
    const loaded = await backend.load('test-ns');
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('load returns null for missing namespace', async () => {
    const loaded = await backend.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('delete removes persisted state', async () => {
    await backend.save('del-test', new Uint8Array([99]));
    expect(await backend.load('del-test')).not.toBeNull();
    await backend.delete('del-test');
    expect(await backend.load('del-test')).toBeNull();
  });

  it('delete is idempotent for missing namespace', async () => {
    // Should not throw
    await backend.delete('never-existed');
  });

  it('sanitizes namespace to safe characters', async () => {
    const data = new Uint8Array([42]);
    await backend.save('ns/with:bad chars!', data);
    const loaded = await backend.load('ns/with:bad chars!');
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([42]);
  });

  it('isolates different namespaces', async () => {
    await backend.save('ns-a', new Uint8Array([1]));
    await backend.save('ns-b', new Uint8Array([2]));
    expect(Array.from((await backend.load('ns-a'))!)).toEqual([1]);
    expect(Array.from((await backend.load('ns-b'))!)).toEqual([2]);
  });
});

describe('PersistenceManager', () => {
  it('save/load round-trip with MemoryBackend', async () => {
    const backend = new MemoryBackend();
    const vfs = new VFS();
    const env = new Map([['FOO', 'bar']]);
    let currentEnv = env;

    const pm = new PersistenceManager(backend, vfs, { namespace: 'test' },
      () => currentEnv,
      (e) => { currentEnv = e; },
    );

    vfs.writeFile('/tmp/hello.txt', enc('world'));
    await pm.save();

    // Create a fresh VFS and load
    const vfs2 = new VFS();
    let env2 = new Map<string, string>();
    const pm2 = new PersistenceManager(backend, vfs2, { namespace: 'test' },
      () => env2,
      (e) => { env2 = e; },
    );

    const restored = await pm2.load();
    expect(restored).toBe(true);
    expect(dec(vfs2.readFile('/tmp/hello.txt'))).toBe('world');
    expect(env2.get('FOO')).toBe('bar');
  });

  it('load returns false when no persisted state exists', async () => {
    const backend = new MemoryBackend();
    const vfs = new VFS();
    const pm = new PersistenceManager(backend, vfs, { namespace: 'empty' },
      () => new Map(),
      () => {},
    );
    expect(await pm.load()).toBe(false);
  });

  it('clear deletes persisted state', async () => {
    const backend = new MemoryBackend();
    const vfs = new VFS();
    const pm = new PersistenceManager(backend, vfs, { namespace: 'clear-test' },
      () => new Map(),
      () => {},
    );
    await pm.save();
    expect(await backend.load('clear-test')).not.toBeNull();
    await pm.clear();
    expect(await backend.load('clear-test')).toBeNull();
  });

  it('autosave fires after debounce', async () => {
    const backend = new MemoryBackend();
    const vfs = new VFS();
    const pm = new PersistenceManager(backend, vfs, { namespace: 'auto', autosaveMs: 50 },
      () => new Map(),
      () => {},
    );
    pm.startAutosave(vfs);

    vfs.writeFile('/tmp/auto.txt', enc('triggered'));

    // Should not be saved yet (debounce)
    expect(await backend.load('auto')).toBeNull();

    // Wait for debounce to fire
    await new Promise(r => setTimeout(r, 120));

    const saved = await backend.load('auto');
    expect(saved).not.toBeNull();

    await pm.dispose();
  });

  it('dispose flushes pending save', async () => {
    const backend = new MemoryBackend();
    const vfs = new VFS();
    const pm = new PersistenceManager(backend, vfs, { namespace: 'dispose-flush', autosaveMs: 5000 },
      () => new Map(),
      () => {},
    );
    pm.startAutosave(vfs);

    vfs.writeFile('/tmp/flush.txt', enc('flush-me'));

    // Dispose immediately — should flush
    await pm.dispose();

    const saved = await backend.load('dispose-flush');
    expect(saved).not.toBeNull();
  });

  it('namespace isolation', async () => {
    const backend = new MemoryBackend();

    const vfs1 = new VFS();
    vfs1.writeFile('/tmp/f.txt', enc('ns1'));
    const pm1 = new PersistenceManager(backend, vfs1, { namespace: 'ns1' },
      () => new Map(),
      () => {},
    );
    await pm1.save();

    const vfs2 = new VFS();
    vfs2.writeFile('/tmp/f.txt', enc('ns2'));
    const pm2 = new PersistenceManager(backend, vfs2, { namespace: 'ns2' },
      () => new Map(),
      () => {},
    );
    await pm2.save();

    // Load ns1 into fresh VFS
    const vfsR = new VFS();
    const pmR = new PersistenceManager(backend, vfsR, { namespace: 'ns1' },
      () => new Map(),
      () => {},
    );
    await pmR.load();
    expect(dec(vfsR.readFile('/tmp/f.txt'))).toBe('ns1');
  });

  it('gracefully handles backend errors on load', async () => {
    const failBackend: MemoryBackend & { load: any } = new MemoryBackend();
    failBackend.load = async () => { throw new Error('disk on fire'); };
    const vfs = new VFS();
    const pm = new PersistenceManager(failBackend, vfs, { namespace: 'fail' },
      () => new Map(),
      () => {},
    );
    // Should not throw, should return false
    expect(await pm.load()).toBe(false);
  });
});

describe('Sandbox persistent mode integration', () => {
  it('persistent mode: write, autosave, restore in new sandbox', async () => {
    const backend = new MemoryBackend();

    const sb1 = await Sandbox.create({
      wasmDir: WASM_DIR, adapter: new NodeAdapter(),
      persistence: { mode: 'persistent', namespace: 'integ', autosaveMs: 50, backend },
    });

    sb1.writeFile('/tmp/persist.txt', enc('persisted'));
    sb1.setEnv('PERSIST_KEY', 'persist_val');

    // Wait for autosave debounce
    await new Promise(r => setTimeout(r, 120));
    sb1.destroy();

    // Create a new sandbox with same backend/namespace — should auto-load
    const sb2 = await Sandbox.create({
      wasmDir: WASM_DIR, adapter: new NodeAdapter(),
      persistence: { mode: 'persistent', namespace: 'integ', backend },
    });
    try {
      expect(dec(sb2.readFile('/tmp/persist.txt'))).toBe('persisted');
      expect(sb2.getEnv('PERSIST_KEY')).toBe('persist_val');
    } finally {
      sb2.destroy();
    }
  });

  it('session mode: manual save/load', async () => {
    const backend = new MemoryBackend();

    const sb1 = await Sandbox.create({
      wasmDir: WASM_DIR, adapter: new NodeAdapter(),
      persistence: { mode: 'session', namespace: 'sess', backend },
    });

    sb1.writeFile('/tmp/session.txt', enc('session-data'));
    await sb1.saveState();
    sb1.destroy();

    const sb2 = await Sandbox.create({
      wasmDir: WASM_DIR, adapter: new NodeAdapter(),
      persistence: { mode: 'session', namespace: 'sess', backend },
    });
    try {
      const restored = await sb2.loadState();
      expect(restored).toBe(true);
      expect(dec(sb2.readFile('/tmp/session.txt'))).toBe('session-data');
    } finally {
      sb2.destroy();
    }
  });

  it('ephemeral mode: save/load throws', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, adapter: new NodeAdapter(),
    });
    try {
      await expect(sb.saveState()).rejects.toThrow(/not configured/);
      await expect(sb.loadState()).rejects.toThrow(/not configured/);
      await expect(sb.clearPersistedState()).rejects.toThrow(/not configured/);
    } finally {
      sb.destroy();
    }
  });

  it('clearPersistedState removes saved data', async () => {
    const backend = new MemoryBackend();

    const sb = await Sandbox.create({
      wasmDir: WASM_DIR, adapter: new NodeAdapter(),
      persistence: { mode: 'session', namespace: 'clear', backend },
    });
    sb.writeFile('/tmp/clear.txt', enc('gone'));
    await sb.saveState();
    expect(await backend.load('clear')).not.toBeNull();
    await sb.clearPersistedState();
    expect(await backend.load('clear')).toBeNull();
    sb.destroy();
  });
});
