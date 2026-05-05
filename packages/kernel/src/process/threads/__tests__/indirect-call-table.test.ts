import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  makeIndirectCallTable,
  NULL_INDIRECT_CALL_TABLE,
} from "../indirect-call-table.js";

describe("NULL_INDIRECT_CALL_TABLE", () => {
  it('rejects with a clear "not yet wired" error', async () => {
    let caught: unknown;
    try {
      await NULL_INDIRECT_CALL_TABLE.call(0, 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not yet wired/);
  });
});

describe("makeIndirectCallTable", () => {
  function fakeTable(entries: Array<unknown>): WebAssembly.Table {
    // Minimal duck-typed stand-in. Only `get` is used.
    return {
      get: (i: number) => entries[i],
      // The remaining members exist only for the type assertion.
      length: entries.length,
    } as unknown as WebAssembly.Table;
  }

  const passthroughPromising = (fn: unknown) =>
    fn as (arg: number) => Promise<number>;

  it("throws when the slot is not callable", async () => {
    const table = makeIndirectCallTable(
      fakeTable([null]),
      passthroughPromising,
    );
    let caught: unknown;
    try {
      await table.call(0, 7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not a function/);
  });

  it("forwards the argument and returns the wrapped result", async () => {
    const slot = (x: number) => Promise.resolve(x * 3);
    const table = makeIndirectCallTable(
      fakeTable([slot]),
      passthroughPromising,
    );
    expect(await table.call(0, 5)).toBe(15);
  });

  it("passes the slot function through the supplied promising wrapper", async () => {
    let wrapped = 0;
    const wrapper = (fn: unknown) => {
      wrapped++;
      return fn as (arg: number) => Promise<number>;
    };
    const slot = (x: number) => Promise.resolve(x + 1);
    const table = makeIndirectCallTable(fakeTable([slot]), wrapper);
    await table.call(0, 0);
    await table.call(0, 1);
    expect(wrapped).toBe(2);
  });
});
