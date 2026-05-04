import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DEFAULT_MAX_PROCESSES, ProcessKernel, ProcessLimitError } from '../kernel.js';

function withTimeout<T>(promise: Promise<T>, ms = 250): Promise<T | 'timeout'> {
  let timeoutId: number | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

describe('ProcessKernel', () => {
  it('uses a finite default process limit', () => {
    const kernel = new ProcessKernel();
    expect(kernel.maxProcesses).toBe(DEFAULT_MAX_PROCESSES);
    expect(kernel.canReserveProcessSlot()).toBe(true);
    kernel.dispose();
  });

  it('rejects invalid process limits', () => {
    expect(() => new ProcessKernel({ maxProcesses: 0 })).toThrow();
    expect(() => new ProcessKernel({ maxProcesses: 1.5 })).toThrow();
  });

  it('applies the process limit before PID allocation or fd-table creation', () => {
    const kernel = new ProcessKernel({ maxProcesses: 1 });
    const first = kernel.allocPid();
    expect(first).toBe(2);
    expect(kernel.getReservedProcessCount()).toBe(1);

    expect(() => kernel.allocPid()).toThrow(ProcessLimitError);

    expect(kernel.getReservedProcessCount()).toBe(1);
    expect(kernel.getPpid(3)).toBe(0);
    expect(kernel.getFdTarget(3, 0)).toBeNull();
    kernel.dispose();
  });

  it('releases a process slot when an exited child is waited', async () => {
    const kernel = new ProcessKernel({ maxProcesses: 1 });
    const pid = kernel.allocPid();
    kernel.releaseProcess(pid, 0);
    expect(kernel.canReserveProcessSlot()).toBe(false);

    expect(await kernel.waitpid(pid)).toBe(0);

    expect(kernel.canReserveProcessSlot()).toBe(true);
    expect(kernel.getReservedProcessCount()).toBe(0);
    expect(kernel.hasProcess(pid)).toBe(false);
    kernel.dispose();
  });

  it('waitAnyChild does not let stale sibling waiters reap later waits', async () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    const first = kernel.allocPid(parent, 'first');
    const second = kernel.allocPid(parent, 'second');

    const firstWait = kernel.waitAnyChild(parent);
    kernel.releaseProcess(first, 0);
    expect(await firstWait).toEqual({ pid: first, exitCode: 0 });

    const secondWait = kernel.waitAnyChild(parent);
    kernel.releaseProcess(second, 7);
    expect(await secondWait).toEqual({ pid: second, exitCode: 7 });
    expect(kernel.hasProcess(second)).toBe(false);
    kernel.dispose();
  });

  it('createPipe returns connected read/write ends', async () => {
    const kernel = new ProcessKernel();
    // Allocate a process so it has an fd table to attach pipe ends to.
    const pid = kernel.allocPid();
    const { readFd, writeFd } = kernel.createPipe(pid);
    expect(readFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBeGreaterThanOrEqual(3);
    expect(writeFd).toBe(readFd + 1);
    kernel.dispose();
  });

  it('closeFd closes pipe ends', () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid();
    const { readFd, writeFd } = kernel.createPipe(pid);
    kernel.closeFd(pid, writeFd);
    kernel.closeFd(pid, readFd);
    kernel.dispose();
  });

  it('getFdTarget returns the target for a given fd', () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid();
    const { readFd } = kernel.createPipe(pid);
    const target = kernel.getFdTarget(pid, readFd);
    expect(target).not.toBeNull();
    expect(target!.type).toBe('pipe_read');
    kernel.dispose();
  });

  // Direct ppid plumbing — guards against any of the four pid-creation
  // entry points (allocPid / registerPending / registerProcess /
  // registerExited) silently dropping back to the wrong default.
  // /proc/<pid>/stat exercises this end-to-end but only via allocPid;
  // covering the others here keeps the contract honest.
  it('records ppid through a 3-generation chain (allocPid)', () => {
    const kernel = new ProcessKernel();
    const a = kernel.allocPid();        // top-level → ppid = INIT_PID (1)
    const b = kernel.allocPid(a);
    const c = kernel.allocPid(b);
    expect(kernel.getPpid(a)).toBe(1);  // INIT_PID
    expect(kernel.getPpid(b)).toBe(a);
    expect(kernel.getPpid(c)).toBe(b);
    kernel.dispose();
  });

  it('records ppid through registerPending', () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    const child = kernel.allocPid();  // freshly allocated, ppid=INIT_PID
    kernel.registerPending(child, 'cat', parent);
    expect(kernel.getPpid(child)).toBe(parent);
    kernel.dispose();
  });

  it('records ppid through registerExited (fresh entry)', () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    // 999 was never allocPid'd — exercises the else branch that
    // creates a new entry rather than updating an existing one.
    kernel.registerExited(999, 0, parent);
    expect(kernel.getPpid(999)).toBe(parent);
    kernel.dispose();
  });

  it('resolves concurrent waitAnyChild callers when the same child exit wakes both', async () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    const child = kernel.allocPid(parent, 'child');

    const firstWait = kernel.waitAnyChild(parent);
    const secondWait = kernel.waitAnyChild(parent);
    kernel.releaseProcess(child, 3);

    const results = await withTimeout(Promise.all([firstWait, secondWait]));
    expect(results).not.toBe('timeout');
    expect(results).toEqual([{ pid: child, exitCode: 3 }, { pid: child, exitCode: 3 }]);
    expect(kernel.getReservedProcessCount()).toBe(1);
    kernel.dispose();
  });

  it('waitAnyChildNohang reaps an exited child without blocking', () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    const running = kernel.allocPid(parent, 'running');
    const exited = kernel.allocPid(parent, 'exited');
    kernel.releaseProcess(exited, 6);

    expect(kernel.waitAnyChildNohang(parent)).toEqual({ state: 'exited', pid: exited, exitCode: 6 });
    expect(kernel.hasProcess(exited)).toBe(false);
    expect(kernel.waitAnyChildNohang(parent)).toEqual({ state: 'running' });
    expect(kernel.hasProcess(running)).toBe(true);
    kernel.dispose();
  });

  it('waitAnyChildNohang distinguishes no children from running children', () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    expect(kernel.waitAnyChildNohang(parent)).toEqual({ state: 'none' });
    const running = kernel.allocPid(parent, 'running');
    expect(kernel.waitAnyChildNohang(parent)).toEqual({ state: 'running' });
    kernel.releaseProcess(running, 0);
    expect(kernel.waitAnyChildNohang(parent)).toEqual({ state: 'exited', pid: running, exitCode: 0 });
    expect(kernel.waitAnyChildNohang(parent)).toEqual({ state: 'none' });
    kernel.dispose();
  });

  it('only allows a parent to wait on its own child', async () => {
    const kernel = new ProcessKernel();
    const parent = kernel.allocPid();
    const sibling = kernel.allocPid();
    const child = kernel.allocPid(parent);

    kernel.releaseProcess(child, 4);

    expect(await kernel.waitpid(child, sibling)).toBe(-1);
    expect(kernel.hasProcess(child)).toBe(true);
    expect(kernel.waitpidNohang(child, sibling)).toBe(-2);

    expect(await kernel.waitpid(child, parent)).toBe(4);
    expect(kernel.hasProcess(child)).toBe(false);
    kernel.dispose();
  });

  it('queues delivered signals before falling back to cancellation', () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(1, 'signal-target');
    const queued: number[] = [];
    let cancelled = false;
    kernel.attachWasiHost(pid, {
      queueSignal(sig: number) {
        queued.push(sig);
        return true;
      },
      cancelExecution() {
        cancelled = true;
      },
    } as unknown as Parameters<ProcessKernel['attachWasiHost']>[1]);

    expect(kernel.killProcess(pid, 10)).toBe(true);
    expect(queued).toEqual([10]);
    expect(cancelled).toBe(false);
    kernel.dispose();
  });
});
