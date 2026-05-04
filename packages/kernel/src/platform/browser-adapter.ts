/**
 * Browser platform adapter — loads .wasm modules via fetch().
 *
 * This is a minimal stub for future browser support. It compiles
 * modules using streaming compilation for better performance.
 */

import type { PlatformAdapter } from './adapter.js';

const BROWSER_TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf', 'find', 'sed', 'awk', 'jq',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr', 'diff',
  'du', 'df',
  'gzip', 'gunzip', 'tar',
  'true', 'false',
  'bc', 'dc', 'sqlite3',
  'pdfinfo', 'pdfunite', 'pdfseparate',
  'xlsx2csv', 'csv2xlsx',
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
  'rg',
  'busybox',
];

function toolToWasmFile(name: string): string {
  if (name === 'true') return 'true-cmd.wasm';
  if (name === 'false') return 'false-cmd.wasm';
  if (name === 'gunzip') return 'gzip.wasm';
  return `${name}.wasm`;
}

export class BrowserAdapter implements PlatformAdapter {
  supportsWorkerExecution = false;

  async loadModule(url: string): Promise<WebAssembly.Module> {
    const response = await fetch(url);
    return WebAssembly.compileStreaming(response);
  }

  async readBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  async instantiate(
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.Instance> {
    // Must use async instantiate — sync `new WebAssembly.Instance()` is
    // disallowed on the main thread for modules larger than 8 MB.
    const result = await WebAssembly.instantiate(module, imports);
    return result;
  }

  async scanTools(wasmBase: string): Promise<Map<string, string>> {
    const tools = new Map<string, string>();
    for (const name of BROWSER_TOOLS) {
      tools.set(name, `${wasmBase}/${toolToWasmFile(name)}`);
    }
    return tools;
  }

  async readDataFile(wasmBase: string, name: string): Promise<Uint8Array | null> {
    // Mirror NodeAdapter.readDataFile via fetch.  Used by the
    // manifest pass to fetch <name>.manifest.json and any sidecar
    // data files declared by it (e.g. magic.mgc for file/libmagic).
    // Returns null on 404 so callers treat the asset as optional.
    try {
      const response = await fetch(`${wasmBase}/${name}`);
      if (!response.ok) return null;
      if (response.headers.get('content-type')?.includes('text/html')) return null;
      const ab = await response.arrayBuffer();
      return new Uint8Array(ab);
    } catch {
      return null;
    }
  }
}
