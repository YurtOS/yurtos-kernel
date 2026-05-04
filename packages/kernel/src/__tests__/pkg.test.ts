/**
 * Tests for PackageManager and pkg shell builtin integration.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { VFS } from '../vfs/vfs.js';
import { PackageManager, PkgError } from '../pkg/manager.js';
import type { PackagePolicy } from '../security.js';
import type { SecurityOptions } from '../security.js';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const enabledPolicy: PackagePolicy = { enabled: true };

function createManager(policy?: Partial<PackagePolicy>) {
  const vfs = new VFS();
  const merged: PackagePolicy = { enabled: true, ...policy };
  return { vfs, mgr: new PackageManager(vfs, merged) };
}

const SAMPLE_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe('PackageManager', () => {
  it('install stores wasm binary and metadata', () => {
    const { vfs, mgr } = createManager();
    mgr.install('hello', SAMPLE_WASM, 'https://example.com/hello.wasm');

    // Verify wasm binary is stored in VFS
    const stored = vfs.readFile('/usr/share/pkg/bin/hello.wasm');
    expect(stored).toEqual(SAMPLE_WASM);

    // Verify metadata is persisted
    const metaRaw = vfs.readFile('/usr/share/pkg/packages.json');
    const meta = JSON.parse(new TextDecoder().decode(metaRaw));
    expect(meta).toHaveLength(1);
    expect(meta[0].name).toBe('hello');
    expect(meta[0].url).toBe('https://example.com/hello.wasm');
    expect(meta[0].size).toBe(SAMPLE_WASM.byteLength);
    expect(typeof meta[0].installedAt).toBe('number');
  });

  it('list returns installed packages', () => {
    const { mgr } = createManager();
    mgr.install('pkg-a', SAMPLE_WASM, 'https://example.com/a.wasm');
    mgr.install('pkg-b', SAMPLE_WASM, 'https://example.com/b.wasm');

    const pkgs = mgr.list();
    expect(pkgs).toHaveLength(2);
    const names = pkgs.map(p => p.name).sort();
    expect(names).toEqual(['pkg-a', 'pkg-b']);
  });

  it('info returns package details', () => {
    const { mgr } = createManager();
    mgr.install('my-tool', SAMPLE_WASM, 'https://example.com/my-tool.wasm');

    const info = mgr.info('my-tool');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('my-tool');
    expect(info!.url).toBe('https://example.com/my-tool.wasm');
    expect(info!.size).toBe(SAMPLE_WASM.byteLength);
    expect(info!.installedAt).toBeGreaterThan(0);
  });

  it('info returns null for unknown package', () => {
    const { mgr } = createManager();
    expect(mgr.info('nonexistent')).toBeNull();
  });

  it('getWasmPath returns path for installed package', () => {
    const { mgr } = createManager();
    mgr.install('jq', SAMPLE_WASM, 'https://example.com/jq.wasm');

    expect(mgr.getWasmPath('jq')).toBe('/usr/share/pkg/bin/jq.wasm');
  });

  it('getWasmPath returns null for unknown package', () => {
    const { mgr } = createManager();
    expect(mgr.getWasmPath('nonexistent')).toBeNull();
  });

  it('remove deletes package files and metadata', () => {
    const { vfs, mgr } = createManager();
    mgr.install('to-remove', SAMPLE_WASM, 'https://example.com/to-remove.wasm');
    expect(mgr.info('to-remove')).not.toBeNull();

    mgr.remove('to-remove');

    expect(mgr.info('to-remove')).toBeNull();
    expect(mgr.list()).toHaveLength(0);
    expect(() => vfs.readFile('/usr/share/pkg/bin/to-remove.wasm')).toThrow();
  });

  it('remove throws E_PKG_NOT_FOUND for unknown package', () => {
    const { mgr } = createManager();
    try {
      mgr.remove('ghost');
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(PkgError);
      expect((e as PkgError).code).toBe('E_PKG_NOT_FOUND');
    }
  });

  it('install throws E_PKG_DISABLED when policy.enabled is false', () => {
    const { mgr } = createManager({ enabled: false });
    try {
      mgr.install('disabled', SAMPLE_WASM, 'https://example.com/disabled.wasm');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(PkgError);
      expect((e as PkgError).code).toBe('E_PKG_DISABLED');
    }
  });

  it('install throws E_PKG_EXISTS for duplicate name', () => {
    const { mgr } = createManager();
    mgr.install('dupe', SAMPLE_WASM, 'https://example.com/dupe.wasm');
    try {
      mgr.install('dupe', SAMPLE_WASM, 'https://example.com/dupe.wasm');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(PkgError);
      expect((e as PkgError).code).toBe('E_PKG_EXISTS');
    }
  });

  it('install throws E_PKG_TOO_LARGE when exceeding maxPackageBytes', () => {
    const { mgr } = createManager({ maxPackageBytes: 4 });
    try {
      mgr.install('big', SAMPLE_WASM, 'https://example.com/big.wasm');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(PkgError);
      expect((e as PkgError).code).toBe('E_PKG_TOO_LARGE');
    }
  });

  it('install throws E_PKG_LIMIT when maxInstalledPackages reached', () => {
    const { mgr } = createManager({ maxInstalledPackages: 1 });
    mgr.install('first', SAMPLE_WASM, 'https://example.com/first.wasm');
    try {
      mgr.install('second', SAMPLE_WASM, 'https://example.com/second.wasm');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(PkgError);
      expect((e as PkgError).code).toBe('E_PKG_LIMIT');
    }
  });

  it('constructor loads existing metadata from VFS', () => {
    const vfs = new VFS();
    const mgr1 = new PackageManager(vfs, enabledPolicy);
    mgr1.install('persisted', SAMPLE_WASM, 'https://example.com/persisted.wasm');

    // Create a second manager on the same VFS — it should load the metadata
    const mgr2 = new PackageManager(vfs, enabledPolicy);
    const info = mgr2.info('persisted');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('persisted');
  });

  it('install throws E_PKG_HOST_DENIED when host is not in allowedHosts', () => {
    const { mgr } = createManager({ allowedHosts: ['trusted.com'] });
    try {
      mgr.install('bad', SAMPLE_WASM, 'https://evil.com/bad.wasm');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(PkgError);
      expect((e as PkgError).code).toBe('E_PKG_HOST_DENIED');
    }
  });

  it('install succeeds when host IS in allowedHosts', () => {
    const { mgr } = createManager({ allowedHosts: ['trusted.com'] });
    mgr.install('good', SAMPLE_WASM, 'https://trusted.com/good.wasm');
    expect(mgr.info('good')).not.toBeNull();
  });

  it('install succeeds with wildcard allowedHosts pattern', () => {
    const { mgr } = createManager({ allowedHosts: ['*.example.com'] });
    mgr.install('wild', SAMPLE_WASM, 'https://cdn.example.com/wild.wasm');
    expect(mgr.info('wild')).not.toBeNull();
  });

  it('install succeeds when allowedHosts is undefined (all hosts allowed)', () => {
    const { mgr } = createManager();
    mgr.install('any', SAMPLE_WASM, 'https://anywhere.org/any.wasm');
    expect(mgr.info('any')).not.toBeNull();
  });

  it('PackagePolicy type is accepted in SecurityOptions', () => {
    // Type-level check — if this compiles, the type is correctly integrated.
    const opts: SecurityOptions = {
      packagePolicy: {
        enabled: true,
        allowedHosts: ['example.com'],
        maxPackageBytes: 1024 * 1024,
        maxInstalledPackages: 10,
      },
    };
    expect(opts.packagePolicy!.enabled).toBe(true);
    expect(opts.packagePolicy!.allowedHosts).toEqual(['example.com']);
    expect(opts.packagePolicy!.maxPackageBytes).toBe(1024 * 1024);
    expect(opts.packagePolicy!.maxInstalledPackages).toBe(10);
  });
});

// ---- Shell builtin integration tests ----

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');


describe('pkg shell builtin', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('pkg list returns empty initially', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true },
      },
    });

    const result = await sandbox.run('pkg list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('pkg returns error when disabled (no packagePolicy)', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      // No packagePolicy — packageManager will be null
    });

    const result = await sandbox.run('pkg list');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('package manager is disabled');
  });

  it('pkg install rejects denied host', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: {
          enabled: true,
          allowedHosts: ['trusted.example.com'],
        },
      },
    });

    // Host check in PackageManager.install() should deny evil.com before any actual fetch
    const result = await sandbox.run('pkg install https://evil.com/bad.wasm');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not in the allowed hosts list');
  });

  it('pkg info on unknown package returns not found', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true },
      },
    });

    const result = await sandbox.run('pkg info nonexistent');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('pkg with no subcommand shows usage', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true },
      },
    });

    const result = await sandbox.run('pkg');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('usage:');
    expect(result.stderr).toContain('install');
    expect(result.stderr).toContain('remove');
    expect(result.stderr).toContain('list');
    expect(result.stderr).toContain('info');
  });

  it('pkg remove on unknown package returns error', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true },
      },
    });

    const result = await sandbox.run('pkg remove ghost');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not installed');
  });

  it('pkg install emits audit events', async () => {
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: {
          enabled: true,
          allowedHosts: ['trusted.example.com'],
        },
        onAuditEvent: (event) => events.push(event),
      },
    });

    // This will fail because evil.com is not in allowed hosts, but should emit audit events
    await sandbox.run('pkg install https://evil.com/bad.wasm');

    const pkgEvents = events.filter(e => e.type.startsWith('package.'));
    expect(pkgEvents.length).toBeGreaterThanOrEqual(2);
    expect(pkgEvents[0].type).toBe('package.install.start');
    expect(pkgEvents[0].host).toBe('evil.com');

    // The install should be denied
    const deniedEvent = pkgEvents.find(e => e.type === 'package.install.denied');
    expect(deniedEvent).toBeDefined();
    expect(deniedEvent!.host).toBe('evil.com');
  });

  it('pkg install with no URL shows error', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true },
      },
    });

    const result = await sandbox.run('pkg install');
    expect(result.exitCode).toBe(1);
    // Message changed to "no package name or URL specified" when
    // pkg gained registry-name lookup; substring assertion keeps
    // the test stable across either phrasing.
    expect(result.stderr).toContain('URL specified');
  });

  it('pkg unknown subcommand returns error', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        packagePolicy: { enabled: true },
      },
    });

    const result = await sandbox.run('pkg bogus');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown subcommand 'bogus'");
  });
});
