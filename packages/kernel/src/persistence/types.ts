/**
 * Types for VFS state persistence (export/import).
 */

import type { PersistenceBackend } from './backend.js';

/** Serialized representation of the VFS + env state. */
export interface SerializedState {
  version: number;
  files: Array<{ path: string; data: string; type: 'file' | 'dir'; permissions?: number }>;
  env?: [string, string][];
}

/** Configuration for sandbox persistence behaviour. */
export interface PersistenceOptions {
  mode: 'ephemeral' | 'session' | 'persistent';
  namespace?: string;
  autosaveMs?: number;
  /** Explicit backend. Auto-detected if not provided (IndexedDB in browser, filesystem in Node). */
  backend?: PersistenceBackend;
}
