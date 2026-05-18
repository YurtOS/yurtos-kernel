export interface WasmModuleCacheStats {
  modules: number;
}

export interface WasmModuleCache {
  getOrCompile(digest: string, bytes: Uint8Array): Promise<WebAssembly.Module>;
  stats(): WasmModuleCacheStats;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new Uint8Array(bytes).buffer,
    );
    return Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
  }

  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

export class MemoryWasmModuleCache implements WasmModuleCache {
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();

  constructor(
    private readonly compile: (
      bytes: Uint8Array,
    ) => Promise<WebAssembly.Module> = (bytes) =>
      WebAssembly.compile(bytes as BufferSource),
  ) {}

  getOrCompile(digest: string, bytes: Uint8Array): Promise<WebAssembly.Module> {
    const existing = this.modules.get(digest);
    if (existing) return existing;

    const compiled = this.compile(new Uint8Array(bytes));
    this.modules.set(digest, compiled);
    compiled.catch(() => {
      if (this.modules.get(digest) === compiled) {
        this.modules.delete(digest);
      }
    });
    return compiled;
  }

  stats(): WasmModuleCacheStats {
    return { modules: this.modules.size };
  }
}

export const defaultWasmModuleCache = new MemoryWasmModuleCache();
