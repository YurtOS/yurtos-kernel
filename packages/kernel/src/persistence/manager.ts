/**
 * PersistenceManager — debounced autosave orchestration.
 *
 * Hooks into VFS onChange to schedule saves, and provides
 * explicit save/load/clear methods for session-mode usage.
 */

import type { PersistenceBackend } from './backend.js';
import type { VfsLike } from '../vfs/vfs-like.js';
import { exportState, importState } from './serializer.js';

export interface PersistenceManagerOptions {
  /** Debounce interval in ms. Default 1000. */
  autosaveMs?: number;
  /** Namespace for storage isolation. Default 'default'. */
  namespace?: string;
}

export class PersistenceManager {
  private backend: PersistenceBackend;
  private vfs: VfsLike;
  private namespace: string;
  private autosaveMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private pendingSave = false;
  private disposed = false;
  private getEnv: () => Map<string, string>;
  private setEnv: (env: Map<string, string>) => void;

  constructor(
    backend: PersistenceBackend,
    vfs: VfsLike,
    options: PersistenceManagerOptions | undefined,
    getEnv: () => Map<string, string>,
    setEnv: (env: Map<string, string>) => void,
  ) {
    this.backend = backend;
    this.vfs = vfs;
    this.namespace = options?.namespace ?? 'default';
    this.autosaveMs = options?.autosaveMs ?? 1000;
    this.getEnv = getEnv;
    this.setEnv = setEnv;
  }

  /** Hook VFS onChange to schedule debounced saves. */
  startAutosave(vfs: { setOnChange(cb: (() => void) | null): void }): void {
    vfs.setOnChange(() => this.scheduleSave());
  }

  /** Schedule a debounced save. Resets the timer on each call. */
  private scheduleSave(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save().catch(err => {
        console.warn('[yurt] autosave failed:', err);
      });
    }, this.autosaveMs);
  }

  /** Save current state to the backend. Serialization-guarded: if a save is in flight, queues one more. */
  async save(): Promise<void> {
    if (this.disposed) return;
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    this.saving = true;
    try {
      const data = exportState(this.vfs, this.getEnv());
      await this.backend.save(this.namespace, data);
    } catch (err) {
      console.warn('[yurt] save failed:', err);
    } finally {
      this.saving = false;
    }
    // Flush queued save
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  /** Load state from backend into VFS. Returns true if state was restored. */
  async load(): Promise<boolean> {
    try {
      const data = await this.backend.load(this.namespace);
      if (!data) return false;
      const { env } = importState(this.vfs, data);
      if (env) {
        this.setEnv(env);
      }
      return true;
    } catch (err) {
      console.warn('[yurt] load failed:', err);
      return false;
    }
  }

  /** Delete persisted state for this namespace. */
  async clear(): Promise<void> {
    try {
      await this.backend.delete(this.namespace);
    } catch (err) {
      console.warn('[yurt] clear failed:', err);
    }
  }

  /** Stop autosave, flush any pending save, remove onChange hook. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    let hadTimer = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      hadTimer = true;
    }
    // Flush pending save (timer was active, or save was queued/in-flight)
    if (hadTimer || this.pendingSave || this.saving) {
      this.pendingSave = false;
      try {
        const data = exportState(this.vfs, this.getEnv());
        await this.backend.save(this.namespace, data);
      } catch (err) {
        console.warn('[yurt] dispose flush failed:', err);
      }
    }
  }
}
