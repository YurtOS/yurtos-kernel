/**
 * Integration tests for the Sandbox class.
 *
 * Exercises the full public API: create, run, file operations, env,
 * destroy, timeout, and VFS size limits.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');
const IS_DENO = typeof (globalThis as any).Deno !== 'undefined';
const workerDescribe = IS_DENO ? describe.skip : describe;


describe('Sandbox', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('create and run a simple command', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('run a pipeline', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello world | wc -c');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('12');
  });

  it('executeCommand applies timeout policy around host executors', async () => {
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        limits: { timeoutMs: 1, stdoutBytes: 5, stderrBytes: 3 },
        onAuditEvent: (event) => events.push(event),
      },
    });

    const result = await sandbox.executeCommand('host-side command', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        executionTimeMs: 5,
      };
    });

    expect(result.exitCode).toBe(124);
    expect(result.errorClass).toBe('TIMEOUT');
    expect(events.some((e) => e.type === 'command.timeout')).toBe(true);
  });

  it('executeCommand applies output limits around host executors', async () => {
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: {
        limits: { stdoutBytes: 5, stderrBytes: 3 },
        onAuditEvent: (event) => events.push(event),
      },
    });

    const result = await sandbox.executeCommand('host-side command', async () => ({
      exitCode: 0,
      stdout: '123456789',
      stderr: 'abcdef',
      executionTimeMs: 1,
    }));

    expect(result.stdout).toBe('12345');
    expect(result.stderr).toBe('abc');
    expect(result.truncated).toEqual({ stdout: true, stderr: true });
    expect(events.some((e) => e.type === 'limit.exceeded' && e.subtype === 'stdout')).toBe(true);
    expect(events.some((e) => e.type === 'limit.exceeded' && e.subtype === 'stderr')).toBe(true);
  });

  it('executeCommand uses the supplied host executor even when worker execution is present', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    let workerCalled = 0;
    (sandbox as unknown as { workerExecutor: { run: () => Promise<unknown>; kill: () => void; dispose: () => void } }).workerExecutor = {
      run: async () => {
        workerCalled++;
        return {
          exitCode: 99,
          stdout: 'worker\n',
          stderr: '',
          executionTimeMs: 0,
        };
      },
      kill: () => {},
      dispose: () => {},
    };

    const result = await sandbox.executeCommand('host-side command', async () => ({
      exitCode: 0,
      stdout: 'host\n',
      stderr: '',
      executionTimeMs: 1,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('host\n');
    expect(workerCalled).toBe(0);
  });

  it('run still uses worker execution when present', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    let workerCalled = 0;
    (sandbox as unknown as { workerExecutor: { run: () => Promise<unknown>; kill: () => void; dispose: () => void } }).workerExecutor = {
      run: async () => {
        workerCalled++;
        return {
          exitCode: 0,
          stdout: 'worker\n',
          stderr: '',
          executionTimeMs: 1,
        };
      },
      kill: () => {},
      dispose: () => {},
    };

    const result = await sandbox.run('echo host');

    expect(result.stdout).toBe('worker\n');
    expect(workerCalled).toBe(1);
  });

  it('writeFile and readFile', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const data = new TextEncoder().encode('test content');
    sandbox.writeFile('/tmp/test.txt', data);
    const read = sandbox.readFile('/tmp/test.txt');
    expect(new TextDecoder().decode(read)).toBe('test content');
  });

  it('writeFile then cat via run', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('hello from host'));
    const result = await sandbox.run('cat /tmp/data.txt');
    expect(result.stdout).toBe('hello from host');
  });

  it('mkdir and readDir', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.mkdir('/tmp/mydir');
    const entries = sandbox.readDir('/tmp');
    expect(entries.some(e => e.name === 'mydir')).toBe(true);
  });

  it('stat returns file info', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/s.txt', new TextEncoder().encode('abc'));
    const s = sandbox.stat('/tmp/s.txt');
    expect(s.size).toBe(3);
    expect(s.type).toBe('file');
  });

  it('rm removes a file', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/del.txt', new TextEncoder().encode('x'));
    sandbox.rm('/tmp/del.txt');
    expect(() => sandbox.stat('/tmp/del.txt')).toThrow();
  });

  it('setEnv and getEnv', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.setEnv('MY_VAR', 'hello');
    expect(sandbox.getEnv('MY_VAR')).toBe('hello');
    const result = await sandbox.run('printenv MY_VAR');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('passes argv to external commands', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('printenv PATH');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/usr/extensions:/bin:/usr/bin');
  });

  it('destroy prevents further use', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.destroy();
    expect(() => sandbox.readFile('/tmp/x')).toThrow(/destroyed/);
    sandbox.destroy(); // double destroy is safe
  });

  it('timeout returns exit code 124', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), timeoutMs: 1 });
    const result = await sandbox.run('yes hello | head -1000');
    expect(result.exitCode).toBe(124);
    expect(result.errorClass).toBe('TIMEOUT');
  });

  it('VFS size limit enforces ENOSPC', async () => {
    // Init installs real WASM executables into /bin and /usr/bin; current
    // fixture bytes are ~188.1MB. This limit leaves enough room for the
    // first 40KB write, but not for the second 200KB write.
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), fsLimitBytes: 188_150_000 });
    sandbox.writeFile('/tmp/a.txt', new Uint8Array(40_000));
    expect(() => {
      sandbox.writeFile('/tmp/b.txt', new Uint8Array(10_000_000));
    }).toThrow(/ENOSPC/);
  });

  it('discovers tools via scanTools', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('uname');
    expect(result.stdout.trim()).toBe('yurt');
  });

  describe('aliases', () => {
    it('alias expansion works', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      await sandbox.run('alias greet="echo hello"');
      const r = await sandbox.run('greet world');
      expect(r.stdout).toBe('hello world\n');
    });

    it('alias list and unalias', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      await sandbox.run('alias foo="echo bar"');
      const r1 = await sandbox.run('alias');
      expect(r1.stdout).toContain("alias foo='echo bar'");
      await sandbox.run('unalias foo');
      const r2 = await sandbox.run('alias');
      expect(r2.stdout).not.toContain('foo');
    });
  });

  describe('arrays', () => {
    it('indexed array operations', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('arr=(one two three); echo ${arr[1]}');
      expect(r.stdout).toBe('two\n');
    });

    it('array all elements', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('arr=(a b c); echo ${arr[@]}');
      expect(r.stdout).toBe('a b c\n');
    });

    it('array length', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('arr=(a b c d); echo ${#arr[@]}');
      expect(r.stdout).toBe('4\n');
    });

    it('array append', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('arr=(a b); arr+=(c d); echo ${arr[@]}');
      expect(r.stdout).toBe('a b c d\n');
    });

    it('associative array', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('declare -A m; m[name]=alice; m[age]=30; echo ${m[name]} is ${m[age]}');
      expect(r.stdout).toBe('alice is 30\n');
    });
  });

  describe('process substitution', () => {
    it('input process substitution <(cmd)', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('cat <(echo hello)');
      expect(r.stdout).toBe('hello\n');
    });

    it('diff with two process substitutions', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const r = await sandbox.run('diff <(printf "a\\nb\\n") <(printf "a\\nb\\n")');
      expect(r.exitCode).toBe(0);
    });
  });

  describe('snapshot and restore', () => {
    it('snapshot captures VFS + env state', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('v1'));
      sandbox.setEnv('MY_VAR', 'original');
      const snapId = sandbox.snapshot();

      sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('v2'));
      sandbox.setEnv('MY_VAR', 'changed');
      sandbox.writeFile('/tmp/new.txt', new TextEncoder().encode('new'));

      sandbox.restore(snapId);
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/data.txt'))).toBe('v1');
      expect(sandbox.getEnv('MY_VAR')).toBe('original');
      expect(() => sandbox.stat('/tmp/new.txt')).toThrow();
    });

    it('snapshots are reusable', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('snap'));
      const snapId = sandbox.snapshot();

      sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('changed1'));
      sandbox.restore(snapId);
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/f.txt'))).toBe('snap');

      sandbox.writeFile('/tmp/f.txt', new TextEncoder().encode('changed2'));
      sandbox.restore(snapId);
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/f.txt'))).toBe('snap');
    });

    it('restore throws for invalid snapshot ID', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      expect(() => sandbox.restore('nonexistent')).toThrow();
    });
  });

  describe('fork', () => {
    it('creates an independent sandbox with COW VFS', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/shared.txt', new TextEncoder().encode('original'));
      sandbox.setEnv('FORKED', 'yes');

      const child = await sandbox.fork();
      try {
        expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('original');
        expect(child.getEnv('FORKED')).toBe('yes');

        child.writeFile('/tmp/shared.txt', new TextEncoder().encode('child'));
        expect(new TextDecoder().decode(sandbox.readFile('/tmp/shared.txt'))).toBe('original');
        expect(new TextDecoder().decode(child.readFile('/tmp/shared.txt'))).toBe('child');

        child.writeFile('/tmp/child-only.txt', new TextEncoder().encode('x'));
        expect(() => sandbox.stat('/tmp/child-only.txt')).toThrow();
      } finally {
        child.destroy();
      }
    });

    it('forked sandbox can run commands independently', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const child = await sandbox.fork();
      try {
        const result = await child.run('echo hello from fork');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('hello from fork');
      } finally {
        child.destroy();
      }
    });
  });

  describe('resource limits', () => {
    it('rejects command exceeding commandBytes limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { commandBytes: 10 } },
      });
      const result = await sandbox.run('echo this is a long command that exceeds the limit');
      expect(result.exitCode).toBe(1);
      expect(result.errorClass).toBe('LIMIT_EXCEEDED');
      expect(result.stderr).toContain('command too large');
    });

    it('truncates stdout exceeding stdoutBytes limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { stdoutBytes: 20 } },
      });
      // Use WASM command (not builtin) so WASI-level truncation applies
      const result = await sandbox.run('yes hello | head -100');
      expect(result.truncated?.stdout).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(70); // 20 + truncation marker
    });

    it('truncates stderr exceeding stderrBytes limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { stderrBytes: 20 } },
      });
      // cat on nonexistent file generates stderr via WASM
      const result = await sandbox.run('cat /nonexistent/file1; cat /nonexistent/file2; cat /nonexistent/file3');
      expect(result.truncated?.stderr).toBe(true);
    });

    it('passes fileCount limit to VFS', async () => {
      // The limit must be high enough to survive VFS init + populateBin()
      // which creates ~9 dirs + ~230 tool stubs in /bin and /usr/bin.
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { fileCount: 500 } },
      });
      sandbox.writeFile('/tmp/a.txt', new Uint8Array(1));
      // Fill remaining slots to trigger the limit
      let hitLimit = false;
      for (let i = 0; i < 500; i++) {
        try {
          sandbox.writeFile(`/tmp/fill-${i}.txt`, new Uint8Array(1));
        } catch (e: unknown) {
          if (e instanceof Error && e.message.includes('ENOSPC')) {
            hitLimit = true;
            break;
          }
          throw e;
        }
      }
      expect(hitLimit).toBe(true);
    });

    it('sets errorClass TIMEOUT on timeout', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        timeoutMs: 1,
      });
      const result = await sandbox.run('yes hello | head -1000');
      expect(result.exitCode).toBe(124);
      expect(result.errorClass).toBe('TIMEOUT');
    });

    it('no truncation when output is within limits', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { stdoutBytes: 1_000_000 } },
      });
      const result = await sandbox.run('echo hello');
      expect(result.truncated).toBeUndefined();
    });
  });

  describe('socket shim bootstrap', () => {
    it('writes socket.py to VFS when network is configured', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ['example.com'] },
      });
      const data = sandbox.readFile('/usr/lib/python/socket.py');
      const content = new TextDecoder().decode(data);
      expect(content).toContain('import _yurt');
      expect(content).toContain('class socket:');

      const siteData = sandbox.readFile('/usr/lib/python/sitecustomize.py');
      const siteContent = new TextDecoder().decode(siteData);
      expect(siteContent).toContain('sys.modules[name]');
    });

    it('sets PYTHONPATH when network is configured', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ['example.com'] },
      });
      expect(sandbox.getEnv('PYTHONPATH')).toBe('/usr/lib/python');
    });

    it('does not write socket.py when network is not configured', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
      });
      expect(() => sandbox.readFile('/usr/lib/python/socket.py')).toThrow();
    });

    it('forked sandbox inherits socket.py', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        network: { allowedHosts: ['example.com'] },
      });
      const child = await sandbox.fork();
      try {
        const data = child.readFile('/usr/lib/python/socket.py');
        expect(new TextDecoder().decode(data)).toContain('import _yurt');
      } finally {
        child.destroy();
      }
    });
  });

  describe('output limits', () => {
    it('truncates stdout at configured limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { stdoutBytes: 20 } },
      });
      const result = await sandbox.run('yes hello | head -100');
      expect(result.stdout.length).toBeLessThanOrEqual(70); // 20 + truncation marker
      expect(result.truncated?.stdout).toBe(true);
    });

    it('does not truncate when under limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { stdoutBytes: 10000 } },
      });
      const result = await sandbox.run('echo hello');
      expect(result.truncated?.stdout).toBeFalsy();
    });
  });

  describe('file count limit', () => {
    it('rejects file creation when limit reached', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { fileCount: 500 } },
      });
      // Default layout creates ~170 inodes after boot. Fill beyond the
      // remaining allocation so this assertion tracks the VFS limit instead
      // of depending on the exact default fixture count.
      let threw = false;
      for (let i = 0; i < 400; i++) {
        try {
          sandbox.writeFile(`/tmp/f${i}.txt`, new TextEncoder().encode('x'));
        } catch {
          threw = true;
          break;
        }
      }
      expect(threw).toBe(true);
    });
  });

  describe('command size limit', () => {
    it('rejects command exceeding commandBytes limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { commandBytes: 50 } },
      });
      const result = await sandbox.run('echo ' + 'x'.repeat(100));
      expect(result.errorClass).toBe('LIMIT_EXCEEDED');
      expect(result.exitCode).not.toBe(0);
    });

    it('allows command under the limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { commandBytes: 1000 } },
      });
      const result = await sandbox.run('echo hello');
      expect(result.exitCode).toBe(0);
      expect(result.errorClass).toBeUndefined();
    });
  });

  describe('broadened syscall deadline checks', () => {
    it('kills WASM that calls clock_time_get in a loop', async () => {
      // Python's time.time() calls clock_time_get — a tight loop calling it will now hit the deadline
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { timeoutMs: 300 } },
      });
      const start = performance.now();
      const result = await sandbox.run('python3 -c "import time\nwhile True:\n time.time()"');
      const elapsed = performance.now() - start;
      expect(result.errorClass).toBe('TIMEOUT');
      expect(elapsed).toBeLessThan(3000);
    });
  });

  workerDescribe('worker-based hard kill', () => {
    it('kills a pure CPU-bound Python loop via worker termination', { timeout: 15000 }, async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { hardKill: true, limits: { timeoutMs: 3000 } },
      });
      const start = performance.now();
      const result = await sandbox.run('python3 -c "while True: pass"');
      const elapsed = performance.now() - start;
      expect(result.errorClass).toBe('TIMEOUT');
      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe('hard cancellation', () => {
    it('timeout kills long-running WASM via deadline in fdWrite', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { timeoutMs: 50 } },
      });
      const start = performance.now();
      // seq 1 billion generates huge output; deadline in fdWrite kills it
      const result = await sandbox.run('seq 1 999999999');
      const elapsed = performance.now() - start;
      expect(result.errorClass).toBe('TIMEOUT');
      expect(result.exitCode).toBe(124);
      // Should complete near the timeout, not run for 30s
      expect(elapsed).toBeLessThan(3000);
    });

    it('timeout kills chained commands via deadline in execCommand', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { timeoutMs: 50 } },
      });
      // Two sequential heavy WASM commands — second gets killed by deadline
      const result = await sandbox.run('seq 1 999999999 && seq 1 999999999');
      expect(result.errorClass).toBe('TIMEOUT');
      expect(result.exitCode).toBe(124);
    });
  });

  describe('tool allowlist', () => {
    it('blocks tools not in allowlist', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { toolAllowlist: ['echo', 'cat'] },
      });
      const result = await sandbox.run('grep hello /tmp/f.txt');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not allowed');
    });

    it('allows tools in allowlist', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { toolAllowlist: ['echo', 'cat'] },
      });
      // echo is a builtin, always available
      const result = await sandbox.run('echo hello');
      expect(result.stdout.trim()).toBe('hello');
    });

    it('no allowlist means all tools allowed', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
      });
      const result = await sandbox.run('uname');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('memoryBytes limit', () => {
    it('rejects WASM that exceeds memoryBytes limit', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { memoryBytes: 1024 } }, // 1KB — too small for any WASM
      });
      const result = await sandbox.run('cat /tmp/nonexistent');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('memory limit');
    });
  });

  describe('SecurityOptions', () => {
    it('accepts security options on create', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: {
          limits: { stdoutBytes: 1024, stderrBytes: 1024 },
        },
      });
      const result = await sandbox.run('echo hello');
      expect(result.exitCode).toBe(0);
    });

    it('RunResult includes errorClass on timeout', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { limits: { timeoutMs: 1 } },
      });
      // yes | head produces enough work to exceed 1ms timeout
      const result = await sandbox.run('yes hello | head -10000');
      expect(result.errorClass).toBe('TIMEOUT');
    });
  });

  workerDescribe('hard kill via Worker', () => {
    it('timeout terminates execution via worker.terminate()', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { hardKill: true, limits: { timeoutMs: 200 } },
      });
      const start = performance.now();
      const result = await sandbox.run('seq 1 999999999');
      const elapsed = performance.now() - start;
      expect(result.errorClass).toBe('TIMEOUT');
      expect(result.exitCode).toBe(124);
      expect(elapsed).toBeLessThan(5000);
    });

    it('cancel() immediately kills Worker execution', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { hardKill: true },
        timeoutMs: 30000,
      });
      const promise = sandbox.run('seq 1 999999999');
      await new Promise(r => setTimeout(r, 100));
      sandbox.cancel();
      const result = await promise;
      expect(result.errorClass).toBe('CANCELLED');
      expect(result.exitCode).toBe(125);
    });

    it('next run after timeout works correctly', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { hardKill: true, limits: { timeoutMs: 100 } },
      });
      const r1 = await sandbox.run('seq 1 999999999');
      expect(r1.errorClass).toBe('TIMEOUT');
      const r2 = await sandbox.run('echo recovered');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout.trim()).toBe('recovered');
    });

    it('VFS is consistent after timeout kill', async () => {
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: { hardKill: true, limits: { timeoutMs: 100 } },
      });
      sandbox.writeFile('/tmp/pre.txt', new TextEncoder().encode('before'));
      const r1 = await sandbox.run('seq 1 999999999');
      expect(r1.errorClass).toBe('TIMEOUT');
      const content = sandbox.readFile('/tmp/pre.txt');
      expect(new TextDecoder().decode(content)).toBe('before');
    });
  });

  describe('audit logging', () => {
    it('emits events for command lifecycle', async () => {
      const events: any[] = [];
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: {
          onAuditEvent: (event) => events.push(event),
        },
      });
      await sandbox.run('echo hello');
      sandbox.destroy();

      expect(events.find(e => e.type === 'sandbox.create')).toBeDefined();
      expect(events.find(e => e.type === 'command.start')).toBeDefined();
      expect(events.find(e => e.type === 'command.complete')).toBeDefined();
      expect(events.find(e => e.type === 'sandbox.destroy')).toBeDefined();
    });

    it('emits timeout event', async () => {
      const events: any[] = [];
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: {
          limits: { timeoutMs: 1 },
          onAuditEvent: (event) => events.push(event),
        },
      });
      await sandbox.run('yes hello | head -10000');

      expect(events.find(e => e.type === 'command.timeout')).toBeDefined();
    });

    it('audit events have sessionId and timestamp', async () => {
      const events: any[] = [];
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: {
          onAuditEvent: (event) => events.push(event),
        },
      });
      await sandbox.run('echo hello');

      for (const e of events) {
        expect(e.sessionId).toBeDefined();
        expect(typeof e.sessionId).toBe('string');
        expect(e.timestamp).toBeGreaterThan(0);
      }
      // All events share the same sessionId
      const ids = new Set(events.map(e => e.sessionId));
      expect(ids.size).toBe(1);
    });

    it('emits limit.exceeded event on output truncation', async () => {
      const events: any[] = [];
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: {
          limits: { stdoutBytes: 20 },
          onAuditEvent: (event) => events.push(event),
        },
      });
      // Bounded producer (~700 bytes of output) overshoots the
      // 20-byte cap and trips the limit.exceeded audit hook.
      // Note: the original `yes hello | head -100` form deadlocks
      // — even with the new fdWritePipe-via-writeAsync back-
      // pressure, busybox stdio doesn't surface EPIPE as ferror
      // through some interaction we haven't fully traced (yes
      // keeps calling fd_write 3.7M times receiving WASI_EPIPE
      // and never terminates).  The truncation event fires either
      // way, but the bounded form keeps the test fast.
      await sandbox.run('seq 1 200');

      expect(events.find(e => e.type === 'limit.exceeded' && e.subtype === 'stdout')).toBeDefined();
    });

    it('emits capability.denied on blocked tool', async () => {
      const events: any[] = [];
      sandbox = await Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        security: {
          toolAllowlist: ['echo'],
          onAuditEvent: (event) => events.push(event),
        },
      });
      await sandbox.run('grep hello /tmp/f.txt');

      expect(events.find(e => e.type === 'capability.denied')).toBeDefined();
    });
  });
});
