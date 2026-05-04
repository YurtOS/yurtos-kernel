/**
 * Abstract persistence backend for storing/loading sandbox state.
 */
export interface PersistenceBackend {
  /** Load persisted state for the given namespace. Returns null if nothing stored. */
  load(namespace: string): Promise<Uint8Array | null>;
  /** Save state blob under the given namespace. */
  save(namespace: string, data: Uint8Array): Promise<void>;
  /** Delete persisted state for the given namespace. */
  delete(namespace: string): Promise<void>;
}

/**
 * In-memory backend for testing. Stores data in a Map.
 */
export class MemoryBackend implements PersistenceBackend {
  private store = new Map<string, Uint8Array>();

  async load(namespace: string): Promise<Uint8Array | null> {
    return this.store.get(namespace) ?? null;
  }

  async save(namespace: string, data: Uint8Array): Promise<void> {
    this.store.set(namespace, data);
  }

  async delete(namespace: string): Promise<void> {
    this.store.delete(namespace);
  }
}
