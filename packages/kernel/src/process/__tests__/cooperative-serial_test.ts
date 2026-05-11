import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { CooperativeSerialBackend } from "../threads/cooperative-serial.ts";

Deno.test("cooperative serial backend returns from spawn while spawned routines run", async () => {
  const backend = new CooperativeSerialBackend();
  let releaseThread!: () => void;
  const threadStarted = new Promise<void>((resolve) => {
    backend.setIndirectCallTable({
      async call(_fnPtr, arg) {
        resolve();
        await new Promise<void>((release) => {
          releaseThread = release;
        });
        return arg;
      },
    });
  });

  let spawnReturned = false;
  const spawnResult = backend.spawn(1, 7).then((tid) => {
    spawnReturned = true;
    return tid;
  });
  await Promise.resolve();

  assertEquals(spawnReturned, true);
  assertEquals(await spawnResult, 1);

  await threadStarted;
  const joinResult = backend.join(1);
  releaseThread();
  assertEquals(await joinResult, 7);
});
