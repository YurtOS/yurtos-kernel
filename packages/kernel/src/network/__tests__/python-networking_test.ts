import { describe, it, beforeAll, afterAll } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../../sandbox.js';
import { NodeAdapter } from '../../platform/node-adapter.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const WASM_DIR = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');

const PYTHON_WASM = resolve(WASM_DIR, 'python3.wasm');

// Skip all tests if python3.wasm is not available
const hasPython = existsSync(PYTHON_WASM);

describe('Python networking via socket shim', { sanitizeOps: false, sanitizeResources: false }, () => {
  let serverProcess: ChildProcess;
  let serverPort: number;

  beforeAll(async () => {
    if (!hasPython) return;

    const serverScript = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (req.url === '/hello') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello from test server');
          return;
        }
        if (req.url === '/echo') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, body, headers: req.headers }));
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
    });
  `;

    serverProcess = spawn(process.execPath, ['-e', serverScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverPort = await new Promise<number>((resolve, reject) => {
      let output = '';
      serverProcess.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        for (const line of output.split('\n')) {
          if (line.trim()) {
            try {
              const info = JSON.parse(line.trim());
              if (info.port) { resolve(info.port); return; }
            } catch {}
          }
        }
      });
      serverProcess.on('error', reject);
      setTimeout(() => reject(new Error('Timeout waiting for test server')), 5000);
    });
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it('GET request via urllib', { ignore: !hasPython }, async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1'] },
    });

    try {
      const result = await sandbox.run(`python3 -c "
from urllib.request import urlopen
resp = urlopen('http://127.0.0.1:${serverPort}/hello')
print(resp.read().decode())
"`);

      if (result.exitCode !== 0) {
        console.error('STDERR:', result.stderr);
      }
      expect(result.stdout.trim()).toBe('Hello from test server');
      expect(result.exitCode).toBe(0);
    } finally {
      sandbox.destroy();
    }
  }, 60_000);

  it('GET request via http.client', { ignore: !hasPython }, async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1'] },
    });

    try {
      const result = await sandbox.run(`python3 -c "
import http.client
conn = http.client.HTTPConnection('127.0.0.1', ${serverPort})
conn.request('GET', '/hello')
resp = conn.getresponse()
print(resp.read().decode())
conn.close()
"`);

      if (result.exitCode !== 0) {
        console.error('STDERR:', result.stderr);
      }
      expect(result.stdout.trim()).toBe('Hello from test server');
      expect(result.exitCode).toBe(0);
    } finally {
      sandbox.destroy();
    }
  }, 60_000);

  it('POST request with body', { ignore: !hasPython }, async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['127.0.0.1'] },
    });

    try {
      const result = await sandbox.run(`python3 -c "
from urllib.request import urlopen, Request
req = Request('http://127.0.0.1:${serverPort}/echo', data=b'test body', method='POST')
resp = urlopen(req)
import json
data = json.loads(resp.read().decode())
print(data['method'])
print(data['body'])
"`);

      if (result.exitCode !== 0) {
        console.error('STDERR:', result.stderr);
      }
      const lines = result.stdout.trim().split('\n');
      expect(lines[0]).toBe('POST');
      expect(lines[1]).toBe('test body');
      expect(result.exitCode).toBe(0);
    } finally {
      sandbox.destroy();
    }
  }, 60_000);

  it('blocked host returns error', { ignore: !hasPython }, async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      network: { allowedHosts: ['allowed.com'] },
    });

    try {
      const result = await sandbox.run(`python3 -c "
from urllib.request import urlopen
try:
    urlopen('http://127.0.0.1:${serverPort}/hello')
    print('should not reach here')
except Exception as e:
    print('blocked')
"`);

      if (result.exitCode !== 0 && !result.stdout.includes('blocked')) {
        console.error('STDERR:', result.stderr);
      }
      expect(result.stdout.trim()).toBe('blocked');
    } finally {
      sandbox.destroy();
    }
  }, 60_000);

  it('no networking without network config', { ignore: !hasPython }, async () => {
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    try {
      // Without network config, our socket shim is not bootstrapped.
      // The frozen socket module will fail to import (missing _socket C extension),
      // so importing socket should either fail or not have create_connection.
      const result = await sandbox.run(`python3 -c "
try:
    import socket
    print(hasattr(socket, 'create_connection'))
except ImportError:
    print('no_socket')
"`);

      if (result.exitCode !== 0) {
        console.error('STDERR:', result.stderr);
      }
      // Either 'False' (frozen socket loaded but lacks create_connection) or
      // 'no_socket' (frozen socket failed to import due to missing _socket)
      expect(['False', 'no_socket']).toContain(result.stdout.trim());
      expect(result.exitCode).toBe(0);
    } finally {
      sandbox.destroy();
    }
  }, 60_000);
});
