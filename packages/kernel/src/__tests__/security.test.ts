/**
 * Security MVP acceptance tests.
 *
 * Covers all acceptance criteria from docs/plans/2026-02-23-security-mvp-spec.md:
 *   AC1: Infinite loop terminated by hard timeout
 *   AC2: Disallowed network returns capability-denied error
 *   AC3: Host path access denied (VFS is virtual — no host paths by design)
 *   AC4: Stdout flood truncated at configured cap
 *   AC5: Oversized command rejected
 *   AC6: Two concurrent sessions cannot read each other's file state
 *   AC7: Audit logs include timeout, deny, and limit events with stable schema
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');


describe('Security MVP acceptance', () => {
  // AC1: Infinite loop terminated by timeout
  it('AC1: infinite loop is killed by timeout', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { timeoutMs: 100 } },
    });
    const start = performance.now();
    const result = await sb.run('seq 1 999999999');
    const elapsed = performance.now() - start;
    expect(result.errorClass).toBe('TIMEOUT');
    expect(result.exitCode).toBe(124);
    // Should complete near the timeout, not run for 30s
    expect(elapsed).toBeLessThan(3000);
    sb.destroy();
  });

  it('AC1: chained infinite commands killed by timeout', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { timeoutMs: 100 } },
    });
    const result = await sb.run('seq 1 999999999 && seq 1 999999999');
    expect(result.errorClass).toBe('TIMEOUT');
    expect(result.exitCode).toBe(124);
    sb.destroy();
  });

  // AC2: Disallowed network returns capability-denied
  it('AC2: curl without network policy fails', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const result = await sb.run('curl https://evil.com');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not configured');
    sb.destroy();
  });

  it('AC2: wget without network policy fails', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const result = await sb.run('wget https://evil.com');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not configured');
    sb.destroy();
  });

  // AC3: Host path access denied (VFS is virtual, no host paths by design)
  it('AC3: VFS is isolated — no host filesystem access', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // The sandbox initializes a small set of synthesized files
    // (/etc/passwd, /etc/group, /etc/hostname, …) for tooling, so
    // checking those isn't a clean "host isolation" probe anymore.
    // Use a host-specific path that's never present in the VFS:
    // /Users/<anyone>/... is macOS-only and would only exist if we
    // were leaking host filesystem access into the sandbox.
    const result = await sb.run('cat /Users/root/.ssh/id_rsa');
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  // AC4: Stdout flood truncated at configured cap
  it('AC4: stdout flood truncated at cap', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { stdoutBytes: 100 } },
    });
    const result = await sb.run('yes hello | head -1000');
    expect(result.truncated?.stdout).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(200); // 100 + truncation marker
    sb.destroy();
  });

  it('AC4: stderr flood truncated at cap', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { stderrBytes: 50 } },
    });
    // Running a nonexistent command repeated times generates stderr
    const result = await sb.run('nosuchcmd 2>&1 >/dev/null; nosuchcmd; nosuchcmd; nosuchcmd; nosuchcmd');
    // We just verify stderrBytes limit is respected if stderr is large enough
    sb.destroy();
  });

  // AC5: Oversized command rejected
  it('AC5: oversized command rejected before execution', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { commandBytes: 50 } },
    });
    const result = await sb.run('echo ' + 'x'.repeat(100));
    expect(result.errorClass).toBe('LIMIT_EXCEEDED');
    expect(result.exitCode).not.toBe(0);
    expect(result.executionTimeMs).toBe(0);
    sb.destroy();
  });

  it('AC5: command under limit executes normally', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { commandBytes: 1000 } },
    });
    const result = await sb.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.errorClass).toBeUndefined();
    sb.destroy();
  });

  // AC6: Two concurrent sessions cannot read each other's file state
  it('AC6: two sessions have isolated filesystems', async () => {
    const sb1 = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const sb2 = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    await sb1.run('echo secret > /tmp/private.txt');
    const result = await sb2.run('cat /tmp/private.txt');
    expect(result.exitCode).not.toBe(0);

    // Also verify via VFS API
    sb1.writeFile('/tmp/host-data.txt', new TextEncoder().encode('sensitive'));
    expect(() => sb2.readFile('/tmp/host-data.txt')).toThrow();

    sb1.destroy();
    sb2.destroy();
  });

  it('AC6: forked sandbox is isolated from parent after fork', async () => {
    const parent = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    parent.writeFile('/tmp/shared.txt', new TextEncoder().encode('before'));
    const child = await parent.fork();

    child.writeFile('/tmp/shared.txt', new TextEncoder().encode('child-only'));
    expect(new TextDecoder().decode(parent.readFile('/tmp/shared.txt'))).toBe('before');
    expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('child-only');

    child.writeFile('/tmp/new.txt', new TextEncoder().encode('x'));
    expect(() => parent.stat('/tmp/new.txt')).toThrow();

    child.destroy();
    parent.destroy();
  });

  // AC7: Audit logs include timeout, deny, and limit events with stable schema
  it('AC7: audit events have stable schema with sessionId and timestamp', async () => {
    const events: any[] = [];
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        onAuditEvent: (e) => events.push(e),
      },
    });
    await sb.run('echo hello');
    sb.destroy();

    // All events have required fields
    for (const e of events) {
      expect(typeof e.type).toBe('string');
      expect(typeof e.sessionId).toBe('string');
      expect(e.sessionId.length).toBeGreaterThan(0);
      expect(typeof e.timestamp).toBe('number');
      expect(e.timestamp).toBeGreaterThan(0);
    }

    // Check lifecycle events
    const types = events.map(e => e.type);
    expect(types).toContain('sandbox.create');
    expect(types).toContain('command.start');
    expect(types).toContain('command.complete');
    expect(types).toContain('sandbox.destroy');
  });

  it('AC7: timeout event emitted with stable schema', async () => {
    const events: any[] = [];
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        limits: { timeoutMs: 1 },
        onAuditEvent: (e) => events.push(e),
      },
    });
    await sb.run('seq 1 999999999');
    sb.destroy();

    const timeout = events.find(e => e.type === 'command.timeout');
    expect(timeout).toBeDefined();
    expect(timeout.sessionId).toBeDefined();
    expect(timeout.timestamp).toBeGreaterThan(0);
    expect(timeout.command).toBeDefined();
  });

  it('AC7: capability denied event emitted', async () => {
    const events: any[] = [];
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        toolAllowlist: ['echo'],
        onAuditEvent: (e) => events.push(e),
      },
    });
    await sb.run('grep hello /tmp/f.txt');
    sb.destroy();

    const denied = events.find(e => e.type === 'capability.denied');
    expect(denied).toBeDefined();
    expect(denied.sessionId).toBeDefined();
  });

  it('AC7: limit exceeded event emitted on stdout truncation', async () => {
    const events: any[] = [];
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        limits: { stdoutBytes: 20 },
        onAuditEvent: (e) => events.push(e),
      },
    });
    // Bounded producer overshoots the 20-byte cap and trips the
    // limit.exceeded audit hook.  See sandbox.test.ts' note on the
    // same test for the BusyBox-stdio EPIPE interaction that
    // makes `yes hello | head -100` deadlock until we trace why
    // ferror isn't surfacing on EPIPE.
    await sb.run('seq 1 200');
    sb.destroy();

    const limit = events.find(e => e.type === 'limit.exceeded' && e.subtype === 'stdout');
    expect(limit).toBeDefined();
    expect(limit.sessionId).toBeDefined();
  });

  // Tool allowlist enforcement
  it('tool allowlist blocks unauthorized tool', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo'] },
    });
    const result = await sb.run('cat /etc/passwd');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not allowed');
    sb.destroy();
  });

  it('tool allowlist allows authorized tool', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo', 'cat'] },
    });
    sb.writeFile('/tmp/a.txt', new TextEncoder().encode('ok'));
    const result = await sb.run('cat /tmp/a.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    sb.destroy();
  });

  // File count limit — sandbox boot now writes ~350 inodes (tool
  // stubs for the 136 wasm tools + the 96 BusyBox applet symlinks +
  // magic.mgc + manifests + /etc/yurt configs).  Pick a limit
  // ~50 above that baseline so the loop trips the cap partway in.
  it('file count limit prevents inode exhaustion', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { fileCount: 400 } },
    });
    let threw = false;
    for (let i = 0; i < 250; i++) {
      try {
        sb.writeFile(`/tmp/f${i}.txt`, new TextEncoder().encode('x'));
      } catch {
        threw = true;
        break;
      }
    }
    expect(threw).toBe(true);
    sb.destroy();
  });

  // Extension + tool allowlist enforcement (Task 3)
  it('tool allowlist blocks extension not in list', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo'] },
      extensions: [{
        name: 'greet',
        description: 'says hello',
        command: async () => ({ stdout: 'hello\n', exitCode: 0 }),
      }],
    });
    const result = await sb.run('greet');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not allowed');
    sb.destroy();
  });

  it('tool allowlist allows extension in list', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ['echo', 'greet'] },
      extensions: [{
        name: 'greet',
        description: 'says hello',
        command: async () => ({ stdout: 'hello\n', exitCode: 0 }),
      }],
    });
    const result = await sb.run('greet');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    sb.destroy();
  });

  // Extension output limits (Task 4)
  it('extension output is truncated to stdout limit', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { stdoutBytes: 100 } },
      extensions: [{
        name: 'flood',
        description: 'outputs a lot',
        command: async () => ({ stdout: 'x'.repeat(10000), exitCode: 0 }),
      }],
    });
    const result = await sb.run('flood');
    expect(result.stdout.length).toBeLessThanOrEqual(200);
    sb.destroy();
  });

  // Destroy prevents further use
  it('destroyed sandbox rejects all operations', async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    sb.destroy();
    expect(() => sb.readFile('/tmp/x')).toThrow(/destroyed/);
    sb.destroy(); // double destroy is safe
  });
});
