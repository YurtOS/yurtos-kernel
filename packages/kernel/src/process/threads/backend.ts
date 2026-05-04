import type { IndirectCallTable } from './indirect-call-table.js';

export interface ThreadsBackend {
  readonly kind: 'cooperative-serial' | 'wasi-threads' | 'worker-sab' | 'wasi-p2';
  setIndirectCallTable(table: IndirectCallTable): void;
  spawn(fnPtr: number, arg: number): Promise<number>;
  join(tid: number): Promise<number>;
  detach(tid: number): Promise<number>;
  self(): number;
  yield_(): Promise<number>;
  mutexLock(mutexPtr: number): Promise<number>;
  mutexUnlock(mutexPtr: number): number;
  mutexTryLock(mutexPtr: number): number;
  condWait(condPtr: number, mutexPtr: number): Promise<number>;
  condSignal(condPtr: number): number;
  condBroadcast(condPtr: number): number;
}
