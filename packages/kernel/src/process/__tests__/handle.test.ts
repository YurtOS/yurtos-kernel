import { assertEquals, assertRejects } from 'jsr:@std/assert@^1.0.19';
import { Process } from '../handle.ts';

Deno.test('Process exposes pid, mode, and exitCode', () => {
  const p = Process.__forTesting({
    pid: 7,
    mode: 'resident',
  });

  assertEquals(p.pid, 7);
  assertEquals(p.mode, 'resident');
  assertEquals(p.exitCode, undefined);
});

Deno.test('Process.callExport rejects when no export wired', async () => {
  const p = Process.__forTesting({ pid: 7, mode: 'resident' });

  await assertRejects(
    () => p.callExport('__run_command', 0, 3),
    Error,
    'no export named __run_command',
  );
});

Deno.test('Process.callExport serializes FIFO per process', async () => {
  const p = Process.__forTesting({ pid: 7, mode: 'resident' });
  let inflight = 0;
  let maxInflight = 0;
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  p.__setExports({
    exports: {
      slow: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await sleep(20);
        inflight--;
        return 0;
      },
    },
  });

  await Promise.all([
    p.callExport('slow'),
    p.callExport('slow'),
    p.callExport('slow'),
    p.callExport('slow'),
    p.callExport('slow'),
  ]);

  assertEquals(maxInflight, 1, 'FIFO must serialize callExport: at most 1 in flight');
});
