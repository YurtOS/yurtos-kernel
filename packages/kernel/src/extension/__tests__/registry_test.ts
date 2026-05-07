import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ExtensionRegistry } from '../registry.js';
import type { ExtensionConfig, ExtensionInvokeArgs } from '../types.js';

const INPUT: ExtensionInvokeArgs = { args: [], stdin: '', env: {}, cwd: '/' };

function makeHandler(stdout: string) {
  return async (_input: ExtensionInvokeArgs) => ({ stdout, exitCode: 0 });
}

describe('ExtensionRegistry', () => {
  it('registers and retrieves an extension', () => {
    const reg = new ExtensionRegistry();
    const ext: ExtensionConfig = { name: 'hello', command: makeHandler('hi') };
    reg.register(ext);
    expect(reg.has('hello')).toBe(true);
    expect(reg.get('hello')).toBe(ext);
  });

  it('returns undefined for unknown extension', () => {
    const reg = new ExtensionRegistry();
    expect(reg.has('nope')).toBe(false);
    expect(reg.get('nope')).toBeUndefined();
  });

  it('lists all registered extensions', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'a', command: makeHandler('a') });
    reg.register({ name: 'b', pythonPackage: { version: '1.0', files: {} } });
    expect(reg.list()).toHaveLength(2);
  });

  it('getCommandNames returns only extensions with command', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'cmd', command: makeHandler('x') });
    reg.register({ name: 'pkg', pythonPackage: { version: '1.0', files: {} } });
    expect(reg.getCommandNames()).toEqual(['cmd']);
  });

  it('getPackageNames returns only extensions with pythonPackage', () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'cmd', command: makeHandler('x') });
    reg.register({ name: 'pkg', pythonPackage: { version: '1.0', files: {} } });
    expect(reg.getPackageNames()).toEqual(['pkg']);
  });

  it('invokes a command handler', async () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'greet', command: makeHandler('hello world') });
    const result = await reg.invoke('greet', {
      args: [], stdin: '', env: {}, cwd: '/',
    });
    expect(result.stdout).toBe('hello world');
    expect(result.exitCode).toBe(0);
  });

  it('invoke passes args and stdin to handler', async () => {
    const reg = new ExtensionRegistry();
    reg.register({
      name: 'echo',
      command: async (input) => ({
        stdout: `args=${input.args.join(',')} stdin=${input.stdin}`,
        exitCode: 0,
      }),
    });
    const result = await reg.invoke('echo', {
      args: ['--flag', 'val'], stdin: 'data', env: {}, cwd: '/',
    });
    expect(result.stdout).toBe('args=--flag,val stdin=data');
  });

  it('invoke throws on unknown extension', async () => {
    const reg = new ExtensionRegistry();
    await expect(reg.invoke('nope', {
      args: [], stdin: '', env: {}, cwd: '/',
    })).rejects.toThrow('Extension "nope" not found');
  });

  it('invoke throws on extension without command handler', async () => {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'pkg', pythonPackage: { version: '1.0', files: {} } });
    await expect(reg.invoke('pkg', {
      args: [], stdin: '', env: {}, cwd: '/',
    })).rejects.toThrow('Extension "pkg" not found or has no command handler');
  });
});

describe('ExtensionRegistry – built-in discovery', () => {
  function makeReg() {
    const reg = new ExtensionRegistry();
    reg.register({ name: 'search', description: 'Search docs', category: 'search', usage: 'search <q>', examples: ['search foo'] });
    reg.register({ name: 'fetch', description: 'Fetch doc', category: 'search', command: makeHandler('') });
    reg.register({ name: 'upload', description: 'Upload file', category: 'files', command: makeHandler('') });
    reg.registerBuiltinDiscovery();
    return reg;
  }

  it('list() does not include the built-in extensions command', () => {
    const reg = makeReg();
    expect(reg.list().map((e) => e.name)).not.toContain('extensions');
  });

  it('extensions list shows all user extensions', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['list'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('search');
    expect(result.stdout).toContain('fetch');
    expect(result.stdout).toContain('upload');
  });

  it('extensions list --category filters results', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['list', '--category', 'search'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('search');
    expect(result.stdout).toContain('fetch');
    expect(result.stdout).not.toContain('upload');
  });

  it('extensions list --json returns JSON array', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['list', '--json'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout!);
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((e: { name: string }) => e.name === 'search')).toBe(true);
  });

  it('extensions info shows extension details', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['info', 'search'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('search <q>');
    expect(result.stdout).toContain('search foo');
  });

  it('extensions info returns exit 1 for unknown name', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['info', 'nope'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown extension');
  });

  it('extensions --help returns help text', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['--help'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Subcommands');
  });

  it('extensions unknown subcommand returns exit 1', async () => {
    const reg = makeReg();
    const result = await reg.invoke('extensions', { args: ['bogus'], stdin: '', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });
});
