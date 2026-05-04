/**
 * End-to-end checks for the Phase A C canaries shipped by the yurt
 * guest compatibility runtime.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import type { NetworkBridgeLike, SyncFetchResult, SyncRequestResult } from '../network/bridge.ts';
import type { SocketBackend, SocketHandle } from '../network/socket-backend.js';

const FIXTURES = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');
const HAS_BUSYBOX_FIXTURE = existsSync(resolve(FIXTURES, 'busybox.wasm'));

class StaticFetchBridge implements NetworkBridgeLike {
  requests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string | null;
    redirect?: 'follow' | 'manual';
  }> = [];

  fetchSync(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    redirect?: 'follow' | 'manual',
  ): SyncFetchResult {
    this.requests.push({ url, method, headers, body, redirect });
    return {
      status: 200,
      headers: {},
      body: 'fetch-canary-ok',
      body_base64: 'ZmV0Y2gtY2FuYXJ5LW9r',
    };
  }

  requestSync(): SyncRequestResult {
    return { ok: false, error: 'not used' };
  }
}

describe('Guest compatibility canaries', () => {
  let sandbox: Sandbox | null = null;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = null;
  });

  it('runs stdio-canary as a normal command', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello canary\n'));

    const result = await sandbox.run('stdio-canary /tmp/in.txt /tmp/out.txt');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('stdio-ok');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/out.txt'))).toBe('hello canary\n');
  });

  it('runs sleep-canary and prints the sleep duration', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const requestedMs = 20;
    const lowerBoundMs = 10;
    const started = performance.now();
    const result = await sandbox.run(`sleep-canary ${requestedMs}`);
    const elapsedMs = performance.now() - started;

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`slept:${requestedMs}`);
    expect(elapsedMs).toBeGreaterThanOrEqual(lowerBoundMs);
  });

  it('runs system-canary through the host command shim', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('system-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain('system-ok');
  });

  it('runs popen-canary and captures command output', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('popen-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('popen:hello-from-shell');
  });

  it('retries host_run_command when the response exceeds the initial buffer', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('system-canary large');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('system-large-ok');
  });

  it('returns the command exit status from yurt_pclose', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('popen-canary status');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('pclose:7');
  });

  it('reports a single visible CPU through the affinity compat layer', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('affinity-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('affinity:get=1,set0=0,set1=einval');
  });

  // ──────────────────────────────────────────────────────────────────────
  // setjmp/longjmp — POSIX exception-style control flow over Asyncify.
  //
  // yurt implements setjmp/longjmp on top of binaryen's Asyncify pass:
  // setjmp captures the current Asyncify save-state into env, longjmp
  // triggers an unwind that the runtime rewinds back to setjmp's call
  // site so the import returns the longjmp value.  These cases exercise
  // the full surface — first-call zero return, value preservation across
  // longjmp, the POSIX zero→one promotion, longjmp from a few frames
  // deep, and negative values — to make sure every dimension of the
  // contract is hit.
  // ──────────────────────────────────────────────────────────────────────
  describe('setjmp-canary', () => {
    it('setjmp returns 0 on the first call', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case setjmp_returns_zero');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"setjmp_returns_zero","exit":0,"observed":0}');
    });

    it('longjmp(env, 42) makes setjmp return 42', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case smoke');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"smoke","exit":0,"observed":42}');
    });

    it('longjmp(env, 0) is promoted to 1 (POSIX)', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case longjmp_zero');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"longjmp_zero","exit":0,"observed":1}');
    });

    it('longjmp from N frames deep unwinds intermediate frames', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case longjmp_through_calls');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"longjmp_through_calls","exit":0,"observed":7}');
      // The "middle" frame's post-longjmp diagnostic must NOT appear:
      // longjmp must skip the intermediate frame, not return to it.
      expect(r.stderr).not.toContain('returned from longjmp');
    });

    it('preserves negative longjmp values byte-for-byte', async () => {
      sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
      const r = await sandbox.run('setjmp-canary --case longjmp_negative');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('{"case":"longjmp_negative","exit":0,"observed":-7}');
    });
  });

  it('routes stderr through stdout after dup2(1, 2)', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('dup2-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('dup2-ok');
    expect(result.stderr).toBe('');
  });

  it('exposes the narrow getgroups compatibility contract', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('getgroups-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('getgroups:1:1000');
  });

  it('exposes the narrow signal compatibility header surface', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('signal-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('signal-ok');
  });

  it('runs the pthread-canary single-thread compatibility test', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('pthread-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('pthread:ok');
  });

  it('exposes the POSIX socket compatibility header surface', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('socket-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"case":"socket_surface","exit":0}');
  });

  it('runs C POSIX socket listener through bind/listen/accept', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1', 'localhost'] },
      serverSockets: { allowLoopback: true },
    });

    const result = await sandbox.run('socket-listen-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('socket-listen=ok');
  });

  it('rejects 0.0.0.0 listener when mapped port authorization denies it', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1', 'localhost'] },
      serverSockets: {
        portMappings: [{ sandboxHost: '0.0.0.0', sandboxPort: 8080, hostPort: 0 }],
        onListen: () => false,
      },
    });

    const result = await sandbox.run('socket-listen-denied-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('listen-denied=ok');
  });

  it('reports POSIX peer and local socket addresses through socket.h', async () => {
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 606 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: (_socket, _maxBytes, opts) => opts?.nonblocking
        ? { ok: false, error: 'EAGAIN' }
        : { ok: true, data_b64: '' },
      close: () => ({ ok: true }),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('socket-address-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('socket-address=ok');
  });

  it('routes C host_network_fetch through yurt_fetch_text', async () => {
    const networkBridge = new StaticFetchBridge();
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['example.test'] },
      networkBridge,
    });

    const result = await sandbox.run('fetch-canary https://example.test/data');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('fetch-canary-ok');
    expect(networkBridge.requests).toEqual([{
      url: 'https://example.test/data',
      method: 'GET',
      headers: {},
      body: null,
      redirect: 'manual',
    }]);
  });

  it('links Rust POSIX socket FFI calls through libyurt', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('socket-rust-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('{"case":"socket_surface","exit":0}');
  });

  it('runs Rust std::env::temp_dir through the Yurt std patch', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-tempdir-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('runs Rust std env/process helpers through the Yurt std patch', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-env-process-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('home=/home/yurt');
    expect(result.stdout).toContain('exe=');
    expect(result.stdout).toContain('pid=1');
  });

  it('runs Rust std path list helpers through the Yurt std patch', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-paths-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('split=/bin:/usr/bin\njoined=/bin:/usr/bin\ninvalid=true');
  });

  it('runs Rust std filesystem helpers through the Yurt std patch', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-fs-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('canonical=');
    expect(result.stdout).toContain('yurt-std-fs-canary.txt');
    expect(result.stdout).toContain('contents=yurt');
  });

  it('runs Rust std file locks with real conflict behavior', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-file-lock-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('exclusive-blocks=true');
  });

  it('runs Rust std thread spawn/join through the Yurt std patch', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-thread-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^parallelism=\d+ joined=42 scoped=6$/);
  });

  it('runs Rust std::process::Command status through libyurt spawn/wait', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-process-status-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'true success=true code=Some(0)\nfalse success=false code=Some(1)',
    );
  });

  it('runs Rust std::process::Command output through libyurt pipes', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-process-output-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('status=Some(0) stdout="hello-rust" stderr=""');
  });

  it('runs Rust std::process::Command env and cwd through libyurt spawn', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-process-env-cwd-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('env-status=Some(0)');
    expect(result.stdout).toContain('cwd-status=Some(0)');
    expect(result.stdout).toContain('cwd-stdout="marker.txt\\n"');
  });

  it('runs Rust std::process::Command spawn with piped stdio', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-process-spawn-stdio-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="spawn-stdin\\n" stderr=""',
    );
  });

  it('reads Rust std::process child stdout after wait', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-process-child-stdout-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="child-stdout"',
    );
  });

  it('routes Rust std::process::Stdio from a child stdout pipe', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-process-stdio-from-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'status=Some(0) stdout="from-child-stdout"',
    );
  });

  it('routes Rust std::net::TcpStream connect through libyurt sockets', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    const result = await sandbox.run('std-net-connect-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('kind=ConnectionRefused');
  });

  it('routes Rust std::net::TcpStream read/write through socket fd I/O', async () => {
    const handle: SocketHandle = 101;
    const requests: Record<string, unknown>[] = [];
    const socketBackend: SocketBackend = {
      connect(req) {
        requests.push({ op: 'connect', ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: 'send', socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: 4 };
      },
      recv(socket, maxBytes) {
        requests.push({ op: 'recv', socket, max_bytes: maxBytes });
        return { ok: true, data_b64: btoa('pong') };
      },
      close(socket) {
        requests.push({ op: 'close', socket });
        return { ok: true };
      },
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-stream-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('reply=pong');
    expect(requests).toContainEqual({ op: 'connect', host: '127.0.0.1', port: 9, tls: false });
    expect(requests).toContainEqual({ op: 'send', socket: handle, data_b64: btoa('ping') });
    expect(requests).toContainEqual({ op: 'recv', socket: handle, max_bytes: 4 });
  });

  it('reports Rust std::net::TcpStream peer_addr for connected streams', async () => {
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 202 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: () => ({ ok: true, data_b64: '' }),
      close: () => ({ ok: true }),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-peer-addr-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('peer=127.0.0.1:9');
  });

  it('routes Rust std::net hostname connects through libyurt netdb', async () => {
    const handle: SocketHandle = 303;
    const requests: Record<string, unknown>[] = [];
    const socketBackend: SocketBackend = {
      connect(req) {
        requests.push({ op: 'connect', ...req });
        return { ok: true, socket: handle };
      },
      send(socket, dataB64) {
        requests.push({ op: 'send', socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv(socket, maxBytes) {
        requests.push({ op: 'recv', socket, max_bytes: maxBytes });
        return { ok: true, data_b64: btoa('pong') };
      },
      close(socket) {
        requests.push({ op: 'close', socket });
        return { ok: true };
      },
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-hostname-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('reply=pong');
    expect(requests).toContainEqual({ op: 'connect', host: 'example.test', port: 443, tls: false });
    expect(requests).toContainEqual({ op: 'send', socket: handle, data_b64: btoa('ping') });
    expect(requests).toContainEqual({ op: 'recv', socket: handle, max_bytes: 4 });
  });

  it('routes Rust std::net::TcpStream shutdown through WASI socket shutdown', async () => {
    const requests: Record<string, unknown>[] = [];
    const socketBackend: SocketBackend = {
      connect(req) {
        requests.push({ op: 'connect', ...req });
        return { ok: true, socket: 404 };
      },
      send(socket, dataB64) {
        requests.push({ op: 'send', socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv(socket, maxBytes) {
        requests.push({ op: 'recv', socket, max_bytes: maxBytes });
        return { ok: true, data_b64: '' };
      },
      close(socket) {
        requests.push({ op: 'close', socket });
        return { ok: true };
      },
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-shutdown-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('shutdown=both');
    expect(requests).toContainEqual({ op: 'connect', host: '127.0.0.1', port: 9, tls: false });
    expect(requests).toContainEqual({ op: 'close', socket: 404 });
  });

  it('duplicates Rust std::net::TcpStream fds through libyurt dup', async () => {
    const requests: Record<string, unknown>[] = [];
    const socketBackend: SocketBackend = {
      connect(req) {
        requests.push({ op: 'connect', ...req });
        return { ok: true, socket: 505 };
      },
      send(socket, dataB64) {
        requests.push({ op: 'send', socket, data_b64: dataB64 });
        return { ok: true, bytes_sent: atob(dataB64).length };
      },
      recv(socket, maxBytes) {
        requests.push({ op: 'recv', socket, max_bytes: maxBytes });
        return { ok: true, data_b64: '' };
      },
      close(socket) {
        requests.push({ op: 'close', socket });
        return { ok: true };
      },
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-try-clone-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('try_clone=ok');
    expect(requests).toContainEqual({ op: 'connect', host: '127.0.0.1', port: 9, tls: false });
    expect(requests).toContainEqual({ op: 'send', socket: 505, data_b64: btoa('one') });
    expect(requests).toContainEqual({ op: 'send', socket: 505, data_b64: btoa('two') });
    expect(requests.filter((req) => req.op === 'close')).toEqual([{ op: 'close', socket: 505 }]);
  });

  it('reports Rust std::net::TcpStream socket_addr through libyurt getsockname', async () => {
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 707 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: () => ({ ok: true, data_b64: '' }),
      close: () => ({ ok: true }),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-socket-addr-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^local=10\.0\.2\.15:\d+$/);
  });

  it('routes Rust std::net::TcpStream take_error through libyurt getsockopt', async () => {
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 808 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: () => ({ ok: true, data_b64: '' }),
      close: () => ({ ok: true }),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-take-error-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('take_error=none');
  });

  it('routes Rust std::net::TcpStream nodelay through libyurt socket options', async () => {
    const requests: unknown[] = [];
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 909 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: () => ({ ok: true, data_b64: '' }),
      close: () => ({ ok: true }),
      setNoDelay: (socket, enabled) => {
        requests.push({ op: 'setNoDelay', socket, enabled });
        return { ok: true };
      },
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-nodelay-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('nodelay=ok');
    expect(requests).toEqual([
      { op: 'setNoDelay', socket: 909, enabled: true },
      { op: 'setNoDelay', socket: 909, enabled: false },
    ]);
  });

  it('routes Rust std::net::TcpStream peek through libyurt socket recv buffering', async () => {
    const requests: unknown[] = [];
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 1001 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: (socket, maxBytes) => {
        requests.push({ op: 'recv', socket, maxBytes });
        return { ok: true, data_b64: btoa('abc') };
      },
      close: () => ({ ok: true }),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-peek-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('peek=ok');
    expect(requests).toEqual([{ op: 'recv', socket: 1001, maxBytes: 3 }]);
  });

  it('routes Rust std::net::TcpStream nonblocking through WASI fd flags', async () => {
    const requests: unknown[] = [];
    const socketBackend: SocketBackend = {
      connect: () => ({ ok: true, socket: 1002 }),
      send: (_socket, dataB64) => ({ ok: true, bytes_sent: atob(dataB64).length }),
      recv: (socket, maxBytes, opts) => {
        requests.push({ op: 'recv', socket, maxBytes, nonblocking: opts?.nonblocking === true });
        return opts?.nonblocking
          ? { ok: false, error: 'EAGAIN' }
          : { ok: true, data_b64: btoa('abc') };
      },
      close: () => ({ ok: true }),
    };
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      socketBackend,
    });

    const result = await sandbox.run('std-net-nonblocking-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('nonblocking=ok');
    expect(requests).toEqual([{ op: 'recv', socket: 1002, maxBytes: 3, nonblocking: true }]);
  });

  it('runs Rust std::net::TcpListener through libyurt sockets', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1', 'localhost'] },
      serverSockets: { allowLoopback: true },
    });

    const result = await sandbox.run('std-net-listener-canary');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('std-net-listener=ok');
  });

  it('spawns a tool via absolute path to its /usr/bin stub', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // Invoking /usr/bin/seq directly (absolute path, not bare name) must work.
    // Before the Gap-1 fix, exec_path would try to execute the tool stub
    // content as a shell script and return exit code 127.
    const result = await sandbox.run('/usr/bin/seq 1 3');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1\n2\n3');
  });

  it('spawns a tool via a VFS symlink to a tool stub', async () => {
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    // A user-created symlink that resolves directly to a multicall
    // binary stub picks up the link's basename as argv[0], which the
    // BusyBox dispatcher uses to select the applet.  /tmp/seq → busybox
    // therefore runs as `seq` — same expected output as a standalone
    // seq.wasm.  (Indirect chains like /tmp/x → /tmp/seq → busybox
    // would carry argv[0]="x" and trip the dispatcher, mirroring
    // Linux behavior — this is documented in the busybox-multicall
    // test below.)
    await sandbox.run('ln -sf /usr/bin/busybox /tmp/seq');
    const result = await sandbox.run('/tmp/seq 1 3');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1\n2\n3');
  });

  const busyboxIt = HAS_BUSYBOX_FIXTURE ? it : it.skip;

  busyboxIt('BusyBox is the default for /usr/bin/<applet> when busybox.wasm ships', async () => {
    // The sandbox auto-installs BusyBox applet symlinks at sandbox-
    // creation time when busybox.wasm is present in wasmDir.  This
    // is equivalent to running `busybox --install -s` once at boot:
    // every applet name in the curated list (declared in
    // packages/c-ports/busybox/manifest.json's `multicall.applets`,
    // shipped to wasmDir as busybox.manifest.json by the port's
    // copy-fixtures step) is symlinked /usr/bin/<applet> →
    // /usr/bin/busybox, and the registry entry for that name is
    // overridden to the busybox.wasm path so the shell dispatches
    // through the multicall binary.
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
    });

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    // /usr/bin/grep is a symlink to /usr/bin/busybox out of the box.
    const linkResult = await sandbox.run('readlink /usr/bin/grep');
    expect(linkResult.stdout.trim()).toBe('/usr/bin/busybox');

    // Bare `grep` resolves through PATH, follows the symlink, and
    // BusyBox's multicall dispatcher picks the grep applet from
    // argv[0].  BusyBox's --help banner says "BusyBox v..." which
    // discriminates against the standalone GNU-style Rust grep.
    const bbHelp = await sandbox.run('grep --help 2>&1');
    expect(bbHelp.stdout + bbHelp.stderr).toContain('BusyBox');

    // Functional dispatch — produces the expected match output.
    const bbGrep = await sandbox.run('grep foo /tmp/data.txt');
    expect(bbGrep.exitCode).toBe(0);
    expect(bbGrep.stdout.trim()).toBe('foo');

    // Absolute path through the symlink also dispatches.  argv[0]
    // is the basename of the path the user typed ("grep"), and
    // BusyBox routes on that — the symlink resolution to busybox.wasm
    // is what the kernel-side spawn picks, but the dispatcher reads
    // argv[0], not the resolved path.
    const bbAbsGrep = await sandbox.run('/usr/bin/grep foo /tmp/data.txt');
    expect(bbAbsGrep.exitCode).toBe(0);
    expect(bbAbsGrep.stdout.trim()).toBe('foo');

    // Direct `busybox <applet>` form still works regardless of PATH.
    const busyboxResult = await sandbox.run('busybox seq 3');
    expect(busyboxResult.exitCode).toBe(0);
    expect(busyboxResult.stdout).toBe('1\n2\n3\n');
  });
});
