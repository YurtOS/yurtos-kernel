/**
 * Node.js platform adapter — loads .wasm modules from the local filesystem.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { PlatformAdapter } from './adapter.js';

const EXCLUDED = new Set<string>();

function wasmToToolName(filename: string): string {
  if (filename === 'true-cmd.wasm') return 'true';
  if (filename === 'false-cmd.wasm') return 'false';
  return filename.replace(/\.wasm$/, '');
}

export class NodeAdapter implements PlatformAdapter {
  // Worker threads require Node.js (not Deno) to load .ts worker files
  supportsWorkerExecution = typeof (globalThis as any).Deno === 'undefined';

  /** Cross-instance cache so repeated compilations of the same .wasm
   *  (e.g. across test-level ProcessManager instances) don't re-read
   *  from disk under resource pressure. */
  private static compiledModules = new Map<string, WebAssembly.Module>();

  async loadModule(path: string): Promise<WebAssembly.Module> {
    const cached = NodeAdapter.compiledModules.get(path);
    if (cached) return cached;
    const buffer = await readFile(path);
    const module = await WebAssembly.compile(buffer.buffer as ArrayBuffer);
    NodeAdapter.compiledModules.set(path, module);
    return module;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const buf = await readFile(path);
    // Return a plain Uint8Array (not Buffer) so callers don't accidentally
    // depend on Node-specific Buffer methods.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    // Use async instantiation so JSPI-wrapped imports (WebAssembly.Suspending)
    // are recognized as callable. The sync `new WebAssembly.Instance()` rejects them.
    return await WebAssembly.instantiate(module, imports);
  }

  async scanTools(wasmDir: string): Promise<Map<string, string>> {
    const entries = await readdir(wasmDir);
    const tools = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.endsWith('.wasm') || EXCLUDED.has(entry)) continue;
      const name = wasmToToolName(entry);
      tools.set(name, resolve(wasmDir, entry));
    }
    // gunzip is an alias for gzip (same binary, argv[0] detection)
    if (tools.has('gzip') && !tools.has('gunzip')) {
      tools.set('gunzip', tools.get('gzip')!);
    }
    return tools;
  }

  async readDataFile(wasmDir: string, name: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(resolve(wasmDir, name));
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  }
}
