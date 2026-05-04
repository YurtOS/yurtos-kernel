/**
 * Python socket/ssl module shims for the sandbox.
 *
 * These shims are written to the VFS at /usr/lib/python/ by Sandbox.create()
 * when networking is enabled. They shadow RustPython's frozen modules via
 * PYTHONPATH and sitecustomize.py injection.
 *
 * Source files live in ./python-shims/ as static .py files.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'python-shims');

/** Read a Python shim file from the python-shims directory. */
function readShim(filename: string): string {
  try {
    return readFileSync(join(SHIM_DIR, filename), 'utf-8');
  } catch {
    throw new Error(
      `Failed to read Python shim '${filename}' from ${SHIM_DIR}. ` +
      `If running from a bundled binary, ensure the python-shims/ directory ` +
      `is available next to the bundle.`
    );
  }
}

/**
 * Get the socket shim source for the given network mode.
 * - `restricted`: HTTP-level interception via _yurt.fetch()
 * - `full`: real socket proxy via _yurt.socket_*() (when available)
 */
export function getSocketShimSource(mode: 'restricted' | 'full' = 'restricted'): string {
  const filename = mode === 'full' ? 'socket_native.py' : 'socket_fetch.py';
  return readShim(filename);
}

/** Get the ssl shim source (works in both modes). */
export function getSslShimSource(): string {
  return readShim('ssl.py');
}

/**
 * Build a sitecustomize.py that injects subprocess (always) and optionally
 * socket + ssl (when networking is enabled).
 *
 * subprocess.py is always installed in /usr/lib/python, so injecting it here
 * ensures `os.popen` is patched at interpreter start even without an explicit
 * `import subprocess`.
 */
export function buildSiteCustomizeSource(opts: { networking?: boolean } = {}): string {
  let src = `\
"""
Wasmsand sitecustomize — injects Python shims at interpreter startup.

RustPython's frozen modules take priority over PYTHONPATH files.
Loading our shims here (runs at interpreter startup) injects them into
sys.modules before any other code can import the frozen versions.
"""
import sys
import importlib.machinery
import importlib.util


def _inject_shim(name, path):
    """Load a .py file and register it as a sys.modules entry."""
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_file_location(name, path, loader=loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    loader.exec_module(mod)


_inject_shim("subprocess", "/usr/lib/python/subprocess.py")
`;

  if (opts.networking) {
    src += `\n_inject_shim("socket", "/usr/lib/python/socket.py")\n`;
    src += `_inject_shim("ssl", "/usr/lib/python/ssl.py")\n`;
  }

  return src;
}

/** Get the sitecustomize.py source with network shims (legacy alias). */
export function getSiteCustomizeSource(): string {
  return buildSiteCustomizeSource({ networking: true });
}

/** Get the requests module shim (lightweight requests-compatible HTTP library). */
export function getRequestsShimSource(): string {
  return readShim('requests.py');
}
