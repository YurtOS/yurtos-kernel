import type { FdTarget, TtyState } from '../wasi/fd-target.js';
import { createTtyState, createTtySlaveTarget } from '../wasi/fd-target.js';
import { normalizeNice, normalizeSchedulerPolicy, normalizeSchedulerPriority } from '../engine/backend.js';
import { createAsyncPipe } from '../vfs/pipe.js';
import type { WasiHost } from '../wasi/wasi-host.js';

// Keep kernel-managed descriptors out of the WASI fd table's low range.
// WASI preopens and file opens usually start at 3; pipes/sockets here are
// private yurt fds that guest libc reaches through host_* imports.
export const KERNEL_FD_BASE = 1024;
export const NO_PARENT_PID = 0;
export const INIT_PID = 1;
export const ROOT_UID = 0;
export const ROOT_GID = 0;
export const USER_UID = 1000;
export const USER_GID = 1000;

export interface ProcessCredentials {
  uid: number;
  gid: number;
  euid: number;
  egid: number;
  suid: number;
  sgid: number;
}

export interface SpawnRequest {
  prog: string;
  args: string[];
  env: [string, string][];
  cwd: string;
  nice?: number;
  // snake_case to match JSON from Rust's serde_json
  stdin_fd: number;
  stdout_fd: number;
  stderr_fd: number;
  stdin_data?: string;
}

export interface ProcessEntry {
  pid: number;
  promise: Promise<void> | null;
  exitCode: number;
  state: 'running' | 'exited';
  wasiHost: WasiHost | null;
  waiters: ((exitCode: number) => void)[];
  command?: string;
  pgid: number;
  sid: number;
  controllingTtyId: number | null;
  credentials: ProcessCredentials;
  cwd: string;
  nice: number;
  schedulerPolicy: number;
  schedulerPriority: number;
  umask: number;
}

interface FileLockState {
  exclusive?: string;
  shared: Set<string>;
}

export class ProcessKernel {
  private processTable = new Map<number, ProcessEntry>();
  private nextPid = 2;   // PID 1 is pre-allocated for init
  private parentPids = new Map<number, number>();
  private children = new Map<number, Set<number>>();
  private fdTables = new Map<number, Map<number, FdTarget>>();
  private nextFds = new Map<number, number>();
  private fileLocks = new Map<string, FileLockState>();
  private ttyTable = new Map<number, TtyState>();
  private nextTtyId = 1;

  constructor() {
    // Pre-create init (PID 1): the system ancestor.  It has no controlling
    // terminal, no WASM instance, and never exits.  All top-level processes
    // become children of PID 1; orphaned children are reparented here.
    this.processTable.set(INIT_PID, {
      pid: INIT_PID, promise: null, exitCode: -1, state: 'running',
      wasiHost: null, waiters: [], command: 'init',
      pgid: INIT_PID, sid: INIT_PID, controllingTtyId: null,
      credentials: rootCredentials(),
      cwd: '/',
      nice: 0,
      schedulerPolicy: 0,
      schedulerPriority: 0,
      umask: 0o022,
    });
    this.parentPids.set(INIT_PID, 0);
    this.children.set(INIT_PID, new Set());
    this.fdTables.set(INIT_PID, new Map());
    this.nextFds.set(INIT_PID, KERNEL_FD_BASE);
  }

  createPipe(callerPid: number): { readFd: number; writeFd: number } {
    const fdTable = this.fdTables.get(callerPid);
    if (!fdTable) throw new Error(`No fd table for pid ${callerPid}`);
    const [readEnd, writeEnd] = createAsyncPipe();
    let nextFd = this.nextFds.get(callerPid) ?? KERNEL_FD_BASE;
    const readFd = nextFd++;
    const writeFd = nextFd++;
    this.nextFds.set(callerPid, nextFd);
    fdTable.set(readFd, { type: 'pipe_read', pipe: readEnd });
    fdTable.set(writeFd, { type: 'pipe_write', pipe: writeEnd });
    return { readFd, writeFd };
  }

  getFdTarget(pid: number, fd: number): FdTarget | null {
    return this.fdTables.get(pid)?.get(fd) ?? null;
  }

  getFdTable(pid: number): Map<number, FdTarget> {
    let fdTable = this.fdTables.get(pid);
    if (!fdTable) {
      fdTable = new Map();
      this.fdTables.set(pid, fdTable);
    }
    return fdTable;
  }

  setFdTarget(pid: number, fd: number, target: FdTarget): void {
    const fdTable = this.getFdTable(pid);
    fdTable.set(fd, target);
  }

  allocFd(pid: number, target: FdTarget): number {
    let fdTable = this.fdTables.get(pid);
    if (!fdTable) {
      fdTable = new Map();
      this.fdTables.set(pid, fdTable);
    }
    let nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    while (fdTable.has(nextFd)) nextFd++;
    fdTable.set(nextFd, target);
    this.nextFds.set(pid, nextFd + 1);
    return nextFd;
  }

  getCredentials(pid: number): ProcessCredentials {
    return this.processTable.get(pid)?.credentials ?? userCredentials();
  }

  getCwd(pid: number): string {
    return this.processTable.get(pid)?.cwd ?? '/';
  }

  setCwd(pid: number, cwd: string): void {
    const entry = this.processTable.get(pid);
    if (entry) entry.cwd = normalizeKernelPath(cwd);
  }

  getPriority(pid: number): number {
    return this.processTable.get(pid)?.nice ?? 0;
  }

  setPriority(pid: number, nice: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry) return false;
    entry.nice = normalizeNice(nice);
    return true;
  }

  getScheduler(pid: number): { policy: number; priority: number } {
    const entry = this.processTable.get(pid);
    return {
      policy: entry?.schedulerPolicy ?? 0,
      priority: entry?.schedulerPriority ?? 0,
    };
  }

  setScheduler(pid: number, policyRaw: number, priorityRaw: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry) return false;
    const policy = normalizeSchedulerPolicy(policyRaw);
    const priority = normalizeSchedulerPriority(policy, priorityRaw);
    if (policy < 0 || priority < 0) return false;
    entry.schedulerPolicy = policy;
    entry.schedulerPriority = priority;
    return true;
  }

  getUmask(pid: number): number {
    return this.processTable.get(pid)?.umask ?? 0o022;
  }

  setUmask(pid: number, mask: number): number {
    const entry = this.processTable.get(pid);
    if (!entry) return 0o022;
    const prev = entry.umask;
    entry.umask = normalizeUmask(mask);
    return prev;
  }

  setresuid(pid: number, ruid: number, euid: number, suid: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry) return false;
    const current = entry.credentials;
    const allowed = new Set([current.uid, current.euid, current.suid]);
    if (current.euid !== ROOT_UID) {
      for (const value of [ruid, euid, suid]) {
        if (value !== -1 && !allowed.has(value)) return false;
      }
    }
    entry.credentials = {
      ...current,
      uid: ruid === -1 ? current.uid : ruid,
      euid: euid === -1 ? current.euid : euid,
      suid: suid === -1 ? current.suid : suid,
    };
    return true;
  }

  setresgid(pid: number, rgid: number, egid: number, sgid: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry) return false;
    const current = entry.credentials;
    const allowed = new Set([current.gid, current.egid, current.sgid]);
    if (current.euid !== ROOT_UID) {
      for (const value of [rgid, egid, sgid]) {
        if (value !== -1 && !allowed.has(value)) return false;
      }
    }
    entry.credentials = {
      ...current,
      gid: rgid === -1 ? current.gid : rgid,
      egid: egid === -1 ? current.egid : egid,
      sgid: sgid === -1 ? current.sgid : sgid,
    };
    return true;
  }

  private credentialsForChild(ppid: number): ProcessCredentials {
    const parent = this.processTable.get(ppid);
    if (!parent || ppid === INIT_PID) return userCredentials();
    return { ...parent.credentials };
  }

  private cwdForChild(ppid: number): string {
    return this.processTable.get(ppid)?.cwd ?? '/';
  }

  private priorityForChild(ppid: number): number {
    return this.processTable.get(ppid)?.nice ?? 0;
  }

  private schedulerForChild(ppid: number): { policy: number; priority: number } {
    const parent = this.processTable.get(ppid);
    return {
      policy: parent?.schedulerPolicy ?? 0,
      priority: parent?.schedulerPriority ?? 0,
    };
  }

  private umaskForChild(ppid: number): number {
    return this.processTable.get(ppid)?.umask ?? 0o022;
  }

  buildFdTableForSpawn(callerPid: number, req: SpawnRequest): Map<number, FdTarget> {
    const callerFdTable = this.fdTables.get(callerPid);
    if (!callerFdTable) throw new Error(`No fd table for caller pid ${callerPid}`);
    const newFdTable = new Map<number, FdTarget>();
    const stdinTarget = callerFdTable.get(req.stdin_fd);
    if (stdinTarget) {
      if (stdinTarget.type === 'pipe_read') stdinTarget.pipe.addRef();
      if (stdinTarget.type === 'vfs_file') stdinTarget.refs++;
      newFdTable.set(0, stdinTarget);
    }
    const stdoutTarget = callerFdTable.get(req.stdout_fd);
    if (stdoutTarget) {
      if (stdoutTarget.type === 'pipe_write') stdoutTarget.pipe.addRef();
      if (stdoutTarget.type === 'vfs_file') stdoutTarget.refs++;
      newFdTable.set(1, stdoutTarget);
    }
    const stderrTarget = callerFdTable.get(req.stderr_fd);
    if (stderrTarget) {
      if (stderrTarget.type === 'pipe_write') stderrTarget.pipe.addRef();
      if (stderrTarget.type === 'vfs_file') stderrTarget.refs++;
      newFdTable.set(2, stderrTarget);
    }
    return newFdTable;
  }

  /** Pre-register a process entry so waitpid can find it before async instantiation completes. */
  registerPending(pid: number, command?: string, ppid: number = INIT_PID): void {
    this.parentPids.set(pid, ppid);
    this.initProcess(pid);
    if (!this.processTable.has(pid)) {
      const parentEntry = this.processTable.get(ppid);
      const scheduler = this.schedulerForChild(ppid);
      this.processTable.set(pid, {
        pid, promise: null, exitCode: -1, state: 'running', wasiHost: null, waiters: [],
        command,
        pgid: parentEntry?.pgid ?? INIT_PID,
        sid: parentEntry?.sid ?? INIT_PID,
        controllingTtyId: null,
        credentials: this.credentialsForChild(ppid),
        cwd: this.cwdForChild(ppid),
        nice: this.priorityForChild(ppid),
        schedulerPolicy: scheduler.policy,
        schedulerPriority: scheduler.priority,
        umask: this.umaskForChild(ppid),
      });
    }
  }

  /** Attach a running promise and WasiHost to a previously registered pending process. */
  attachProcess(pid: number, promise: Promise<void>, wasiHost: WasiHost | null): void {
    const entry = this.processTable.get(pid);
    if (!entry) return;
    entry.promise = promise;
    entry.wasiHost = wasiHost;
    const onExit = () => {
      entry.state = 'exited';
      entry.exitCode = wasiHost?.getExitCode() ?? 0;
      this._reparentChildren(pid);
      // Close the child's fds (decrements pipe refcounts, signals EOF).
      this.cleanupFds(pid);
      for (const waiter of entry.waiters) waiter(entry.exitCode);
      entry.waiters.length = 0;
    };
    promise.then(onExit, onExit);
  }

  registerProcess(pid: number, promise: Promise<void>, wasiHost: WasiHost): void {
    this.processTable.set(pid, {
      pid, promise, exitCode: -1, state: 'running', wasiHost, waiters: [],
      pgid: INIT_PID, sid: INIT_PID, controllingTtyId: null,
      credentials: userCredentials(),
      cwd: '/',
      nice: 0,
      schedulerPolicy: 0,
      schedulerPriority: 0,
      umask: 0o022,
    });
    const onExit = () => {
      const entry = this.processTable.get(pid);
      if (entry) {
        entry.state = 'exited';
        entry.exitCode = wasiHost.getExitCode() ?? 0;
        this._reparentChildren(pid);
        for (const waiter of entry.waiters) waiter(entry.exitCode);
        entry.waiters.length = 0;
      }
    };
    promise.then(onExit, onExit);
  }

  allocPid(ppid: number = INIT_PID, command?: string): number {
    const pid = this.nextPid++;
    this.parentPids.set(pid, ppid);
    let siblings = this.children.get(ppid);
    if (!siblings) { siblings = new Set(); this.children.set(ppid, siblings); }
    siblings.add(pid);
    this.initProcess(pid);
    if (command) this.registerPending(pid, command, ppid);
    return pid;
  }

  getPpid(pid: number): number {
    // Returns 0 for init itself (ppid=0 is set explicitly in constructor)
    // and for any pid not in the table (bookkeeping-only / host-side entries).
    return this.parentPids.get(pid) ?? NO_PARENT_PID;
  }

  killProcess(pid: number, _sig: number): boolean {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === 'exited') return false;
    entry.wasiHost?.cancelExecution();
    return true;
  }

  releaseProcess(pid: number, exitCode: number): void {
    this.registerExited(pid, exitCode);
    this._reparentChildren(pid);
    this.cleanupFds(pid);
  }

  /** Register a process as already exited (used for synchronous spawn). */
  registerExited(pid: number, exitCode: number, ppid?: number): void {
    if (ppid !== undefined) this.parentPids.set(pid, ppid);
    this.initProcess(pid);
    const existing = this.processTable.get(pid);
    if (existing) {
      existing.state = 'exited';
      existing.exitCode = exitCode;
      existing.promise = Promise.resolve();
      for (const waiter of existing.waiters) waiter(exitCode);
      existing.waiters.length = 0;
    } else {
      const scheduler = this.schedulerForChild(ppid ?? INIT_PID);
      this.processTable.set(pid, {
        pid, promise: Promise.resolve(), exitCode, state: 'exited', wasiHost: null, waiters: [],
        pgid: INIT_PID, sid: INIT_PID, controllingTtyId: null,
        credentials: this.credentialsForChild(ppid ?? INIT_PID),
        cwd: this.cwdForChild(ppid ?? INIT_PID),
        nice: this.priorityForChild(ppid ?? INIT_PID),
        schedulerPolicy: scheduler.policy,
        schedulerPriority: scheduler.priority,
        umask: this.umaskForChild(ppid ?? INIT_PID),
      });
    }
  }

  async waitpid(pid: number): Promise<number> {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === 'exited') return entry.exitCode;
    return new Promise<number>((resolve) => { entry.waiters.push(resolve); });
  }

  waitpidNohang(pid: number): number {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === 'exited') return entry.exitCode;
    return -1;
  }

  hasProcess(pid: number): boolean {
    return this.processTable.has(pid);
  }

  listProcesses(): { pid: number; state: string; exit_code: number; command: string }[] {
    const result: { pid: number; state: string; exit_code: number; command: string }[] = [];
    for (const [pid, entry] of this.processTable) {
      result.push({
        pid,
        state: entry.state,
        exit_code: entry.exitCode,
        command: entry.command ?? '',
      });
    }
    return result;
  }

  dup(pid: number, fd: number): number {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(fd);
    if (!srcTarget) throw new Error(`dup: fd ${fd} not found`);
    // Add ref for pipes
    if (srcTarget.type === 'pipe_write') srcTarget.pipe.addRef();
    if (srcTarget.type === 'pipe_read') srcTarget.pipe.addRef();
    if (srcTarget.type === 'vfs_file') srcTarget.refs++;
    if (srcTarget.type === 'socket') srcTarget.refs++;
    // Allocate a new fd number
    let nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    const newFd = nextFd++;
    this.nextFds.set(pid, nextFd);
    fdTable.set(newFd, srcTarget);
    return newFd;
  }

  dup2(pid: number, srcFd: number, dstFd: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(srcFd);
    if (!srcTarget) throw new Error(`dup2: src fd ${srcFd} not found`);
    // If dst already exists, close it first (decrement pipe refcount)
    const existing = fdTable.get(dstFd);
    if (existing) {
      this.closeTarget(existing);
    }
    // Point dst to same target as src (add ref for pipes)
    if (srcTarget.type === 'pipe_write') srcTarget.pipe.addRef();
    if (srcTarget.type === 'pipe_read') srcTarget.pipe.addRef();
    if (srcTarget.type === 'vfs_file') srcTarget.refs++;
    if (srcTarget.type === 'socket') srcTarget.refs++;
    fdTable.set(dstFd, srcTarget);
  }

  closeFd(pid: number, fd: number): boolean {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return false;
    const target = fdTable.get(fd);
    if (!target) { fdTable.delete(fd); return false; }
    this.unlockFile(pid, fd);
    this.closeTarget(target);
    fdTable.delete(fd);
    return true;
  }

  lockFile(pid: number, fd: number, exclusive: boolean): number {
    const path = this.vfsPathForFd(pid, fd);
    if (!path) return 9; // EBADF
    const owner = `${pid}:${fd}`;
    const state = this.fileLocks.get(path) ?? { shared: new Set<string>() };

    if (exclusive) {
      const onlyOwnShared = state.shared.size === 0 || (state.shared.size === 1 && state.shared.has(owner));
      if ((state.exclusive && state.exclusive !== owner) || !onlyOwnShared) return 11; // EWOULDBLOCK
      state.exclusive = owner;
      state.shared.delete(owner);
    } else {
      if (state.exclusive && state.exclusive !== owner) return 11; // EWOULDBLOCK
      state.shared.add(owner);
    }

    this.fileLocks.set(path, state);
    return 0;
  }

  unlockFile(pid: number, fd: number): number {
    const path = this.vfsPathForFd(pid, fd);
    if (!path) return 9; // EBADF
    const owner = `${pid}:${fd}`;
    const state = this.fileLocks.get(path);
    if (!state) return 0;
    if (state.exclusive === owner) delete state.exclusive;
    state.shared.delete(owner);
    if (!state.exclusive && state.shared.size === 0) this.fileLocks.delete(path);
    return 0;
  }

  /** Reparent all children of `pid` to init (PID 1); auto-reap any that already exited. */
  private _reparentChildren(pid: number): void {
    const kids = this.children.get(pid);
    if (!kids || kids.size === 0) { this.children.delete(pid); return; }
    const initKids = this.children.get(INIT_PID)!;
    for (const childPid of kids) {
      this.parentPids.set(childPid, INIT_PID);
      const child = this.processTable.get(childPid);
      if (child?.state === 'exited') {
        // Init auto-reaps already-exited orphans — no zombie accumulation.
        this.processTable.delete(childPid);
        this.fdTables.delete(childPid);
        this.nextFds.delete(childPid);
        this.parentPids.delete(childPid);
        this.children.delete(childPid);
      } else {
        initKids.add(childPid);
        // Init has no user-space waiter loop; register a kernel-side reaper so
        // running orphans don't become permanent zombies when they eventually exit.
        if (child) {
          child.waiters.push(() => {
            this.processTable.delete(childPid);
            this.fdTables.delete(childPid);
            this.nextFds.delete(childPid);
            this.parentPids.delete(childPid);
            this.children.delete(childPid);
            initKids.delete(childPid);
          });
        }
      }
    }
    this.children.delete(pid);
  }

  /** Close all fds in a process's fd table (ref-counted close for pipes). */
  private cleanupFds(pid: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return;
    for (const [fd, target] of fdTable) {
      this.unlockFile(pid, fd);
      this.closeTarget(target);
    }
    fdTable.clear();
  }

  private vfsPathForFd(pid: number, fd: number): string | null {
    const target = this.fdTables.get(pid)?.get(fd);
    if (!target || target.type !== 'vfs_file') return null;
    return target.fdTable.getPath(target.fd) ?? null;
  }

  private closeTarget(target: FdTarget): void {
    if (target.type === 'tty_master') {
      const { fgPgid } = target.state;
      target.state.masterClosed = true;
      for (const w of target.state.toSlaveWaiters.splice(0)) w();
      // Terminal hangup: deliver SIGHUP to the foreground process group so
      // processes that don't ignore it (everything except nohup'd daemons) exit.
      if (fgPgid > 0) this.killpg(fgPgid, 1);
    }
    if (target.type === 'pipe_write') target.pipe.close();
    if (target.type === 'pipe_read') target.pipe.close();
    if (target.type === 'vfs_file') {
      target.refs--;
      if (target.refs <= 0) {
        target.fdTable.close(target.fd);
      }
    }
    if (target.type === 'socket') {
      target.refs--;
      if (target.refs <= 0) {
        if (target.listener != null && target.closeListener) {
          target.closeListener(target.listener);
          target.listener = null;
        }
        if (target.socket !== null) {
          target.close(target.socket);
          target.socket = null;
        }
      }
    }
  }

  initProcess(pid: number): void {
    if (!this.fdTables.has(pid)) {
      this.fdTables.set(pid, new Map());
      this.nextFds.set(pid, KERNEL_FD_BASE);
    }
  }

  adoptFdTable(pid: number, fdTable: Map<number, FdTarget>): void {
    this.fdTables.set(pid, fdTable);
    let nextFd = KERNEL_FD_BASE;
    for (const fd of fdTable.keys()) {
      if (fd >= nextFd) nextFd = fd + 1;
    }
    this.nextFds.set(pid, nextFd);
  }

  // ── waitpid(-1) / wait-any ──

  /** Non-blocking: reap the first already-exited child of ppid, or null if none ready. */
  waitAnyNohang(ppid: number): { pid: number; exitCode: number } | null {
    const kids = this.children.get(ppid);
    if (!kids || kids.size === 0) return null;
    for (const childPid of kids) {
      const child = this.processTable.get(childPid);
      if (child?.state === 'exited') {
        const exitCode = child.exitCode;
        this.processTable.delete(childPid);
        this.fdTables.delete(childPid);
        this.nextFds.delete(childPid);
        this.parentPids.delete(childPid);
        this.children.delete(childPid);
        kids.delete(childPid);
        return { pid: childPid, exitCode };
      }
    }
    return null;
  }

  /** Async: wait for the first child of ppid to exit and reap it.
   *  Returns { pid: -1 } if there are no children. */
  async waitAny(ppid: number): Promise<{ pid: number; exitCode: number }> {
    const kids = this.children.get(ppid);
    if (!kids || kids.size === 0) return { pid: -1, exitCode: -1 };
    // Check for already-exited children first.
    const immediate = this.waitAnyNohang(ppid);
    if (immediate) return immediate;
    // Register a one-shot waiter on every running child; first to fire wins.
    return new Promise((resolve) => {
      let resolved = false;
      for (const childPid of [...kids]) {
        const child = this.processTable.get(childPid);
        if (!child || child.state !== 'running') continue;
        child.waiters.push((exitCode) => {
          if (resolved) return;
          resolved = true;
          this.processTable.delete(childPid);
          this.fdTables.delete(childPid);
          this.nextFds.delete(childPid);
          this.parentPids.delete(childPid);
          this.children.delete(childPid);
          kids.delete(childPid);
          resolve({ pid: childPid, exitCode });
        });
      }
      // If every child was already exited between our scan and here (impossible
      // in single-threaded JS, but guard anyway), resolve with ECHILD.
      if (!resolved) resolve({ pid: -1, exitCode: -1 });
    });
  }

  // ── TTY ──

  createTty(): { ttyId: number; state: TtyState } {
    const ttyId = this.nextTtyId++;
    const state = createTtyState(ttyId);
    this.ttyTable.set(ttyId, state);
    return { ttyId, state };
  }

  getTtyState(ttyId: number): TtyState | null {
    return this.ttyTable.get(ttyId) ?? null;
  }

  /** Create a TTY pair and wire fds 0/1/2 of pid to the slave side.
   *  Sets controllingTtyId on the process entry; the returned TtyState is the
   *  host's handle to the master side (write to toSlave, read from toMaster). */
  openTtyForProcess(pid: number): TtyState {
    const { ttyId, state } = this.createTty();
    const slave = createTtySlaveTarget(state);
    this.setFdTarget(pid, 0, slave);
    this.setFdTarget(pid, 1, slave);
    this.setFdTarget(pid, 2, slave);
    const entry = this.processTable.get(pid);
    if (entry) {
      entry.controllingTtyId = ttyId;
      state.fgPgid = entry.pgid > 0 ? entry.pgid : pid;
    }
    return state;
  }

  /** Mark ttyId as the controlling terminal of pid (called via TIOCSCTTY). */
  setControllingTty(pid: number, ttyId: number): number {
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    entry.controllingTtyId = ttyId;
    return 0;
  }

  // ── Process groups / sessions ──

  getpgid(pid: number): number {
    return this.processTable.get(pid)?.pgid ?? -1;
  }

  setpgid(pid: number, pgid: number): number {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === 'exited') return -1;
    entry.pgid = pgid;
    return 0;
  }

  getsid(pid: number): number {
    return this.processTable.get(pid)?.sid ?? -1;
  }

  setsid(pid: number): number {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === 'exited') return -1;
    entry.sid = pid;
    entry.pgid = pid;
    entry.controllingTtyId = null;
    return pid;
  }

  tcgetpgrp(ttyId: number): number {
    return this.ttyTable.get(ttyId)?.fgPgid ?? -1;
  }

  tcsetpgrp(ttyId: number, pgid: number): boolean {
    const state = this.ttyTable.get(ttyId);
    if (!state) return false;
    state.fgPgid = pgid;
    return true;
  }

  killpg(pgid: number, sig: number): number {
    let count = 0;
    for (const entry of this.processTable.values()) {
      if (entry.pgid === pgid && entry.state !== 'exited' && entry.pid !== INIT_PID) {
        this.killProcess(entry.pid, sig);
        count++;
      }
    }
    return count;
  }

  dispose(): void {
    for (const fdTable of this.fdTables.values()) {
      for (const target of fdTable.values()) {
        this.closeTarget(target);
      }
    }
    this.fdTables.clear();
    this.processTable.clear();
    this.parentPids.clear();
    this.fileLocks.clear();
    this.ttyTable.clear();
  }
}

function rootCredentials(): ProcessCredentials {
  return { uid: ROOT_UID, gid: ROOT_GID, euid: ROOT_UID, egid: ROOT_GID, suid: ROOT_UID, sgid: ROOT_GID };
}

function userCredentials(): ProcessCredentials {
  return { uid: USER_UID, gid: USER_GID, euid: USER_UID, egid: USER_GID, suid: USER_UID, sgid: USER_GID };
}

function normalizeKernelPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return '/' + parts.join('/');
}

function normalizeUmask(mask: number): number {
  return Math.trunc(mask) & 0o777;
}
