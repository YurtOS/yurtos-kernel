import {
  type DirEntry,
  type FsCredential,
  type StatResult,
  VfsError,
} from "./inode.js";
import type { ProcessInfo } from "./proc-provider.js";
import type { MountEntry, VirtualProvider } from "./provider.js";
import type { RootProvider } from "./root-provider.js";
import { rootStatToVfsStat } from "./root-provider.js";
import type { VfsLike } from "./vfs-like.js";

export interface OverlayVFSOptions {
  base: RootProvider;
  upper: VfsLike;
  credential?: FsCredential;
}

export interface OverlayState {
  baseId: string;
  whiteouts: string[];
}

type RenameDestinationBackup =
  | { kind: "none" }
  | { kind: "base"; path: string; hadWhiteout: boolean }
  | {
    kind: "upper";
    path: string;
    backupPath: string;
    stat: StatResult;
    hadWhiteout: boolean;
  };

function normalizeOverlayPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new VfsError("ENOENT", `not absolute: ${path}`);
  }
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) {
        throw new VfsError("ENOENT", `traversal blocked: ${path}`);
      }
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

function parentPath(path: string): string {
  path = normalizeOverlayPath(path);
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function basename(path: string): string {
  path = normalizeOverlayPath(path);
  return path.slice(path.lastIndexOf("/") + 1);
}

function ancestorPaths(path: string): string[] {
  path = normalizeOverlayPath(path);
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    out.push(current);
  }
  return out;
}

function isEnoent(error: unknown): boolean {
  return (error instanceof VfsError && error.errno === "ENOENT") ||
    (typeof error === "object" && error !== null &&
      (error as { code?: unknown }).code === "ENOENT");
}

function isEexist(error: unknown): boolean {
  return error instanceof VfsError && error.errno === "EEXIST";
}

function randomRenameId(): string {
  return crypto.randomUUID();
}

function canWrite(stat: StatResult, credential: FsCredential): boolean {
  if (credential.uid === 0) return true;
  if (credential.uid === stat.uid) return (stat.permissions & 0o200) !== 0;
  if (credential.gid === stat.gid || credential.groups?.includes(stat.gid)) {
    return (stat.permissions & 0o020) !== 0;
  }
  return (stat.permissions & 0o002) !== 0;
}

export class OverlayVFS implements VfsLike {
  private readonly whiteouts = new Set<string>();
  private readonly overlaySnapshots = new Map<string, string[]>();
  private credential: FsCredential;
  private onChange: (() => void) | null = null;
  private notificationDepth = 0;
  private privileged = false;

  constructor(private readonly options: OverlayVFSOptions) {
    this.credential = options.credential ?? { uid: 1000, gid: 1000 };
  }

  exportOverlayState(): OverlayState {
    return {
      baseId: this.options.base.id,
      whiteouts: Array.from(this.whiteouts).sort(),
    };
  }

  exportUpperVfs(): VfsLike {
    return this.options.upper;
  }

  importOverlayState(state: OverlayState): void {
    if (state.baseId !== this.options.base.id) {
      throw new Error(
        `base id mismatch: expected ${this.options.base.id}, got ${state.baseId}`,
      );
    }
    this.whiteouts.clear();
    for (const path of state.whiteouts) {
      this.whiteouts.add(normalizeOverlayPath(path));
    }
  }

  readFile(path: string): Uint8Array {
    path = normalizeOverlayPath(path);
    try {
      return this.options.upper.readFile(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.assertNotHiddenByWhiteout(path);
      return this.options.base.readFile(path);
    }
  }

  writeFile(path: string, data: Uint8Array, mode = 0o644): void {
    path = normalizeOverlayPath(path);
    const wasWhiteouted = this.whiteouts.has(path);
    if (!this.privileged) this.assertCanWritePath(path, wasWhiteouted);
    const createsUpperEntry = !this.upperEntryExists(path);
    let shouldCopyUpMetadata = false;
    if (!wasWhiteouted) {
      try {
        this.options.upper.lstat(path);
      } catch (e) {
        if (!isEnoent(e)) throw e;
        try {
          const baseStat = this.options.base.lstat(path);
          shouldCopyUpMetadata = baseStat.type === "file";
        } catch (baseErr) {
          if (!isEnoent(baseErr)) throw baseErr;
        }
      }
    }
    if (shouldCopyUpMetadata) {
      this.copyUpMetadataOnly(path);
    }
    this.ensureUpperParentDirectory(path);
    const writeUpper = () => {
      this.options.upper.writeFile(path, data, mode);
      if (createsUpperEntry && !this.privileged && this.options.upper.chown) {
        this.options.upper.chown(
          path,
          this.credential.uid,
          this.credential.gid,
        );
      }
    };
    if (this.privileged) {
      this.options.upper.withWriteAccess(writeUpper);
    } else {
      this.withUpperCredential(writeUpper);
    }
    this.whiteouts.delete(path);
    this.notifyChange();
  }

  stat(path: string): StatResult {
    path = normalizeOverlayPath(path);
    try {
      return this.options.upper.stat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.assertNotHiddenByWhiteout(path);
      return rootStatToVfsStat(this.options.base.stat(path));
    }
  }

  lstat(path: string): StatResult {
    path = normalizeOverlayPath(path);
    try {
      return this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.assertNotHiddenByWhiteout(path);
      return rootStatToVfsStat(this.options.base.lstat(path));
    }
  }

  readdir(path: string): DirEntry[] {
    path = normalizeOverlayPath(path);
    let upperEntries: DirEntry[] | null = null;
    try {
      upperEntries = this.options.upper.readdir(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (this.hasWhiteoutedSelfOrAncestor(path)) {
      if (upperEntries) return upperEntries;
      throw new VfsError("ENOENT", `whiteout: ${this.coveringWhiteout(path)}`);
    }
    const entries = new Map<string, DirEntry>();
    let baseFound = false;
    try {
      for (const entry of this.options.base.readdir(path)) {
        entries.set(entry.name, entry);
      }
      baseFound = true;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    for (const whiteout of this.whiteouts) {
      if (parentPath(whiteout) === path) entries.delete(basename(whiteout));
    }
    if (upperEntries) {
      for (const entry of upperEntries) entries.set(entry.name, entry);
    } else {
      if (!baseFound) {
        throw new VfsError("ENOENT", `no such directory: ${path}`);
      }
    }
    return Array.from(entries.values());
  }

  mkdir(path: string): void {
    path = normalizeOverlayPath(path);
    const wasWhiteouted = this.whiteouts.has(path);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
    this.assertNoMergedEntry(path, wasWhiteouted);
    this.ensureUpperParentDirectory(path);
    this.options.upper.withWriteAccess(() => {
      this.options.upper.mkdir(path);
      if (!this.privileged && this.options.upper.chown) {
        this.options.upper.chown(
          path,
          this.credential.uid,
          this.credential.gid,
        );
      }
    });
    this.notifyChange();
  }

  mkdirp(path: string): void {
    path = normalizeOverlayPath(path);
    let changed = false;
    for (const dir of ancestorPaths(path)) {
      const existing = this.lookupMerged(dir);
      if (existing) {
        if (existing.type !== "dir") {
          throw new VfsError("ENOTDIR", `not a directory: ${dir}`);
        }
        continue;
      }
      const wasWhiteouted = this.whiteouts.has(dir);
      if (!this.privileged) this.assertCanMutateDirectoryEntry(dir);
      this.assertNoMergedEntry(dir, wasWhiteouted);
      this.ensureUpperParentDirectory(dir);
      try {
        this.options.upper.mkdir(dir);
        changed = true;
      } catch (e) {
        if (!isEexist(e)) throw e;
      }
    }
    if (changed) this.notifyChange();
  }

  unlink(path: string): void {
    path = normalizeOverlayPath(path);
    try {
      const st = this.options.upper.lstat(path);
      if (st.type === "dir") {
        throw new VfsError("EISDIR", `is a directory: ${path}`);
      }
      if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
      this.withUpperCredential(() => this.options.upper.unlink(path));
    } catch (e) {
      if (!isEnoent(e)) throw e;
      const st = this.options.base.lstat(path);
      if (st.type === "dir") {
        throw new VfsError("EISDIR", `is a directory: ${path}`);
      }
      if (!this.privileged) this.assertCanMutateBaseDirectoryEntry(path);
    }
    this.whiteouts.add(path);
    this.notifyChange();
  }

  rmdir(path: string): void {
    path = normalizeOverlayPath(path);
    if (this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
    try {
      const st = this.options.upper.lstat(path);
      if (st.type !== "dir") {
        throw new VfsError("ENOTDIR", `not a directory: ${path}`);
      }
      if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
      this.options.upper.withWriteAccess(() => {
        this.options.upper.rmdir(path);
      });
    } catch (e) {
      if (!isEnoent(e)) throw e;
      const st = this.options.base.lstat(path);
      if (st.type !== "dir") {
        throw new VfsError("ENOTDIR", `not a directory: ${path}`);
      }
      if (!this.privileged) this.assertCanMutateBaseDirectoryEntry(path);
    }
    this.whiteouts.add(path);
    this.notifyChange();
  }

  rename(oldPath: string, newPath: string): void {
    oldPath = normalizeOverlayPath(oldPath);
    newPath = normalizeOverlayPath(newPath);
    const st = this.lookupMerged(oldPath);
    if (!st) throw new VfsError("ENOENT", `no such file: ${oldPath}`);
    if (oldPath === newPath) return;
    const destination = this.lookupMerged(newPath);
    if (!this.privileged) {
      this.assertCanMutateDirectoryEntry(oldPath);
      this.assertCanMutateDirectoryEntry(newPath);
    }
    this.assertRenameReplacementAllowed(st, destination, newPath);
    this.assertRenameSourceCopyable(oldPath, st);
    this.assertCanRemoveSourceEntry(oldPath, st);

    this.withSuppressedNotifications(() => {
      const destinationWhiteoutBefore = this.whiteouts.has(newPath);
      const tempPath = this.renameTempPath(newPath);
      try {
        this.copyUpAny(oldPath, tempPath, st);
      } catch (e) {
        if (destinationWhiteoutBefore) this.whiteouts.add(newPath);
        throw e;
      }

      let destinationBackup: RenameDestinationBackup = { kind: "none" };
      try {
        destinationBackup = this.stageDestinationForRename(
          newPath,
          destination,
          destinationWhiteoutBefore,
        );
        this.moveUpperTempIntoPlace(tempPath, newPath);
      } catch (e) {
        this.removeUpperTemp(tempPath, st);
        this.restoreDestinationAfterFailedRename(newPath, destinationBackup);
        throw e;
      }

      try {
        this.removeSourceEntry(oldPath, st);
      } catch (e) {
        this.restoreDestinationAfterFailedRename(newPath, destinationBackup);
        throw e;
      }

      this.discardRenameDestinationBackup(destinationBackup);
      this.whiteouts.delete(newPath);
    });
    this.notifyChange();
  }

  symlink(target: string, path: string): void {
    path = normalizeOverlayPath(path);
    const wasWhiteouted = this.whiteouts.has(path);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
    this.assertNoMergedEntry(path, wasWhiteouted);
    this.ensureUpperParentDirectory(path);
    this.options.upper.withWriteAccess(() => {
      this.options.upper.symlink(target, path);
      if (!this.privileged && this.options.upper.chown) {
        this.options.upper.chown(
          path,
          this.credential.uid,
          this.credential.gid,
          false,
        );
      }
    });
    this.whiteouts.delete(path);
    this.notifyChange();
  }

  link(oldPath: string, newPath: string): void {
    if (!this.options.upper.link) {
      throw new VfsError("EACCES", "hard link unsupported on overlay upper");
    }
    oldPath = normalizeOverlayPath(oldPath);
    newPath = normalizeOverlayPath(newPath);
    this.assertNoWhiteoutedAncestor(oldPath);
    const source = this.lookupMerged(oldPath);
    if (!source) throw new VfsError("ENOENT", `no such file: ${oldPath}`);
    if (source.type === "dir") {
      throw new VfsError(
        "EACCES",
        `hard link not allowed for directory: ${oldPath}`,
      );
    }
    const wasWhiteouted = this.whiteouts.has(newPath);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(newPath);
    this.assertNoMergedEntry(newPath, wasWhiteouted);
    try {
      this.options.upper.lstat(oldPath);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.copyUpAny(oldPath, oldPath, source);
    }
    this.ensureUpperParentDirectory(newPath);
    this.withUpperCredential(() => this.options.upper.link!(oldPath, newPath));
    this.whiteouts.delete(newPath);
    this.notifyChange();
  }

  readlink(path: string): string {
    path = normalizeOverlayPath(path);
    try {
      return this.options.upper.readlink(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.assertNotHiddenByWhiteout(path);
      return this.options.base.readlink(path);
    }
  }

  chmod(path: string, mode: number): void {
    path = normalizeOverlayPath(path);
    try {
      if (!this.privileged) this.assertCanChmodPath(path);
      this.withUpperCredential(() => this.options.upper.chmod(path, mode));
    } catch (e) {
      if (!isEnoent(e)) throw e;
      if (!this.privileged) this.assertCanChmodPath(path);
      this.copyUpMetadataOnly(path);
      this.withUpperCredential(() => this.options.upper.chmod(path, mode));
    }
    this.notifyChange();
  }

  chown(path: string, uid: number, gid: number, followSymlinks = true): void {
    path = normalizeOverlayPath(path);
    if (!this.options.upper.chown) {
      throw new VfsError("EACCES", "chown unsupported on overlay upper");
    }
    if (!this.privileged && this.credential.uid !== 0) {
      throw new VfsError("EACCES", `permission denied: ${path}`);
    }
    try {
      this.withUpperCredential(() =>
        this.options.upper.chown!(path, uid, gid, followSymlinks)
      );
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.copyUpMetadataOnly(path);
      this.withUpperCredential(() =>
        this.options.upper.chown!(path, uid, gid, followSymlinks)
      );
    }
    this.notifyChange();
  }

  setTimes(
    path: string,
    atime?: Date,
    mtime?: Date,
    followSymlinks = true,
  ): void {
    path = normalizeOverlayPath(path);
    if (!this.privileged) this.assertCanWritePath(path);
    try {
      this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      this.assertNotHiddenByWhiteout(path);
      this.copyUpMetadataOnly(path);
    }
    const setUpperTimes = () => {
      if (!this.options.upper.setTimes) {
        throw new VfsError("EROFS", `timestamps are read-only: ${path}`);
      }
      this.options.upper.setTimes(path, atime, mtime, followSymlinks);
    };
    if (this.privileged) {
      this.options.upper.withWriteAccess(setUpperTimes);
    } else {
      this.withUpperCredential(setUpperTimes);
    }
    this.notifyChange();
  }

  withCredential<T>(credential: FsCredential, fn: () => T): T {
    const previous = this.credential;
    this.credential = credential;
    try {
      const upper = this.options.upper as VfsLike & {
        withCredential?: <U>(credential: FsCredential, inner: () => U) => U;
      };
      return upper.withCredential ? upper.withCredential(credential, fn) : fn();
    } finally {
      this.credential = previous;
    }
  }

  withWriteAccess(fn: () => void): void {
    const previous = this.privileged;
    this.privileged = true;
    try {
      this.options.upper.withWriteAccess(fn);
    } finally {
      this.privileged = previous;
    }
  }

  cowClone(): OverlayVFS {
    const upper = this.options.upper as VfsLike & { cowClone?: () => VfsLike };
    if (!upper.cowClone) {
      throw new Error("OverlayVFS upper layer does not support cowClone()");
    }
    const clone = new OverlayVFS({
      base: this.options.base,
      upper: upper.cowClone(),
      credential: this.credential,
    });
    clone.importOverlayState(this.exportOverlayState());
    return clone;
  }

  snapshot(): string {
    const upper = this.options.upper as VfsLike & { snapshot?: () => string };
    if (!upper.snapshot) {
      throw new Error("OverlayVFS upper layer does not support snapshot()");
    }
    const id = upper.snapshot();
    this.overlaySnapshots.set(id, Array.from(this.whiteouts));
    return id;
  }

  restore(id: string): void {
    const upper = this.options.upper as VfsLike & {
      restore?: (id: string) => void;
    };
    if (!upper.restore) {
      throw new Error("OverlayVFS upper layer does not support restore()");
    }
    upper.restore(id);
    this.whiteouts.clear();
    for (const path of this.overlaySnapshots.get(id) ?? []) {
      this.whiteouts.add(path);
    }
    this.notifyChange();
  }

  getProviderPaths(): string[] {
    const upper = this.options.upper as VfsLike & {
      getProviderPaths?: () => string[];
    };
    return upper.getProviderPaths?.() ?? [];
  }

  mount(mountPath: string, provider: VirtualProvider): void {
    if (!this.options.upper.mount) {
      throw new Error("OverlayVFS upper layer does not support mount()");
    }
    this.options.upper.mount(mountPath, provider);
    this.notifyChange();
  }

  getMountList(): MountEntry[] {
    return this.options.upper.getMountList?.() ?? [];
  }

  setProcessListProvider(fn: (() => ProcessInfo[]) | null): void {
    this.options.upper.setProcessListProvider?.(fn);
  }

  clearFileContents(): void {
    const upper = this.options.upper as VfsLike & {
      clearFileContents?: () => void;
    };
    if (!upper.clearFileContents) {
      throw new Error(
        "OverlayVFS upper layer does not support clearFileContents()",
      );
    }
    upper.clearFileContents();
  }

  setOnChange(cb: (() => void) | null): void {
    this.onChange = cb;
  }

  private notifyChange(): void {
    if (!this.privileged && this.notificationDepth === 0) this.onChange?.();
  }

  private withSuppressedNotifications(fn: () => void): void {
    this.notificationDepth++;
    try {
      fn();
    } finally {
      this.notificationDepth--;
    }
  }

  private withUpperCredential<T>(fn: () => T): T {
    const upper = this.options.upper as VfsLike & {
      withCredential?: <U>(credential: FsCredential, inner: () => U) => U;
    };
    return upper.withCredential
      ? upper.withCredential(this.credential, fn)
      : fn();
  }

  private copyUpMetadataOnly(path: string): void {
    path = normalizeOverlayPath(path);
    const st = rootStatToVfsStat(this.options.base.lstat(path));
    this.ensureUpperParentDirectory(path);
    try {
      this.options.upper.withWriteAccess(() => {
        if (st.type === "dir") {
          this.options.upper.mkdir(path);
        } else if (st.type === "symlink") {
          this.options.upper.symlink(this.options.base.readlink(path), path);
        } else {
          this.options.upper.writeFile(path, this.options.base.readFile(path));
        }
        if (st.type !== "symlink") {
          if (this.options.upper.chown) {
            this.options.upper.chown(path, st.uid, st.gid);
          }
          this.options.upper.chmod(path, st.permissions);
        }
      });
    } catch (e) {
      this.removeUpperTemp(path, st);
      throw e;
    }
  }

  private copyUpAny(oldPath: string, newPath: string, st: StatResult): void {
    oldPath = normalizeOverlayPath(oldPath);
    newPath = normalizeOverlayPath(newPath);
    this.ensureUpperParentDirectory(newPath);
    try {
      this.options.upper.withWriteAccess(() => {
        if (st.type === "dir") {
          this.options.upper.mkdir(newPath);
        } else if (st.type === "symlink") {
          this.options.upper.symlink(this.readlink(oldPath), newPath);
        } else {
          this.options.upper.writeFile(newPath, this.readFile(oldPath));
        }
        if (st.type !== "symlink") {
          if (this.options.upper.chown) {
            this.options.upper.chown(newPath, st.uid, st.gid);
          }
          this.options.upper.chmod(newPath, st.permissions);
        }
      });
    } catch (e) {
      this.removeUpperTemp(newPath, st);
      throw e;
    }
  }

  private renameTempPath(newPath: string): string {
    return `${parentPath(newPath)}/.yurt-rename-${randomRenameId()}`;
  }

  private moveUpperTempIntoPlace(tempPath: string, newPath: string): void {
    this.options.upper.withWriteAccess(() => {
      this.options.upper.rename(tempPath, newPath);
    });
  }

  private removeUpperTemp(tempPath: string, st: StatResult): void {
    try {
      if (st.type === "dir") this.options.upper.rmdir(tempPath);
      else this.options.upper.unlink(tempPath);
    } catch {
      // Best-effort cleanup; callers preserve destination state separately.
    }
  }

  private removeSourceEntry(path: string, st: StatResult): void {
    path = normalizeOverlayPath(path);
    if (st.type === "dir") this.rmdir(path);
    else this.unlink(path);
  }

  private assertCanRemoveSourceEntry(path: string, st: StatResult): void {
    path = normalizeOverlayPath(path);
    if (!this.privileged) this.assertCanMutateDirectoryEntry(path);
    if (st.type === "dir" && this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
  }

  private assertRenameReplacementAllowed(
    source: StatResult,
    destination: StatResult | null,
    path: string,
  ): void {
    path = normalizeOverlayPath(path);
    if (!destination) return;
    if (source.type === "dir" && destination.type !== "dir") {
      throw new VfsError("ENOTDIR", `not a directory: ${path}`);
    }
    if (source.type !== "dir" && destination.type === "dir") {
      throw new VfsError("EISDIR", `is a directory: ${path}`);
    }
    if (destination.type === "dir" && this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
  }

  private assertRenameSourceCopyable(path: string, source: StatResult): void {
    path = normalizeOverlayPath(path);
    if (source.type === "dir" && this.readdir(path).length > 0) {
      throw new VfsError("ENOTEMPTY", `directory not empty: ${path}`);
    }
  }

  private stageDestinationForRename(
    path: string,
    destination: StatResult | null,
    hadWhiteout: boolean,
  ): RenameDestinationBackup {
    path = normalizeOverlayPath(path);
    if (!destination) return { kind: "none" };

    try {
      const upperStat = this.options.upper.lstat(path);
      const backupPath = this.renameTempPath(path);
      this.options.upper.withWriteAccess(() => {
        this.options.upper.rename(path, backupPath);
      });
      return { kind: "upper", path, backupPath, stat: upperStat, hadWhiteout };
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    this.whiteouts.add(path);
    return { kind: "base", path, hadWhiteout };
  }

  private restoreDestinationAfterFailedRename(
    path: string,
    backup: RenameDestinationBackup,
  ): void {
    path = normalizeOverlayPath(path);
    try {
      const current = this.options.upper.lstat(path);
      this.removeUpperTemp(path, current);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    if (backup.kind === "upper") {
      this.options.upper.withWriteAccess(() => {
        this.options.upper.rename(backup.backupPath, backup.path);
      });
      if (backup.hadWhiteout) this.whiteouts.add(backup.path);
      else this.whiteouts.delete(backup.path);
    } else if (backup.kind === "base") {
      if (backup.hadWhiteout) this.whiteouts.add(backup.path);
      else this.whiteouts.delete(backup.path);
    }
  }

  private discardRenameDestinationBackup(
    backup: RenameDestinationBackup,
  ): void {
    if (backup.kind !== "upper") return;
    this.removeUpperTemp(backup.backupPath, backup.stat);
  }

  private assertCanWritePath(path: string, allowBaseWhiteout = false): void {
    path = normalizeOverlayPath(path);
    this.assertNoWhiteoutedAncestor(path);
    try {
      const st = this.options.upper.lstat(path);
      if (!canWrite(st, this.credential)) {
        throw new VfsError("EACCES", `permission denied: ${path}`);
      }
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    if (!allowBaseWhiteout) {
      try {
        const st = rootStatToVfsStat(this.options.base.lstat(path));
        if (!canWrite(st, this.credential)) {
          throw new VfsError("EACCES", `permission denied: ${path}`);
        }
        return;
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }

    try {
      const parent = this.options.upper.stat(parentPath(path));
      if (!canWrite(parent, this.credential)) {
        throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
      }
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    const parent = rootStatToVfsStat(this.options.base.stat(parentPath(path)));
    if (!canWrite(parent, this.credential)) {
      throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
    }
  }

  private assertCanMutateDirectoryEntry(path: string): void {
    path = normalizeOverlayPath(path);
    this.assertNoWhiteoutedAncestor(path);
    try {
      const parent = this.options.upper.stat(parentPath(path));
      if (!canWrite(parent, this.credential)) {
        throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
      }
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    const parent = rootStatToVfsStat(this.options.base.stat(parentPath(path)));
    if (!canWrite(parent, this.credential)) {
      throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
    }
  }

  private assertCanMutateBaseDirectoryEntry(path: string): void {
    path = normalizeOverlayPath(path);
    this.assertNoWhiteoutedAncestor(path);
    const parent = rootStatToVfsStat(this.options.base.stat(parentPath(path)));
    if (!canWrite(parent, this.credential)) {
      throw new VfsError("EACCES", `permission denied: ${parentPath(path)}`);
    }
  }

  private assertCanChmodPath(path: string): void {
    path = normalizeOverlayPath(path);
    let st: StatResult;
    try {
      st = this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
      st = rootStatToVfsStat(this.options.base.lstat(path));
    }
    if (this.credential.uid !== 0 && this.credential.uid !== st.uid) {
      throw new VfsError("EACCES", `permission denied: ${path}`);
    }
  }

  private lookupMerged(path: string): StatResult | null {
    path = normalizeOverlayPath(path);
    try {
      return this.options.upper.lstat(path);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (this.hasWhiteoutedSelfOrAncestor(path)) return null;
    try {
      return rootStatToVfsStat(this.options.base.lstat(path));
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return null;
    }
  }

  private upperEntryExists(path: string): boolean {
    path = normalizeOverlayPath(path);
    try {
      this.options.upper.lstat(path);
      return true;
    } catch (e) {
      if (!isEnoent(e)) throw e;
      return false;
    }
  }

  private assertNoMergedEntry(path: string, allowBaseWhiteout = false): void {
    path = normalizeOverlayPath(path);
    try {
      this.options.upper.lstat(path);
      throw new VfsError("EEXIST", `file exists: ${path}`);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
    if (this.hasWhiteoutedSelfOrAncestor(path)) return;
    if (!allowBaseWhiteout) {
      try {
        this.options.base.lstat(path);
        throw new VfsError("EEXIST", `file exists: ${path}`);
      } catch (e) {
        if (!isEnoent(e)) throw e;
      }
    }
  }

  private ensureUpperParentDirectory(path: string): void {
    path = normalizeOverlayPath(path);
    const parent = parentPath(path);
    if (parent === "/") return;
    try {
      const st = this.options.upper.stat(parent);
      if (st.type !== "dir") {
        throw new VfsError("ENOTDIR", `not a directory: ${parent}`);
      }
      return;
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }

    this.options.upper.withWriteAccess(() => {
      for (const dir of ancestorPaths(parent)) {
        try {
          const existing = this.options.upper.stat(dir);
          if (existing.type !== "dir") {
            throw new VfsError("ENOTDIR", `not a directory: ${dir}`);
          }
          continue;
        } catch (e) {
          if (!isEnoent(e)) throw e;
        }
        if (this.hasWhiteoutedSelfOrAncestor(dir)) {
          this.options.upper.mkdir(dir);
          if (this.options.upper.chown) {
            this.options.upper.chown(
              dir,
              this.credential.uid,
              this.credential.gid,
            );
          }
          this.options.upper.chmod(dir, 0o755);
          continue;
        }
        const st = rootStatToVfsStat(this.options.base.stat(dir));
        if (st.type !== "dir") {
          throw new VfsError("ENOTDIR", `not a directory: ${dir}`);
        }
        this.options.upper.mkdir(dir);
        if (this.options.upper.chown) {
          this.options.upper.chown(dir, st.uid, st.gid);
        }
        this.options.upper.chmod(dir, st.permissions);
      }
    });
  }

  private assertNoWhiteoutedAncestor(path: string): void {
    path = normalizeOverlayPath(path);
    for (const ancestor of ancestorPaths(parentPath(path))) {
      if (this.whiteouts.has(ancestor)) {
        try {
          const st = this.options.upper.lstat(ancestor);
          if (st.type === "dir") continue;
        } catch (e) {
          if (!isEnoent(e)) throw e;
        }
        throw new VfsError("ENOENT", `whiteout ancestor: ${ancestor}`);
      }
    }
  }

  private coveringWhiteout(path: string): string | null {
    path = normalizeOverlayPath(path);
    if (this.whiteouts.has(path)) return path;
    for (const ancestor of ancestorPaths(parentPath(path)).reverse()) {
      if (this.whiteouts.has(ancestor)) return ancestor;
    }
    return null;
  }

  private hasWhiteoutedSelfOrAncestor(path: string): boolean {
    return this.coveringWhiteout(path) !== null;
  }

  private assertNotHiddenByWhiteout(path: string): void {
    const whiteout = this.coveringWhiteout(path);
    if (whiteout) throw new VfsError("ENOENT", `whiteout: ${whiteout}`);
  }
}
