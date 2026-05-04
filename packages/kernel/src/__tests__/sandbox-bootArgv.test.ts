import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { resolve } from 'node:path';
import { NodeAdapter } from '../platform/node-adapter.ts';
import { Sandbox } from '../sandbox.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

Deno.test('Sandbox.create accepts bootArgv and exposes sandbox.process(1)', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ['/bin/bash'],
  });
  try {
    const p = sb.process(1);
    assert(p, 'sandbox.process(1) should return a Process');
    assertEquals(p.pid, 1);
    assertEquals(p.mode, 'resident');
    assert(typeof p.callExport === 'function');
  } finally {
    sb.destroy();
  }
});

Deno.test('Sandbox.create defaults bootArgv to /bin/bash for compat', async () => {
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
  try {
    const p = sb.process(1);
    assert(p, 'PID 1 should exist with default bootArgv');
  } finally {
    sb.destroy();
  }
});

Deno.test('Sandbox PID 1 keeps synchronous allocator exports', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ['/bin/bash'],
  });
  try {
    const p = sb.process(1)!;
    const ptr = p.exports.__alloc(1);
    assertEquals(typeof ptr, 'number');
    p.exports.__dealloc(ptr as number, 1);
  } finally {
    sb.destroy();
  }
});

Deno.test('Sandbox PID 1 handles run_command responses larger than initial buffer', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ['/bin/bash'],
  });
  try {
    const result = await sb.run('seq 1 1200');
    assertEquals(result.exitCode, 0);
    assert(result.stdout.startsWith('1\n2\n3\n'));
    assert(result.stdout.includes('1200\n'));
  } finally {
    sb.destroy();
  }
});
