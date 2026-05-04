/// <reference lib="dom" />

/**
 * IndexedDB-backed persistence backend for browser environments.
 *
 * Each namespace gets its own database: `yurt_<namespace>`.
 * State is stored in an `state` object store under the key `vfs_state`.
 */

import type { PersistenceBackend } from './backend.js';

const STORE_NAME = 'state';
const KEY = 'vfs_state';

function dbName(namespace: string): string {
  return `yurt_${namespace}`;
}

function openDb(namespace: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(namespace), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IdbBackend implements PersistenceBackend {
  async load(namespace: string): Promise<Uint8Array | null> {
    try {
      const db = await openDb(namespace);
      try {
        return await new Promise<Uint8Array | null>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(KEY);
          req.onsuccess = () => {
            const result = req.result;
            if (result instanceof Uint8Array) {
              resolve(result);
            } else if (result instanceof ArrayBuffer) {
              resolve(new Uint8Array(result));
            } else {
              resolve(null);
            }
          };
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    } catch {
      // Graceful degradation: return null if IDB is unavailable or errors
      return null;
    }
  }

  async save(namespace: string, data: Uint8Array): Promise<void> {
    const db = await openDb(namespace);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(data, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  async delete(namespace: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName(namespace));
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch {
      // Graceful degradation
    }
  }
}
