/**
 * Integration tests for HTTP fetch through the sandbox.
 *
 * Tests curl, wget, and the requests.py shim with a real local HTTP server.
 * The sandbox is created with networking enabled (allowedHosts: ['127.0.0.1']).
 */
import { describe, it, afterEach, beforeAll, afterAll } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('network fetch integration', { sanitizeOps: false, sanitizeResources: false }, () => {
  let serverProcess: ChildProcess;
  let baseUrl: string;
  let sandbox: Sandbox;

  beforeAll(async () => {
    // Spin up a local HTTP server in a child process (same pattern as bridge.test.ts)
    const serverScript = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello from server');
        return;
      }

      if (url.pathname === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: 'value', num: 42 }));
        return;
      }

      if (url.pathname === '/echo-method') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(req.method);
        return;
      }

      if (url.pathname === '/echo-body') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(body);
        });
        return;
      }

      if (url.pathname === '/binary') {
        const buf = Buffer.alloc(256);
        for (let i = 0; i < 256; i++) buf[i] = i;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(buf);
        return;
      }

      if (url.pathname === '/status/404') {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      process.stdout.write(JSON.stringify({ port: addr.port }) + '\\n');
    });
  `;

    serverProcess = spawn(process.execPath, ['-e', serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      serverProcess.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const info = JSON.parse(line.trim());
              if (info.port) { resolve(info.port); return; }
            } catch { /* not yet complete */ }
          }
        }
      });
      serverProcess.on('error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for server')), 5000);
    });

    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  afterEach(() => {
    sandbox?.destroy();
  });

  async function createNetworkSandbox(): Promise<Sandbox> {
    return Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1'] },
    });
  }

  // ---------------------------------------------------------------------------
  // curl
  // ---------------------------------------------------------------------------
  describe('curl', () => {
    it('fetches text content', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(`curl -s ${baseUrl}/text`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello from server');
    });

    it('fetches JSON content', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(`curl -s ${baseUrl}/json`);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.key).toBe('value');
      expect(parsed.num).toBe(42);
    });

    it('sends POST with data', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(`curl -s -X POST -d 'test body' ${baseUrl}/echo-body`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('test body');
    });

    it('saves output to file with -o', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(`curl -s -o /tmp/out.txt ${baseUrl}/text && cat /tmp/out.txt`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello from server');
    });

    it('returns non-zero for connection refused', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run('curl -s http://127.0.0.1:1');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // wget
  // ---------------------------------------------------------------------------
  describe('wget', () => {
    it('downloads to stdout with -O -', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(`wget -qO- ${baseUrl}/text`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello from server');
    });
  });

  // ---------------------------------------------------------------------------
  // requests.py shim
  // ---------------------------------------------------------------------------
  describe('requests.py', () => {
    it('GET returns text', async () => {
      sandbox = await createNetworkSandbox();
      // requests.py is installed at /usr/lib/python/requests.py when networking is enabled
      const r = await sandbox.run(
        `python3 -c "import requests; r = requests.get('${baseUrl}/text'); print(r.text)"`,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('hello from server');
    });

    it('GET returns JSON via .json()', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(
        `python3 -c "import requests; r = requests.get('${baseUrl}/json'); d = r.json(); print(d['key'], d['num'])"`,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('value 42');
    });

    it('status_code and ok property', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(
        `python3 -c "import requests; r = requests.get('${baseUrl}/text'); print(r.status_code, r.ok)"`,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('200 True');
    });

    it('POST with json body', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(
        `python3 -c "import requests; r = requests.post('${baseUrl}/echo-body', json={'a': 1}); print(r.text)"`,
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout.trim());
      expect(parsed.a).toBe(1);
    });

    it('raise_for_status on 404', async () => {
      sandbox = await createNetworkSandbox();
      const r = await sandbox.run(
        `python3 -c "import requests; r = requests.get('${baseUrl}/status/404'); print(r.status_code, r.ok)"`,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('404 False');
    });
  });
});
