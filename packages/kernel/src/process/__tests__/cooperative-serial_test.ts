import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { CooperativeSerialBackend } from "../threads/cooperative-serial.ts";

Deno.test("cooperative serial backend rejects a second live spawned thread", async () => {
  const backend = new CooperativeSerialBackend();
  let releaseFirst!: () => void;
  const firstThreadStarted = new Promise<void>((resolve) => {
    backend.setIndirectCallTable({
      async call(_fnPtr, arg) {
        if (arg === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
        }
        return arg;
      },
    });
  });

  const first = await backend.spawn(1, 1);
  await firstThreadStarted;

  assertEquals(await backend.spawn(1, 2), -1);

  releaseFirst();
  assertEquals(await backend.join(first), 1);
});
