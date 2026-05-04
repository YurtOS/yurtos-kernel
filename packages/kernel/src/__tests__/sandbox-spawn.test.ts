import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { resolve } from 'node:path';
import { NodeAdapter } from '../platform/node-adapter.ts';
import { Sandbox } from '../sandbox.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

Deno.test('sandbox.spawn returns a Process with the requested mode', async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter });
  try {
    sb.writeFile('/tmp/true.wasm', await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`));
    const child = await sb.spawn(['/tmp/true.wasm'], { mode: 'resident' });
    assertEquals(child.mode, 'resident');
    assert(child.pid > 1, 'spawned child should have pid > 1 (PID 1 is the boot process)');
    await child.terminate();
  } finally {
    sb.destroy();
  }
});

Deno.test('sandbox.spawn with mode: cli runs _start to completion', async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter });
  try {
    sb.writeFile('/tmp/true.wasm', await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`));
    const child = await sb.spawn(['/tmp/true.wasm'], { mode: 'cli' });
    assertEquals(child.mode, 'cli');
    assertEquals(child.exitCode, 0);
  } finally {
    sb.destroy();
  }
});

Deno.test('sandbox.spawn with mode: cli preserves captured stdout', async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter });
  try {
    sb.writeFile('/tmp/echo-args.wasm', await adapter.readBytes(`${WASM_DIR}/echo-args.wasm`));
    const child = await sb.spawn(['/tmp/echo-args.wasm', 'hello', 'world'], { mode: 'cli' });
    assertEquals(child.exitCode, 0);
    assertEquals(child.fdReadAndClear(1).data, 'hello\nworld\n');
  } finally {
    sb.destroy();
  }
});
