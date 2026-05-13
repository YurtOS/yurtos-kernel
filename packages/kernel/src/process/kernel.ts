import type { FdTarget, TtyState } from "../wasi/fd-target.js";
import {
  createTtySlaveTarget,
  createTtyState,
  createVfsFileTarget,
} from "../wasi/fd-target.js";
import {
  normalizeNice,
  normalizeSchedulerPolicy,
  normalizeSchedulerPriority,
} from "../engine/backend.js";
import { createAsyncPipe } from "../vfs/pipe.js";
import type { WasiHost } from "../wasi/wasi-host.js";
import { FdTable, type OpenMode, type SeekWhence } from "../vfs/fd-table.js";
import type { VfsLike } from "../vfs/vfs-like.js";

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
export const RLIMIT_NOFILE = 7;
export const RLIM_INFINITY_U64 = 0xffff_ffff_ffff_ffffn;
export const DEFAULT_MAX_PROCESSES = 64;
const SIGCHLD = 17;

export class ProcessLimitError extends Error {
  readonly code = "EAGAIN";
  readonly errno = 11;

  constructor(readonly maxProcesses: number) {
    super(`process limit exceeded: max ${maxProcesses}`);
    this.name = "ProcessLimitError";
  }
}

export interface ProcessKernelOptions {
  maxProcesses?: number;
}

export interface ResourceLimit {
  soft: number;
  hard: number;
}

export type SetResourceLimitResult = "ok" | "invalid" | "permission";

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
  argv0?: string;
  args: string[];
  env: [string, string][];
  cwd: string;
  nice?: number;
  // snake_case to match JSON from Rust's serde_json
  stdin_fd: number;
  stdout_fd: number;
  stderr_fd: number;
  stdin_data?: string;
  pass_fds?: number[];
  fd_map?: [number, number][];
}

export interface ProcessEntry {
  pid: number;
  promise: Promise<void> | null;
  exitCode: number;
  exitSignal: number;
  state: "running" | "exited";
  wasiHost: WasiHost | null;
  pendingSignals: number[];
  waiters: ((status: ProcessExitStatus) => void)[];
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
  resourceLimits: Map<number, ResourceLimit>;
}

interface ProcessExitStatus {
  exitCode: number;
  signal: number;
}

interface FileLockState {
  exclusive?: string;
  shared: Set<string>;
}

export class ProcessKernel {
  private processTable = new Map<number, ProcessEntry>();
  private nextPid = 2; // PID 1 is pre-allocated for init
  private allocatedPids = new Set<number>();
  private parentPids = new Map<number, number>();
  private children = new Map<number, Set<number>>();
  private execPidAliases = new Map<number, number>();
  private fdTables = new Map<number, Map<number, FdTarget>>();
  private fdDescriptorFlags = new Map<number, Map<number, number>>();
  private nextFds = new Map<number, number>();
  private fileLocks = new Map<string, FileLockState>();
  private ttyTable = new Map<number, TtyState>();
  private nextTtyId = 1;
  readonly maxProcesses: number;

  constructor(options: ProcessKernelOptions = {}) {
    const maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    if (!Number.isInteger(maxProcesses) || maxProcesses < 1) {
      throw new Error(
        `ProcessKernel maxProcesses must be an integer >= 1, got ${maxProcesses}`,
      );
    }
    this.maxProcesses = maxProcesses;
    // Pre-create init (PID 1): the system ancestor.  It has no controlling
    // terminal, no WASM instance, and never exits.  All top-level processes
    // become children of PID 1; orphaned children are reparented here.
    this.processTable.set(INIT_PID, {
      pid: INIT_PID,
      promise: null,
      exitCode: -1,
      exitSignal: 0,
      state: "running",
      wasiHost: null,
      pendingSignals: [],
      waiters: [],
      command: "init",
      pgid: INIT_PID,
      sid: INIT_PID,
      controllingTtyId: null,
      credentials: rootCredentials(),
      cwd: "/",
      nice: 0,
      schedulerPolicy: 0,
      schedulerPriority: 0,
      umask: 0o022,
      resourceLimits: defaultResourceLimits(),
    });
    this.parentPids.set(INIT_PID, 0);
    this.children.set(INIT_PID, new Set());
    this.fdTables.set(INIT_PID, new Map());
    this.nextFds.set(INIT_PID, KERNEL_FD_BASE);
  }

  getReservedProcessCount(): number {
    return this.allocatedPids.size;
  }

  canReserveProcessSlot(): boolean {
    return this.allocatedPids.size < this.maxProcesses;
  }

  private reservePid(pid: number): void {
    if (pid === INIT_PID || this.allocatedPids.has(pid)) return;
    if (!this.canReserveProcessSlot()) {
      throw new ProcessLimitError(this.maxProcesses);
    }
    this.allocatedPids.add(pid);
  }

  private setParentPid(pid: number, ppid: number): void {
    const previousParent = this.parentPids.get(pid);
    if (previousParent !== undefined && previousParent !== ppid) {
      this.children.get(previousParent)?.delete(pid);
    }
    this.parentPids.set(pid, ppid);
    if (pid !== INIT_PID) {
      let siblings = this.children.get(ppid);
      if (!siblings) {
        siblings = new Set();
        this.children.set(ppid, siblings);
      }
      siblings.add(pid);
    }
  }

  createPipe(callerPid: number): { readFd: number; writeFd: number } {
    const fdTable = this.fdTables.get(callerPid);
    if (!fdTable) throw new Error(`No fd table for pid ${callerPid}`);
    const [readEnd, writeEnd] = createAsyncPipe();
    let nextFd = this.nextFds.get(callerPid) ?? KERNEL_FD_BASE;
    const readFd = nextFd++;
    const writeFd = nextFd++;
    this.nextFds.set(callerPid, nextFd);
    fdTable.set(readFd, { type: "pipe_read", pipe: readEnd });
    fdTable.set(writeFd, { type: "pipe_write", pipe: writeEnd });
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

  setFdDescriptorFlags(pid: number, fd: number, flags: number): void {
    let flagsTable = this.fdDescriptorFlags.get(pid);
    if (!flagsTable) {
      flagsTable = new Map();
      this.fdDescriptorFlags.set(pid, flagsTable);
    }
    flagsTable.set(fd, flags);
  }

  getFdDescriptorFlags(pid: number, fd: number): number {
    return this.fdDescriptorFlags.get(pid)?.get(fd) ?? 0;
  }

  replaceFdTarget(pid: number, fd: number, target: FdTarget): void {
    const fdTable = this.getFdTable(pid);
    const existing = fdTable.get(fd);
    if (existing) this.closeTarget(existing);
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
    this.fdDescriptorFlags.get(pid)?.delete(nextFd);
    this.nextFds.set(pid, nextFd + 1);
    return nextFd;
  }

  allocLowestFd(pid: number, target: FdTarget, startFd = 0): number {
    const fdTable = this.getFdTable(pid);
    let fd = Math.max(0, Math.trunc(startFd));
    while (fdTable.has(fd)) fd++;
    fdTable.set(fd, target);
    this.fdDescriptorFlags.get(pid)?.delete(fd);
    const nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    if (fd >= nextFd) this.nextFds.set(pid, fd + 1);
    return fd;
  }

  openVfsFile(
    pid: number,
    vfs: VfsLike,
    path: string,
    mode: OpenMode,
    preferredFd?: number,
  ): number {
    const processFds = this.getFdTable(pid);
    const fd = preferredFd !== undefined && !processFds.has(preferredFd)
      ? preferredFd
      : this.nextLowestFd(pid, 0);
    const credentials = this.getCredentials(pid);
    const openFile = new FdTable(vfs, {
      uid: credentials.euid,
      gid: credentials.egid,
    });
    let vfsFd = openFile.open(path, mode);
    if (vfsFd !== fd) {
      openFile.renumber(vfsFd, fd);
      vfsFd = fd;
    }
    processFds.set(fd, createVfsFileTarget(openFile, vfsFd));
    this.fdDescriptorFlags.get(pid)?.delete(fd);
    const nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    if (fd >= nextFd) this.nextFds.set(pid, fd + 1);
    return fd;
  }

  vfsFilePath(pid: number, fd: number): string | null {
    return this.vfsPathForFd(pid, fd);
  }

  vfsFileMode(pid: number, fd: number): OpenMode | null {
    const target = this.fdTables.get(pid)?.get(fd);
    if (!target || target.type !== "vfs_file") return null;
    return target.fdTable.getMode(target.fd) ?? null;
  }

  readVfsFile(pid: number, fd: number, buf: Uint8Array): number {
    const target = this.requireVfsFileTarget(pid, fd);
    return target.fdTable.read(target.fd, buf);
  }

  writeVfsFile(pid: number, fd: number, data: Uint8Array): number {
    const target = this.requireVfsFileTarget(pid, fd);
    return target.fdTable.write(target.fd, data);
  }

  preadVfsFile(
    pid: number,
    fd: number,
    buf: Uint8Array,
    offset: number,
  ): number {
    const target = this.requireVfsFileTarget(pid, fd);
    return target.fdTable.pread(target.fd, buf, offset);
  }

  pwriteVfsFile(
    pid: number,
    fd: number,
    data: Uint8Array,
    offset: number,
  ): number {
    const target = this.requireVfsFileTarget(pid, fd);
    return target.fdTable.pwrite(target.fd, data, offset);
  }

  seekVfsFile(
    pid: number,
    fd: number,
    offset: number,
    whence: SeekWhence,
  ): number {
    const target = this.requireVfsFileTarget(pid, fd);
    return target.fdTable.seek(target.fd, offset, whence);
  }

  tellVfsFile(pid: number, fd: number): number {
    const target = this.requireVfsFileTarget(pid, fd);
    return target.fdTable.tell(target.fd);
  }

  truncateVfsFile(pid: number, fd: number, size: number): void {
    const target = this.requireVfsFileTarget(pid, fd);
    target.fdTable.truncate(target.fd, size);
  }

  private nextLowestFd(pid: number, startFd: number): number {
    const fdTable = this.getFdTable(pid);
    let fd = Math.max(0, Math.trunc(startFd));
    while (fdTable.has(fd)) fd++;
    return fd;
  }

  getCredentials(pid: number): ProcessCredentials {
    return this.processTable.get(pid)?.credentials ?? userCredentials();
  }

  setCredentials(pid: number, credentials: ProcessCredentials): void {
    const entry = this.processTable.get(pid);
    if (entry) entry.credentials = { ...credentials };
  }

  getCwd(pid: number): string {
    return this.processTable.get(pid)?.cwd ?? "/";
  }

  setCwd(pid: number, cwd: string): void {
    const entry = this.processTable.get(pid);
    if (entry) entry.cwd = normalizeKernelCwd(cwd);
  }

  remapCwdAfterRename(oldPath: string, newPath: string): void {
    const oldCwd = normalizeKernelCwd(oldPath);
    const newCwd = normalizeKernelCwd(newPath);
    const oldPrefix = oldCwd === "/" ? "/" : `${oldCwd}/`;
    for (const entry of this.processTable.values()) {
      if (entry.cwd === oldCwd) {
        entry.cwd = newCwd;
      } else if (entry.cwd.startsWith(oldPrefix)) {
        const suffix = entry.cwd.slice(oldPrefix.length);
        entry.cwd = newCwd === "/" ? `/${suffix}` : `${newCwd}/${suffix}`;
      }
    }
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

  getResourceLimit(pid: number, resource: number): ResourceLimit | null {
    const entry = this.processTable.get(pid);
    const limits = entry?.resourceLimits ?? defaultResourceLimits();
    const limit = limits.get(resource);
    return limit ? { ...limit } : null;
  }

  setResourceLimit(
    pid: number,
    resource: number,
    softRaw: number | bigint,
    hardRaw: number | bigint,
  ): SetResourceLimitResult {
    const entry = this.processTable.get(pid);
    if (!entry) return "invalid";
    const current = entry.resourceLimits.get(resource);
    if (!current) return "invalid";
    const soft = normalizeLimit(softRaw);
    const hard = normalizeLimit(hardRaw);
    if (soft < 0 || hard < 0 || soft > hard) return "invalid";
    if (entry.credentials.euid !== ROOT_UID && hard > current.hard) {
      return "permission";
    }
    if (entry.credentials.euid !== ROOT_UID && soft > current.hard) {
      return "permission";
    }
    entry.resourceLimits.set(resource, { soft, hard });
    return "ok";
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
    return this.processTable.get(ppid)?.cwd ?? "/";
  }

  private priorityForChild(ppid: number): number {
    return this.processTable.get(ppid)?.nice ?? 0;
  }

  private schedulerForChild(
    ppid: number,
  ): { policy: number; priority: number } {
    const parent = this.processTable.get(ppid);
    return {
      policy: parent?.schedulerPolicy ?? 0,
      priority: parent?.schedulerPriority ?? 0,
    };
  }

  private umaskForChild(ppid: number): number {
    return this.processTable.get(ppid)?.umask ?? 0o022;
  }

  private resourceLimitsForChild(ppid: number): Map<number, ResourceLimit> {
    const parent = this.processTable.get(ppid);
    return cloneResourceLimits(
      parent?.resourceLimits ?? defaultResourceLimits(),
    );
  }

  buildFdTableForSpawn(
    callerPid: number,
    req: SpawnRequest,
  ): Map<number, FdTarget> {
    const callerFdTable = this.fdTables.get(callerPid);
    if (!callerFdTable) {
      throw new Error(`No fd table for caller pid ${callerPid}`);
    }
    const newFdTable = new Map<number, FdTarget>();
    const cloneForChild = (target: FdTarget, childFd: number): FdTarget => {
      if (target.type === "vfs_file") {
        const detached = target.fdTable.duplicateSharedDetached(
          target.fd,
          childFd,
        );
        return { ...target, fdTable: detached.table, fd: detached.fd, refs: 1 };
      }
      this.retainTarget(target);
      return target;
    };
    const setChildFd = (childFd: number, target: FdTarget) => {
      const existing = newFdTable.get(childFd);
      if (existing) this.closeTarget(existing);
      newFdTable.set(childFd, cloneForChild(target, childFd));
    };
    const stdinTarget = callerFdTable.get(req.stdin_fd);
    if (stdinTarget) {
      setChildFd(0, stdinTarget);
    }
    const stdoutTarget = callerFdTable.get(req.stdout_fd);
    if (stdoutTarget) {
      setChildFd(1, stdoutTarget);
    }
    const stderrTarget = callerFdTable.get(req.stderr_fd);
    if (stderrTarget) {
      setChildFd(2, stderrTarget);
    }
    for (const fd of req.pass_fds ?? []) {
      if (!Number.isInteger(fd) || fd < 3) continue;
      if (this.getFdDescriptorFlags(callerPid, fd) & 1) continue;
      const target = callerFdTable.get(fd);
      if (target) {
        try {
          setChildFd(fd, target);
        } catch (err) {
          if (
            target.type !== "vfs_file" ||
            !(err instanceof Error) ||
            !err.message.includes("EBADF")
          ) {
            throw err;
          }
        }
      }
    }
    for (const [parentFd, childFd] of req.fd_map ?? []) {
      if (
        !Number.isInteger(parentFd) || !Number.isInteger(childFd) || childFd < 0
      ) continue;
      const target = callerFdTable.get(parentFd);
      if (target) setChildFd(childFd, target);
    }
    return newFdTable;
  }

  buildFdTableForFork(
    parentPid: number,
    childPid: number,
  ): Map<number, FdTarget> {
    const parentFdTable = this.fdTables.get(parentPid);
    if (!parentFdTable) {
      throw new Error(`No fd table for parent pid ${parentPid}`);
    }
    const parentFlags = this.fdDescriptorFlags.get(parentPid);
    const childFlags = new Map<number, number>();
    const childFdTable = new Map<number, FdTarget>();
    for (const [fd, target] of parentFdTable) {
      if (target.type === "vfs_file") {
        const detached = target.fdTable.duplicateSharedDetached(target.fd, fd);
        childFdTable.set(fd, {
          ...target,
          fdTable: detached.table,
          fd: detached.fd,
          refs: 1,
        });
      } else if (target.type === "pipe_read" || target.type === "pipe_write") {
        target.pipe.addRef();
        childFdTable.set(fd, target);
      } else if (target.type === "socket") {
        target.refs++;
        childFdTable.set(fd, target);
      } else {
        childFdTable.set(fd, target);
      }
      const flags = parentFlags?.get(fd);
      if (flags !== undefined) childFlags.set(fd, flags);
    }
    this.fdDescriptorFlags.set(parentPid, parentFlags ?? new Map());
    this.fdDescriptorFlags.set(childPid, childFlags);
    return childFdTable;
  }

  /** Pre-register a process entry so waitpid can find it before async instantiation completes. */
  registerPending(pid: number, command?: string, ppid?: number): void {
    const parentPid = ppid ?? this.parentPids.get(pid) ?? INIT_PID;
    this.reservePid(pid);
    this.setParentPid(pid, parentPid);
    this.initProcess(pid);
    if (!this.processTable.has(pid)) {
      const parentEntry = this.processTable.get(parentPid);
      const scheduler = this.schedulerForChild(parentPid);
      this.processTable.set(pid, {
        pid,
        promise: null,
        exitCode: -1,
        exitSignal: 0,
        state: "running",
        wasiHost: null,
        pendingSignals: [],
        waiters: [],
        command,
        pgid: parentEntry?.pgid ?? INIT_PID,
        sid: parentEntry?.sid ?? INIT_PID,
        controllingTtyId: null,
        credentials: this.credentialsForChild(parentPid),
        cwd: this.cwdForChild(parentPid),
        nice: this.priorityForChild(parentPid),
        schedulerPolicy: scheduler.policy,
        schedulerPriority: scheduler.priority,
        umask: this.umaskForChild(parentPid),
        resourceLimits: this.resourceLimitsForChild(parentPid),
      });
    }
  }

  /** Attach a running promise and WasiHost to a previously registered pending process. */
  attachProcess(
    pid: number,
    promise: Promise<void>,
    wasiHost: WasiHost | null,
  ): void {
    const entry = this.processTable.get(pid);
    if (!entry) return;
    entry.promise = promise;
    entry.wasiHost = wasiHost;
    const onExit = () => {
      entry.state = "exited";
      entry.exitCode = wasiHost?.getExitCode() ?? 0;
      entry.exitSignal = wasiHost?.getExitSignal() ?? 0;
      this.notifyParentOfChildExit(pid);
      this._reparentChildren(pid);
      // Close the child's fds (decrements pipe refcounts, signals EOF).
      this.cleanupFds(pid);
      for (const waiter of entry.waiters) waiter(this.statusFor(entry));
      entry.waiters.length = 0;
    };
    promise.then(onExit, onExit);
  }

  registerProcess(
    pid: number,
    promise: Promise<void>,
    wasiHost: WasiHost,
  ): void {
    this.reservePid(pid);
    this.processTable.set(pid, {
      pid,
      promise,
      exitCode: -1,
      exitSignal: 0,
      state: "running",
      wasiHost,
      pendingSignals: [],
      waiters: [],
      pgid: INIT_PID,
      sid: INIT_PID,
      controllingTtyId: null,
      credentials: userCredentials(),
      cwd: "/",
      nice: 0,
      schedulerPolicy: 0,
      schedulerPriority: 0,
      umask: 0o022,
      resourceLimits: defaultResourceLimits(),
    });
    const onExit = () => {
      const entry = this.processTable.get(pid);
      if (entry) {
        entry.state = "exited";
        entry.exitCode = wasiHost.getExitCode() ?? 0;
        entry.exitSignal = wasiHost.getExitSignal();
        this.notifyParentOfChildExit(pid);
        this._reparentChildren(pid);
        this.cleanupFds(pid);
        for (const waiter of entry.waiters) waiter(this.statusFor(entry));
        entry.waiters.length = 0;
      }
    };
    promise.then(onExit, onExit);
  }

  allocPid(ppid: number = INIT_PID, command?: string): number {
    while (this.allocatedPids.has(this.nextPid)) this.nextPid++;
    this.reservePid(this.nextPid);
    const pid = this.nextPid++;
    this.setParentPid(pid, ppid);
    this.initProcess(pid);
    if (command) this.registerPending(pid, command, ppid);
    return pid;
  }

  getPpid(pid: number): number {
    // Returns 0 for init itself (ppid=0 is set explicitly in constructor)
    // and for any pid not in the table (bookkeeping-only / host-side entries).
    return this.parentPids.get(pid) ?? NO_PARENT_PID;
  }

  getVisiblePid(pid: number): number {
    return this.execPidAliases.get(pid) ?? pid;
  }

  resolveVisiblePid(pid: number): number {
    for (const [replacementPid, visiblePid] of this.execPidAliases) {
      if (visiblePid !== pid) continue;
      const entry = this.processTable.get(replacementPid);
      if (entry?.state === "running") return replacementPid;
    }
    return pid;
  }

  getVisiblePpid(pid: number): number {
    const visiblePid = this.getVisiblePid(pid);
    return this.parentPids.get(visiblePid) ?? NO_PARENT_PID;
  }

  isChildOf(pid: number, parentPid: number): boolean {
    return this.parentPids.get(pid) === parentPid;
  }

  markExecReplacement(wrapperPid: number, replacementPid: number): boolean {
    if (!this.isChildOf(replacementPid, wrapperPid)) return false;
    const wrapper = this.processTable.get(wrapperPid);
    const replacement = this.processTable.get(replacementPid);
    if (!wrapper || !replacement) return false;
    if (wrapper.state === "exited" || replacement.state === "exited") {
      return false;
    }
    this.execPidAliases.set(replacementPid, wrapperPid);
    return true;
  }

  attachWasiHost(pid: number, wasiHost: WasiHost): void {
    const entry = this.processTable.get(pid);
    if (!entry) return;
    entry.wasiHost = wasiHost;
    const pending = entry.pendingSignals.splice(0);
    for (const sig of pending) {
      if (!wasiHost.queueSignal(sig)) {
        wasiHost.cancelExecution(sig);
      }
    }
  }

  killProcess(pid: number, sig: number): boolean {
    const effectivePid = this.pidForSignalTarget(pid);
    const entry = this.processTable.get(effectivePid);
    if (!entry || entry.state === "exited") return false;
    if (entry.wasiHost?.queueSignal(sig)) return true;
    if (entry.wasiHost) entry.wasiHost.cancelExecution(sig);
    else entry.pendingSignals.push(sig);
    return true;
  }

  private pidForSignalTarget(pid: number): number {
    for (const [candidatePid, visiblePid] of this.execPidAliases) {
      const entry = this.processTable.get(candidatePid);
      if (visiblePid === pid && entry?.state === "running") return candidatePid;
    }
    return pid;
  }

  releaseProcess(pid: number, exitCode: number, signal = 0): void {
    this.execPidAliases.delete(pid);
    this._reparentChildren(pid);
    this.cleanupFds(pid);
    this.registerExited(pid, exitCode, undefined, signal);
    this.notifyParentOfChildExit(pid);
  }

  discardProcess(pid: number): void {
    this.execPidAliases.delete(pid);
    this.cleanupFds(pid);
    this.reapProcess(pid);
  }

  releaseFdTable(fdTable: Map<number, FdTarget>): void {
    for (const target of fdTable.values()) this.closeTarget(target);
    fdTable.clear();
  }

  /** Register a process as already exited (used for synchronous spawn). */
  registerExited(
    pid: number,
    exitCode: number,
    ppid?: number,
    signal = 0,
  ): void {
    this.reservePid(pid);
    if (ppid !== undefined) this.setParentPid(pid, ppid);
    this.initProcess(pid);
    const existing = this.processTable.get(pid);
    if (existing) {
      existing.state = "exited";
      existing.exitCode = exitCode;
      existing.exitSignal = signal;
      existing.promise = Promise.resolve();
      for (const waiter of existing.waiters) waiter(this.statusFor(existing));
      existing.waiters.length = 0;
    } else {
      const scheduler = this.schedulerForChild(ppid ?? INIT_PID);
      this.processTable.set(pid, {
        pid,
        promise: Promise.resolve(),
        exitCode,
        exitSignal: signal,
        state: "exited",
        wasiHost: null,
        pendingSignals: [],
        waiters: [],
        pgid: INIT_PID,
        sid: INIT_PID,
        controllingTtyId: null,
        credentials: this.credentialsForChild(ppid ?? INIT_PID),
        cwd: this.cwdForChild(ppid ?? INIT_PID),
        nice: this.priorityForChild(ppid ?? INIT_PID),
        schedulerPolicy: scheduler.policy,
        schedulerPriority: scheduler.priority,
        umask: this.umaskForChild(ppid ?? INIT_PID),
        resourceLimits: this.resourceLimitsForChild(ppid ?? INIT_PID),
      });
    }
  }

  private notifyParentOfChildExit(pid: number): void {
    const ppid = this.parentPids.get(pid);
    if (!ppid || ppid === NO_PARENT_PID) return;
    this.processTable.get(ppid)?.wasiHost?.queueSignal(SIGCHLD);
  }

  private statusFor(entry: ProcessEntry): ProcessExitStatus {
    return { exitCode: entry.exitCode, signal: entry.exitSignal };
  }

  async waitpid(pid: number, parentPid?: number): Promise<number> {
    if (parentPid !== undefined && !this.isChildOf(pid, parentPid)) return -1;
    const entry = this.processTable.get(pid);
    if (!entry) return -1;
    if (entry.state === "exited") {
      const { exitCode } = this.statusFor(entry);
      this.reapProcess(pid);
      return exitCode;
    }
    return new Promise<number>((resolve) => {
      entry.waiters.push(({ exitCode }) => {
        this.reapProcess(pid);
        resolve(exitCode);
      });
    });
  }

  async waitpidInterruptible(
    pid: number,
    parentPid: number | undefined,
    interrupt: Promise<void>,
  ): Promise<{ interrupted: true } | { interrupted: false; exitCode: number }> {
    const waited = await this.waitpidStatusInterruptible(
      pid,
      parentPid,
      interrupt,
    );
    return waited.interrupted
      ? waited
      : { interrupted: false, exitCode: waited.exitCode };
  }

  async waitpidStatusInterruptible(
    pid: number,
    parentPid: number | undefined,
    interrupt: Promise<void>,
  ): Promise<
    | { interrupted: true }
    | { interrupted: false; exitCode: number; signal: number }
  > {
    if (parentPid !== undefined && !this.isChildOf(pid, parentPid)) {
      return { interrupted: false, exitCode: -1, signal: 0 };
    }
    const entry = this.processTable.get(pid);
    if (!entry) return { interrupted: false, exitCode: -1, signal: 0 };
    if (entry.state === "exited") {
      const status = this.statusFor(entry);
      this.reapProcess(pid);
      return { interrupted: false, ...status };
    }

    return new Promise((resolve) => {
      let settled = false;
      const waiter = (status: ProcessExitStatus) => {
        if (settled) return;
        settled = true;
        this.reapProcess(pid);
        resolve({ interrupted: false, ...status });
      };
      entry.waiters.push(waiter);
      interrupt.then(() => {
        if (settled) return;
        settled = true;
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
        resolve({ interrupted: true });
      });
    });
  }

  waitpidNohang(pid: number, parentPid?: number): number {
    const result = this.waitpidStatusNohang(pid, parentPid);
    return result.state === "exited" ? result.exitCode : result.code;
  }

  waitpidStatusNohang(pid: number, parentPid?: number):
    | { state: "exited"; exitCode: number; signal: number }
    | { state: "not_ready"; code: number } {
    if (parentPid !== undefined && !this.isChildOf(pid, parentPid)) {
      return { state: "not_ready", code: -2 };
    }
    const entry = this.processTable.get(pid);
    if (!entry) {
      return {
        state: "not_ready",
        code: parentPid === undefined ? -1 : -2,
      };
    }
    if (entry.state === "exited") {
      const status = this.statusFor(entry);
      this.reapProcess(pid);
      return { state: "exited", ...status };
    }
    return { state: "not_ready", code: -1 };
  }

  hasProcess(pid: number): boolean {
    return this.processTable.has(pid);
  }

  private procFdsFor(pid: number): number[] {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return [];

    const visible = new Set<number>();
    const pseudoDirs: number[] = [];
    for (const [fd, target] of fdTable) {
      if (fd === 3 && target.type === "vfs_dir" && target.path === "/") {
        continue;
      }
      if (fd >= 100 && target.type === "vfs_dir") {
        pseudoDirs.push(fd);
        continue;
      }
      visible.add(fd);
    }

    for (const fd of pseudoDirs.sort((a, b) => a - b)) {
      let displayFd = 3;
      while (visible.has(displayFd)) displayFd++;
      visible.add(displayFd);
    }

    return Array.from(visible).sort((a, b) => a - b);
  }

  listProcesses(): {
    pid: number;
    ppid: number;
    pgid: number;
    sid: number;
    state: string;
    exit_code: number;
    command: string;
    fds: number[];
  }[] {
    const result: {
      pid: number;
      ppid: number;
      pgid: number;
      sid: number;
      state: string;
      exit_code: number;
      command: string;
      fds: number[];
    }[] = [];
    const hiddenExecWrappers = new Set<number>();
    for (const [replacementPid, visiblePid] of this.execPidAliases) {
      const replacement = this.processTable.get(replacementPid);
      if (replacement?.state === "running") hiddenExecWrappers.add(visiblePid);
    }
    for (const [pid, entry] of this.processTable) {
      const visiblePid = this.getVisiblePid(pid);
      if (visiblePid === pid && hiddenExecWrappers.has(pid)) continue;
      result.push({
        pid: visiblePid,
        ppid: this.parentPids.get(visiblePid) ?? 0,
        pgid: entry.pgid,
        sid: entry.sid,
        state: entry.state,
        exit_code: entry.exitCode,
        command: entry.command ?? "",
        fds: this.procFdsFor(pid),
      });
    }
    return result;
  }

  dup(pid: number, fd: number): number {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(fd);
    if (!srcTarget) throw new Error(`dup: fd ${fd} not found`);
    let nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    while (fdTable.has(nextFd)) nextFd++;
    const newFd = nextFd++;
    this.nextFds.set(pid, nextFd);
    if (srcTarget.type === "vfs_file") {
      srcTarget.fdTable.dupToShared(srcTarget.fd, newFd);
      fdTable.set(newFd, { ...srcTarget, fd: newFd, refs: 1 });
    } else {
      this.retainTarget(srcTarget);
      fdTable.set(newFd, srcTarget);
    }
    this.fdDescriptorFlags.get(pid)?.delete(newFd);
    return newFd;
  }

  dupFromProcess(callerPid: number, sourcePid: number, fd: number): number {
    const callerFdTable = this.fdTables.get(callerPid);
    if (!callerFdTable) {
      throw new Error(`No fd table for caller pid ${callerPid}`);
    }
    const sourceFdTable = this.fdTables.get(sourcePid);
    if (!sourceFdTable) {
      throw new Error(`No fd table for source pid ${sourcePid}`);
    }
    const srcTarget = sourceFdTable.get(fd);
    if (!srcTarget) {
      throw new Error(
        `dupFromProcess: fd ${fd} not found for pid ${sourcePid}`,
      );
    }

    let nextFd = this.nextFds.get(callerPid) ?? KERNEL_FD_BASE;
    while (callerFdTable.has(nextFd)) nextFd++;
    const newFd = nextFd++;
    this.nextFds.set(callerPid, nextFd);

    if (srcTarget.type === "vfs_file") {
      const vfsFd = srcTarget.fdTable.dupShared(srcTarget.fd);
      callerFdTable.set(newFd, { ...srcTarget, fd: vfsFd, refs: 1 });
    } else {
      this.retainTarget(srcTarget);
      callerFdTable.set(newFd, srcTarget);
    }
    this.fdDescriptorFlags.get(callerPid)?.delete(newFd);
    return newFd;
  }

  dupMin(pid: number, fd: number, minFd: number): number {
    if (minFd < 0) throw new Error(`dupMin: invalid min fd ${minFd}`);
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(fd);
    if (!srcTarget) throw new Error(`dupMin: src fd ${fd} not found`);

    let newFd = minFd;
    while (fdTable.has(newFd)) newFd++;

    if (srcTarget.type === "vfs_file") {
      srcTarget.fdTable.dupToShared(srcTarget.fd, newFd);
      fdTable.set(newFd, { ...srcTarget, fd: newFd, refs: 1 });
    } else {
      this.retainTarget(srcTarget);
      fdTable.set(newFd, srcTarget);
    }
    this.fdDescriptorFlags.get(pid)?.delete(newFd);
    const nextFd = this.nextFds.get(pid) ?? KERNEL_FD_BASE;
    if (newFd >= nextFd) this.nextFds.set(pid, newFd + 1);
    return newFd;
  }

  dup2(pid: number, srcFd: number, dstFd: number): void {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) throw new Error(`No fd table for pid ${pid}`);
    const srcTarget = fdTable.get(srcFd);
    if (!srcTarget) throw new Error(`dup2: src fd ${srcFd} not found`);
    // If dst already exists, close it first (decrement pipe refcount)
    const existing = fdTable.get(dstFd);
    if (existing === srcTarget) return;
    if (existing) {
      this.closeTarget(existing);
    }
    if (srcTarget.type === "vfs_file") {
      srcTarget.fdTable.dupToShared(srcTarget.fd, dstFd);
      fdTable.set(dstFd, { ...srcTarget, fd: dstFd, refs: 1 });
    } else {
      this.retainTarget(srcTarget);
      fdTable.set(dstFd, srcTarget);
    }
    this.fdDescriptorFlags.get(pid)?.delete(dstFd);
  }

  closeFd(pid: number, fd: number): boolean {
    const fdTable = this.fdTables.get(pid);
    if (!fdTable) return false;
    const target = fdTable.get(fd);
    if (!target) {
      fdTable.delete(fd);
      return false;
    }
    this.unlockFile(pid, fd);
    this.closeTarget(target);
    fdTable.delete(fd);
    this.fdDescriptorFlags.get(pid)?.delete(fd);
    return true;
  }

  lockFile(pid: number, fd: number, exclusive: boolean): number {
    const path = this.vfsPathForFd(pid, fd);
    if (!path) return 9; // EBADF
    const owner = `${pid}:${fd}`;
    const state = this.fileLocks.get(path) ?? { shared: new Set<string>() };

    if (exclusive) {
      const onlyOwnShared = state.shared.size === 0 ||
        (state.shared.size === 1 && state.shared.has(owner));
      if ((state.exclusive && state.exclusive !== owner) || !onlyOwnShared) {
        return 11; // EWOULDBLOCK
      }
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
    if (!state.exclusive && state.shared.size === 0) {
      this.fileLocks.delete(path);
    }
    return 0;
  }

  /** Reparent all children of `pid` to init (PID 1); auto-reap any that already exited. */
  private _reparentChildren(pid: number): void {
    const kids = this.children.get(pid);
    if (!kids || kids.size === 0) {
      this.children.delete(pid);
      return;
    }
    const initKids = this.children.get(INIT_PID)!;
    for (const childPid of kids) {
      this.parentPids.set(childPid, INIT_PID);
      const child = this.processTable.get(childPid);
      if (child?.state === "exited") {
        // Init auto-reaps already-exited orphans — no zombie accumulation.
        this.processTable.delete(childPid);
        this.fdTables.delete(childPid);
        this.fdDescriptorFlags.delete(childPid);
        this.execPidAliases.delete(childPid);
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
            this.fdDescriptorFlags.delete(childPid);
            this.execPidAliases.delete(childPid);
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
    if (!target || target.type !== "vfs_file") return null;
    return target.fdTable.getPath(target.fd) ?? null;
  }

  private requireVfsFileTarget(
    pid: number,
    fd: number,
  ): FdTarget & { type: "vfs_file" } {
    const target = this.fdTables.get(pid)?.get(fd);
    if (!target || target.type !== "vfs_file") {
      throw new Error(`EBADF: bad file descriptor ${fd}`);
    }
    return target;
  }

  private closeTarget(target: FdTarget): void {
    if (target.type === "tty_master") {
      const { fgPgid } = target.state;
      target.state.masterClosed = true;
      for (const w of target.state.toSlaveWaiters.splice(0)) w();
      // Terminal hangup: deliver SIGHUP to the foreground process group so
      // processes that don't ignore it (everything except nohup'd daemons) exit.
      if (fgPgid > 0) this.killpg(fgPgid, 1);
    }
    if (target.type === "pipe_write") target.pipe.close();
    if (target.type === "pipe_read") target.pipe.close();
    if (target.type === "vfs_file") {
      if (target.fdTable.isOpen(target.fd)) {
        target.fdTable.close(target.fd);
      }
      target.refs = Math.max(0, target.refs - 1);
    }
    if (target.type === "socket") {
      target.refs--;
      if (target.refs <= 0) {
        if (target.listener != null && target.closeListener) {
          // Bridge-backed closeListener is async; fire-and-forget keeps
          // the sync release path sync. Bridge worker tears down its
          // side independently.
          void target.closeListener(target.listener);
          target.listener = null;
        }
        if (target.socket !== null) {
          void target.close(target.socket);
          target.socket = null;
        }
      }
    }
  }

  private retainTarget(target: FdTarget): void {
    if (target.type === "pipe_write") target.pipe.addRef();
    if (target.type === "pipe_read") target.pipe.addRef();
    if (target.type === "vfs_file") {
      target.fdTable.retain(target.fd);
      target.refs++;
    }
    if (target.type === "socket") target.refs++;
  }

  private reapProcess(pid: number): void {
    if (pid === INIT_PID) return;
    this.cleanupFds(pid);
    const parentPid = this.parentPids.get(pid);
    if (parentPid !== undefined) {
      this.children.get(parentPid)?.delete(pid);
    }
    this.processTable.delete(pid);
    this.allocatedPids.delete(pid);
    this.execPidAliases.delete(pid);
    this.fdTables.delete(pid);
    this.fdDescriptorFlags.delete(pid);
    this.nextFds.delete(pid);
    this.parentPids.delete(pid);
    this.children.delete(pid);
  }

  initProcess(pid: number): void {
    if (!this.fdTables.has(pid)) {
      this.fdTables.set(pid, new Map());
      this.fdDescriptorFlags.set(pid, new Map());
      this.nextFds.set(pid, KERNEL_FD_BASE);
    }
  }

  adoptFdTable(pid: number, fdTable: Map<number, FdTarget>): void {
    this.fdTables.set(pid, fdTable);
    if (!this.fdDescriptorFlags.has(pid)) {
      this.fdDescriptorFlags.set(pid, new Map());
    }
    let nextFd = KERNEL_FD_BASE;
    for (const fd of fdTable.keys()) {
      if (fd >= nextFd) nextFd = fd + 1;
    }
    this.nextFds.set(pid, nextFd);
  }

  // ── waitpid(-1) / wait-any ──

  /** Non-blocking: reap the first exited child, or distinguish running children from ECHILD. */
  waitAnyNohang(ppid: number):
    | { state: "exited"; pid: number; exitCode: number }
    | { state: "running" }
    | { state: "none" } {
    return this.waitAnyChildNohang(ppid);
  }

  /** Async: wait for the first child of ppid to exit and reap it.
   *  Returns { pid: -1 } if there are no children. */
  async waitAny(ppid: number): Promise<{ pid: number; exitCode: number }> {
    const result = await this.waitAnyChild(ppid);
    return result ?? { pid: -1, exitCode: -1 };
  }

  async waitAnyChild(
    parentPid: number,
  ): Promise<{ pid: number; exitCode: number } | null> {
    const exited = this.findExitedChildStatus(parentPid);
    if (exited) {
      this.reapProcess(exited.pid);
      return { pid: exited.pid, exitCode: exited.exitCode };
    }

    const running = this.findRunningChildren(parentPid);
    if (running.length === 0) return null;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: { pid: number; exitCode: number } | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      for (const [pid, entry] of running) {
        entry.waiters.push(({ exitCode }) => {
          if (settled) return;
          if (!this.processTable.has(pid)) {
            // Another waiter may have reaped the entry first. The exit event
            // still belongs to this waiter; resolve it instead of hanging.
            settle({ pid, exitCode });
            return;
          }
          this.reapProcess(pid);
          settle({ pid, exitCode });
        });
      }
    });
  }

  async waitAnyChildInterruptible(
    parentPid: number,
    interrupt: Promise<void>,
  ): Promise<
    | { interrupted: true }
    | { interrupted: false; result: { pid: number; exitCode: number } | null }
  > {
    const waited = await this.waitAnyChildStatusInterruptible(
      parentPid,
      interrupt,
    );
    return waited.interrupted ? waited : {
      interrupted: false,
      result: waited.result
        ? { pid: waited.result.pid, exitCode: waited.result.exitCode }
        : null,
    };
  }

  async waitAnyChildStatusInterruptible(
    parentPid: number,
    interrupt: Promise<void>,
  ): Promise<
    | { interrupted: true }
    | {
      interrupted: false;
      result: { pid: number; exitCode: number; signal: number } | null;
    }
  > {
    const exited = this.findExitedChildStatus(parentPid);
    if (exited) {
      this.reapProcess(exited.pid);
      return {
        interrupted: false,
        result: exited,
      };
    }

    const running = this.findRunningChildren(parentPid);
    if (running.length === 0) return { interrupted: false, result: null };

    return new Promise((resolve) => {
      let settled = false;
      const waiters: Array<
        { entry: ProcessEntry; waiter: (status: ProcessExitStatus) => void }
      > = [];
      const settle = (
        result:
          | { interrupted: true }
          | {
            interrupted: false;
            result: { pid: number; exitCode: number; signal: number } | null;
          },
      ) => {
        if (settled) return;
        settled = true;
        for (const { entry, waiter } of waiters) {
          const index = entry.waiters.indexOf(waiter);
          if (index >= 0) entry.waiters.splice(index, 1);
        }
        resolve(result);
      };
      for (const [pid, entry] of running) {
        const waiter = (status: ProcessExitStatus) => {
          if (settled) return;
          if (!this.processTable.has(pid)) {
            settle({ interrupted: false, result: { pid, ...status } });
            return;
          }
          this.reapProcess(pid);
          settle({ interrupted: false, result: { pid, ...status } });
        };
        waiters.push({ entry, waiter });
        entry.waiters.push(waiter);
      }
      interrupt.then(() => settle({ interrupted: true }));
    });
  }

  waitAnyChildNohang(parentPid: number):
    | { state: "exited"; pid: number; exitCode: number }
    | { state: "running" }
    | { state: "none" } {
    const result = this.waitAnyChildStatusNohang(parentPid);
    return result.state === "exited"
      ? { state: "exited", pid: result.pid, exitCode: result.exitCode }
      : result;
  }

  waitAnyChildStatusNohang(parentPid: number):
    | { state: "exited"; pid: number; exitCode: number; signal: number }
    | { state: "running" }
    | { state: "none" } {
    const exited = this.findExitedChildStatus(parentPid);
    if (exited) {
      this.reapProcess(exited.pid);
      return { state: "exited", ...exited };
    }
    return this.findRunningChildren(parentPid).length > 0
      ? { state: "running" }
      : { state: "none" };
  }

  private findExitedChildStatus(
    parentPid: number,
  ): { pid: number; exitCode: number; signal: number } | null {
    for (const [pid, entry] of this.processTable) {
      if (this.parentPids.get(pid) !== parentPid) continue;
      if (entry.state === "exited") return { pid, ...this.statusFor(entry) };
    }
    return null;
  }

  private findRunningChildren(
    parentPid: number,
  ): Array<[number, ProcessEntry]> {
    const result: Array<[number, ProcessEntry]> = [];
    for (const [pid, entry] of this.processTable) {
      if (this.parentPids.get(pid) !== parentPid) continue;
      if (entry.state !== "exited") result.push([pid, entry]);
    }
    return result;
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

  /** Create a TTY pair and wire fds 0/1/2 of pid to the slave side. */
  openTtyForProcess(pid: number): TtyState {
    const { state } = this.createTty();
    const slave = createTtySlaveTarget(state);
    this.setFdTarget(pid, 0, slave);
    this.setFdTarget(pid, 1, slave);
    this.setFdTarget(pid, 2, slave);
    const entry = this.processTable.get(pid);
    if (entry) {
      state.fgPgid = entry.pgid > 0 ? entry.pgid : pid;
    }
    return state;
  }

  /** Mark ttyId as the controlling terminal of pid (called via TIOCSCTTY). */
  setControllingTty(pid: number, ttyId: number): number {
    const entry = this.processTable.get(pid);
    const state = this.ttyTable.get(ttyId);
    if (!entry || entry.state === "exited" || !state) return -1;
    if (entry.sid !== pid) return -1;
    if (entry.controllingTtyId !== null && entry.controllingTtyId !== ttyId) {
      return -1;
    }
    if (state.controllingSid !== null && state.controllingSid !== entry.sid) {
      return -1;
    }

    state.controllingSid = entry.sid;
    entry.controllingTtyId = ttyId;
    state.fgPgid = entry.pgid > 0 ? entry.pgid : pid;
    return 0;
  }

  getControllingTtyState(pid: number): TtyState | null {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === "exited") return null;
    if (entry.controllingTtyId !== null) {
      return this.ttyTable.get(entry.controllingTtyId) ?? null;
    }
    for (const state of this.ttyTable.values()) {
      if (state.controllingSid === entry.sid) return state;
    }
    return null;
  }

  // ── Process groups / sessions ──

  getpgid(pid: number): number {
    return this.processTable.get(pid)?.pgid ?? -1;
  }

  setpgid(pid: number, pgid: number): number {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === "exited" || pgid <= 0) return -1;
    if (entry.sid === pid) return -1;
    if (pgid !== pid) {
      const groupSid = this.findProcessGroupSession(pgid);
      if (groupSid === null || groupSid !== entry.sid) return -1;
    }
    entry.pgid = pgid;
    return 0;
  }

  getsid(pid: number): number {
    return this.processTable.get(pid)?.sid ?? -1;
  }

  setsid(pid: number): number {
    const entry = this.processTable.get(pid);
    if (!entry || entry.state === "exited") return -1;
    if (this.findProcessGroupSession(pid) !== null) return -1;
    entry.sid = pid;
    entry.pgid = pid;
    entry.controllingTtyId = null;
    return pid;
  }

  tcgetpgrp(ttyId: number): number {
    return this.ttyTable.get(ttyId)?.fgPgid ?? -1;
  }

  tcsetpgrp(ttyId: number, pgid: number, callerPid?: number): boolean {
    const state = this.ttyTable.get(ttyId);
    if (!state || pgid <= 0) return false;
    const groupSid = this.findProcessGroupSession(pgid);
    if (groupSid === null) return false;
    if (callerPid !== undefined) {
      const caller = this.processTable.get(callerPid);
      if (!caller || caller.state === "exited" || caller.sid !== groupSid) {
        return false;
      }
      if (state.controllingSid !== caller.sid) return false;
    }
    state.fgPgid = pgid;
    return true;
  }

  killpg(pgid: number, sig: number): number {
    let count = 0;
    for (const entry of this.processTable.values()) {
      if (
        entry.pgid === pgid && entry.state !== "exited" &&
        entry.pid !== INIT_PID
      ) {
        this.killProcess(entry.pid, sig);
        count++;
      }
    }
    return count;
  }

  private findProcessGroupSession(pgid: number): number | null {
    for (const entry of this.processTable.values()) {
      if (entry.state !== "exited" && entry.pgid === pgid) return entry.sid;
    }
    return null;
  }

  dispose(): void {
    for (const fdTable of this.fdTables.values()) {
      for (const target of fdTable.values()) {
        this.closeTarget(target);
      }
    }
    this.fdTables.clear();
    this.fdDescriptorFlags.clear();
    this.processTable.clear();
    this.allocatedPids.clear();
    this.parentPids.clear();
    this.fileLocks.clear();
    this.ttyTable.clear();
  }
}

function rootCredentials(): ProcessCredentials {
  return {
    uid: ROOT_UID,
    gid: ROOT_GID,
    euid: ROOT_UID,
    egid: ROOT_GID,
    suid: ROOT_UID,
    sgid: ROOT_GID,
  };
}

function userCredentials(): ProcessCredentials {
  return {
    uid: USER_UID,
    gid: USER_GID,
    euid: USER_UID,
    egid: USER_GID,
    suid: USER_UID,
    sgid: USER_GID,
  };
}

function normalizeKernelPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

function normalizeKernelCwd(path: string): string {
  const raw = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

function normalizeUmask(mask: number): number {
  return Math.trunc(mask) & 0o777;
}

function normalizeLimit(limit: number | bigint): number {
  if (typeof limit === "bigint") {
    if (limit === RLIM_INFINITY_U64) return Infinity;
    if (limit < 0n) return -1;
    if (limit > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(limit);
  }
  if (!Number.isFinite(limit)) return Infinity;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(limit)));
}

function defaultResourceLimits(): Map<number, ResourceLimit> {
  return new Map([
    [0, { soft: Infinity, hard: Infinity }],
    [1, { soft: Infinity, hard: Infinity }],
    [2, { soft: 64 * 1024 * 1024, hard: 64 * 1024 * 1024 }],
    [3, { soft: 1024 * 1024, hard: 1024 * 1024 }],
    [4, { soft: 0, hard: 0 }],
    [5, { soft: 64 * 1024 * 1024, hard: 64 * 1024 * 1024 }],
    [6, { soft: 1024, hard: 1024 }],
    [RLIMIT_NOFILE, { soft: 1024, hard: 1024 }],
  ]);
}

function cloneResourceLimits(
  limits: Map<number, ResourceLimit>,
): Map<number, ResourceLimit> {
  const cloned = new Map<number, ResourceLimit>();
  for (const [resource, limit] of limits) {
    cloned.set(resource, { ...limit });
  }
  return cloned;
}
