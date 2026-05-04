export interface IndirectCallTable {
  call(fnPtr: number, arg: number): Promise<number>;
}

export function makeIndirectCallTable(
  table: WebAssembly.Table,
  promising: (fn: unknown) => unknown,
): IndirectCallTable {
  return {
    async call(fnPtr: number, arg: number): Promise<number> {
      const fn = table.get(fnPtr);
      if (typeof fn !== 'function') {
        throw new Error(`indirect call: fnPtr ${fnPtr} is not a function`);
      }
      const wrapped = promising(fn) as (arg: number) => Promise<number>;
      return await wrapped(arg);
    },
  };
}

export const NULL_INDIRECT_CALL_TABLE: IndirectCallTable = {
  call() {
    return Promise.reject(new Error('indirect call table not yet wired'));
  },
};
