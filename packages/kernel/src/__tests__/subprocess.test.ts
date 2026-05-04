/**
 * Integration tests for Python subprocess support.
 *
 * Verifies that subprocess.run(), check_output(), Popen, and os.popen()
 * work correctly in the WASI sandbox via _yurt.spawn().
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { makeRunCommandHandler } from '../../../sdk-server/src/bash-dispatch.ts';
import { bashBootImports } from '../../../sdk-server/src/bash-host-imports.ts';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

function createSandbox(): Promise<Sandbox> {
  return Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootImports: (api) => bashBootImports(api),
    runCommandHandler: makeRunCommandHandler(),
  });
}

describe('Python subprocess', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('subprocess.run list form captures stdout', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import subprocess; r = subprocess.run([\'echo\', \'hello\'], capture_output=True, text=True); print(r.stdout.strip())"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('subprocess.run shell=True captures stdout', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import subprocess; r = subprocess.run(\'echo world\', shell=True, capture_output=True, text=True); print(r.stdout.strip())"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('world');
  });

  it('subprocess.check_output returns bytes', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import subprocess; out = subprocess.check_output([\'echo\', \'bytes\']); print(out.decode().strip())"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('bytes');
  });

  it('subprocess.run non-zero exit code', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import subprocess; r = subprocess.run([\'false\']); print(r.returncode)"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('subprocess.run with stdin input', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import subprocess; r = subprocess.run([\'cat\'], input=\'hello stdin\', capture_output=True, text=True); print(r.stdout)"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello stdin');
  });

  it('os.popen works without explicit import subprocess', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import os; out = os.popen(\'echo popen\').read(); print(out.strip())"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('popen');
  });

  it('subprocess.Popen communicate', async () => {
    sandbox = await createSandbox();
    const result = await sandbox.run(
      'python3 -c "import subprocess; p = subprocess.Popen([\'echo\', \'popen\'], stdout=subprocess.PIPE, text=True); out, _ = p.communicate(); print(out.strip())"'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('popen');
  });
});
