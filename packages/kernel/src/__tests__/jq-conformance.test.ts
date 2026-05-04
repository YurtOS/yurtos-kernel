/**
 * jq conformance tests.  jq.wasm is the upstream jqlang/jq 1.8.1 port
 * built via cpcc (packages/c-ports/jq/).  These tests exercise enough
 * of jq's surface to catch a regression in the port's libc/runtime
 * surface — they are not a substitute for jq's own test suite.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('jq (c-port)', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;
  afterEach(() => sandbox?.destroy());

  it('reports its version', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run('jq --version');
    expect(r.exitCode).toBe(0);
    // upstream tag is jq-1.8.1 — Makefile passes VERSION=1.8.1 so jq
    // identifies itself as `jq-1.8.1`.
    expect(r.stdout.trim()).toBe('jq-1.8.1');
  });

  it('extracts a top-level field with .key', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run(`echo '{"a":1,"b":2}' | jq '.a'`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('1');
  });

  it('iterates an array with .[]', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run(`echo '[1,2,3]' | jq '.[]'`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['1', '2', '3']);
  });

  it('runs a multi-stage pipeline (map + select + length)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run(
      `echo '[{"n":1},{"n":2},{"n":3},{"n":4}]' | jq '[.[] | select(.n > 2)] | length'`
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('2');
  });

  it('supports raw output (-r)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run(`echo '"hello"' | jq -r '.'`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });

  it('exits cleanly without "writing output failed" on stdout close', async () => {
    // Regression: jq calls fclose(stdout) at exit and reports a
    // system error if it returns non-zero.  Our WASI fdClose used to
    // refuse to close stdio fds (returning EBADF), which broke jq
    // and any other tool that does fclose(stdout) on its way out.
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run(`echo '{}' | jq '.'`);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });
});
