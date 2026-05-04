/**
 * Node.js filesystem-backed persistence backend.
 *
 * State files are stored under `~/.yurt/persistence/<namespace>.wsnd`.
 * Namespace is sanitized to [a-zA-Z0-9_-] characters only.
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PersistenceBackend } from './backend.js';

const DEFAULT_DIR = join(homedir(), '.yurt', 'persistence');

/** Sanitize namespace to safe filesystem characters. */
function sanitize(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class FsBackend implements PersistenceBackend {
  private dir: string;
  private dirCreated = false;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
  }

  private filePath(namespace: string): string {
    return join(this.dir, `${sanitize(namespace)}.wsnd`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;
    await mkdir(this.dir, { recursive: true });
    this.dirCreated = true;
  }

  async load(namespace: string): Promise<Uint8Array | null> {
    try {
      const data = await readFile(this.filePath(namespace));
      return new Uint8Array(data);
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  async save(namespace: string, data: Uint8Array): Promise<void> {
    await this.ensureDir();
    await writeFile(this.filePath(namespace), data);
  }

  async delete(namespace: string): Promise<void> {
    try {
      await unlink(this.filePath(namespace));
    } catch (e: any) {
      if (e?.code === 'ENOENT') return;
      throw e;
    }
  }
}
