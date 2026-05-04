import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ProcessKernel } from '../kernel.js';

describe('ProcessKernel', () => {
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
});
