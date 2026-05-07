import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { resolve } from 'node:path';
import { NodeAdapter } from '../platform/node-adapter.ts';
import { Sandbox } from '../sandbox.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

Deno.test('runCommandHandler is invoked when a guest calls host_run_command', async () => {
  let handlerCalled = 0;
  let lastCmd = '';
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    runCommandHandler: async (req, ctx) => {
      handlerCalled++;
      lastCmd = req.cmd;
      assertEquals(ctx.sandbox, sb);
      return { exit_code: 0, stdout: 'mock-stdout\n', stderr: '' };
    },
  });
  try {
    const result = await sb.run(
      'python3 -c "import _yurt; print(_yurt.spawn(\'echo hi\')[\'stdout\'], end=\'\')"',
    );
    assertEquals(result.exitCode, 0);
    assertEquals(handlerCalled, 1);
    assertEquals(lastCmd, 'echo hi');
    assert(result.stdout.includes('mock-stdout'));
  } finally {
    sb.destroy();
  }
});

Deno.test('host_run_command returns an error when no runCommandHandler is registered', async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
  });
  try {
    const result = await sb.run(
      'python3 -c "import _yurt; print(_yurt.spawn(\'echo hi\')[\'stderr\'], end=\'\')"',
    );
    assertEquals(result.exitCode, 0);
    assert(result.stdout.includes('subprocess not available'));
  } finally {
    sb.destroy();
  }
});
