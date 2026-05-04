/**
 * Extension system integration tests.
 *
 * Exercises the full extension lifecycle: registration, shell command execution,
 * piped stdin, --help, which discovery, pip builtin, and Python package VFS.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import type { ExtensionConfig } from '../extension/types.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');


describe('Extension commands', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('runs an extension command and returns output', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'greet',
        description: 'Say hello',
        command: async () => ({ stdout: 'hello from extension\n', exitCode: 0 }),
      }],
    });
    const result = await sandbox.run('greet');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from extension\n');
  });

  it('extension receives args', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'myext',
        command: async (input) => ({
          stdout: `args: ${input.args.join(' ')}\n`,
          exitCode: 0,
        }),
      }],
    });
    const result = await sandbox.run('myext foo bar');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('args: foo bar\n');
  });

  it('extension receives piped stdin', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'upper',
        command: async (input) => ({
          stdout: input.stdin.toUpperCase(),
          exitCode: 0,
        }),
      }],
    });
    const result = await sandbox.run('echo hello | upper');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('HELLO');
  });

  it('--help returns extension description', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'helper',
        description: 'A helpful command\nUsage: helper [opts]',
        command: async () => ({ stdout: '', exitCode: 0 }),
      }],
    });
    const result = await sandbox.run('helper --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('A helpful command');
  });

  it('which finds extension command', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'myext',
        command: async () => ({ stdout: '', exitCode: 0 }),
      }],
    });
    const result = await sandbox.run('which myext');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/usr/bin/myext');
  });

  it('extension output can be redirected to file', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'gen',
        command: async () => ({ stdout: 'generated content', exitCode: 0 }),
      }],
    });
    await sandbox.run('gen > /tmp/out.txt');
    const content = new TextDecoder().decode(sandbox.readFile('/tmp/out.txt'));
    expect(content).toBe('generated content');
  });

  it('multiple extensions in one sandbox', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [
        { name: 'ext1', command: async () => ({ stdout: 'one\n', exitCode: 0 }) },
        { name: 'ext2', command: async () => ({ stdout: 'two\n', exitCode: 0 }) },
      ],
    });
    const r1 = await sandbox.run('ext1');
    const r2 = await sandbox.run('ext2');
    expect(r1.stdout.trim()).toBe('one');
    expect(r2.stdout.trim()).toBe('two');
  });

  it('extension with non-zero exit code', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'fail',
        command: async () => ({ stdout: '', stderr: 'oops\n', exitCode: 1 }),
      }],
    });
    const result = await sandbox.run('fail');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('oops\n');
  });

  it('extension with && chaining respects exit code', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [
        { name: 'fail', command: async () => ({ stdout: '', exitCode: 1 }) },
        { name: 'ok', command: async () => ({ stdout: 'ran\n', exitCode: 0 }) },
      ],
    });
    const result = await sandbox.run('fail && ok');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });
});

describe('Extension Python packages', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('pip list shows registered packages', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'mylib',
        pythonPackage: { version: '2.1.0', summary: 'A test lib', files: { '__init__.py': 'x = 1' } },
      }],
    });
    const result = await sandbox.run('pip list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('mylib');
    expect(result.stdout).toContain('2.1.0');
  });

  it('pip show displays package metadata', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'analyzer',
        pythonPackage: {
          version: '1.0.0',
          summary: 'Code analysis tool',
          files: { '__init__.py': '', 'core.py': 'def run(): pass' },
        },
      }],
    });
    const result = await sandbox.run('pip show analyzer');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Name: analyzer');
    expect(result.stdout).toContain('Version: 1.0.0');
    expect(result.stdout).toContain('Summary: Code analysis tool');
    expect(result.stdout).toContain('core.py');
  });

  it('pip show returns error for nonexistent package', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const result = await sandbox.run('pip show nonexistent');
    expect(result.exitCode).toBe(1);
  });

  it('pip install accepts registered extension package without error', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { pipPolicy: { enabled: true } },
      extensions: [{
        name: 'mypkg',
        pythonPackage: { version: '1.0.0', files: { '__init__.py': '' } },
      }],
    });
    const result = await sandbox.run('pip install mypkg');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('ERROR');
  });

  it('pip install fails for unknown package', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { pipPolicy: { enabled: true } },
    });
    const result = await sandbox.run('pip install unknown');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Could not find a version');
  });

  it('package files are installed in VFS', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'testpkg',
        pythonPackage: {
          version: '1.0.0',
          files: { '__init__.py': '# test package', 'utils.py': 'def hello(): return "hi"' },
        },
      }],
    });
    const init = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/testpkg/__init__.py'));
    expect(init).toBe('# test package');
    const utils = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/testpkg/utils.py'));
    expect(utils).toContain('def hello');
  });

  it('yurt_ext.py bridge is installed when packages exist', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'x',
        pythonPackage: { version: '1.0', files: { '__init__.py': '' } },
      }],
    });
    const content = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/yurt_ext.py'));
    expect(content).toContain('import _yurt');
    expect(content).toContain('def call(');
  });

  it('command-only extension gets auto-generated _shim.py and __init__.py', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'greet',
        command: async (input) => ({ stdout: `hello ${input.args[0]}\n`, exitCode: 0 }),
      }],
    });
    const shim = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/greet/_shim.py'));
    expect(shim).toContain('import yurt_ext');
    expect(shim).toContain('def run(*args');
    expect(shim).toContain('_ce.call("greet"');
    const init = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/greet/__init__.py'));
    expect(init).toContain('from greet._shim import run');
  });

  it('extension with command+package gets _shim.py alongside author files', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'myext',
        command: async () => ({ stdout: 'ok\n', exitCode: 0 }),
        pythonPackage: { version: '1.0.0', files: { '__init__.py': 'from myext._shim import run' } },
      }],
    });
    const shim = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/myext/_shim.py'));
    expect(shim).toContain('_ce.call("myext"');
    const init = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/myext/__init__.py'));
    expect(init).toBe('from myext._shim import run');
  });

  it('extension with both command and package', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      extensions: [{
        name: 'dualext',
        description: 'Dual extension',
        command: async () => ({ stdout: 'from command\n', exitCode: 0 }),
        pythonPackage: { version: '1.0.0', files: { '__init__.py': 'x = 42' } },
      }],
    });
    // Command works
    const cmdResult = await sandbox.run('dualext');
    expect(cmdResult.stdout.trim()).toBe('from command');
    // pip shows it
    const pipResult = await sandbox.run('pip list');
    expect(pipResult.stdout).toContain('dualext');
    // Package files exist
    const init = new TextDecoder().decode(sandbox.readFile('/usr/lib/python/dualext/__init__.py'));
    expect(init).toBe('x = 42');
  });
});
