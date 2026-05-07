import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';

import { NodeAdapter } from '../node-adapter.js';
import { WasiHost } from '../../wasi/wasi-host.js';
import { VFS } from '../../vfs/vfs.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

describe('NodeAdapter', () => {
  it('loads a .wasm file from the filesystem', async () => {
    const adapter = new NodeAdapter();
    const module = await adapter.loadModule(resolve(FIXTURES, 'hello.wasm'));
    expect(module).toBeInstanceOf(WebAssembly.Module);
  });

  it('instantiates a module with imports', async () => {
    const adapter = new NodeAdapter();
    const vfs = new VFS();
    const host = new WasiHost({
      vfs,
      args: ['hello'],
      env: {},
      preopens: { '/': '/' },
    });

    const module = await adapter.loadModule(resolve(FIXTURES, 'hello.wasm'));
    const instance = await adapter.instantiate(module, host.getImports());
    expect(instance).toBeInstanceOf(WebAssembly.Instance);
    expect(instance.exports._start).toBeDefined();
    expect(instance.exports.memory).toBeDefined();
  });

  it('loads and runs a hello-world WASI binary', async () => {
    const adapter = new NodeAdapter();
    const vfs = new VFS();
    const host = new WasiHost({
      vfs,
      args: ['hello'],
      env: {},
      preopens: { '/': '/' },
    });

    const module = await adapter.loadModule(resolve(FIXTURES, 'hello.wasm'));
    const instance = await adapter.instantiate(module, host.getImports());
    const exitCode = host.start(instance);

    expect(exitCode).toBe(0);
    expect(host.getStdout()).toBe('hello from wasm\n');
    expect(host.getExitCode()).toBe(0);
  });

  it('passes args to a WASI binary', async () => {
    const adapter = new NodeAdapter();
    const vfs = new VFS();
    const host = new WasiHost({
      vfs,
      args: ['echo-args', 'one', 'two', 'three'],
      env: {},
      preopens: { '/': '/' },
    });

    const module = await adapter.loadModule(
      resolve(FIXTURES, 'echo-args.wasm'),
    );
    const instance = await adapter.instantiate(module, host.getImports());
    const exitCode = host.start(instance);

    expect(exitCode).toBe(0);
    expect(host.getStdout()).toBe('one\ntwo\nthree\n');
    expect(host.getExitCode()).toBe(0);
  });

  it('passes environment variables to a WASI binary', async () => {
    const adapter = new NodeAdapter();
    const vfs = new VFS();
    const host = new WasiHost({
      vfs,
      args: ['hello'],
      env: { FOO: 'bar', HOME: '/home/user' },
      preopens: { '/': '/' },
    });

    const module = await adapter.loadModule(resolve(FIXTURES, 'hello.wasm'));
    const instance = await adapter.instantiate(module, host.getImports());
    const exitCode = host.start(instance);

    expect(exitCode).toBe(0);
    expect(host.getStdout()).toBe('hello from wasm\n');
  });

  it('handles empty args list for echo-args binary', async () => {
    const adapter = new NodeAdapter();
    const vfs = new VFS();
    const host = new WasiHost({
      vfs,
      args: ['echo-args'],
      env: {},
      preopens: { '/': '/' },
    });

    const module = await adapter.loadModule(
      resolve(FIXTURES, 'echo-args.wasm'),
    );
    const instance = await adapter.instantiate(module, host.getImports());
    const exitCode = host.start(instance);

    expect(exitCode).toBe(0);
    expect(host.getStdout()).toBe('');
    expect(host.getExitCode()).toBe(0);
  });
});
