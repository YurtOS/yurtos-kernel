/**
 * Smoke tests for fixtures that CI builds from source instead of checking in.
 *
 * The broader guest-compat suite also covers these surfaces, but it currently
 * includes deferred python3 and Rust-std cases. This file is the CI guard that
 * proves source-built fixtures were copied into the kernel fixture directory
 * and are usable by the sandbox.
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

describe('source-built fixture smoke tests', () => {
  let sandbox: Sandbox | null = null;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = null;
  });

  it('has generated C canaries copied into the fixture directory', () => {
    for (const name of [
      'stdio-canary.wasm',
      'exec-canary.wasm',
      'fork-canary.wasm',
      'posix-runtime-canary.wasm',
    ]) {
      expect(existsSync(resolve(FIXTURES, name))).toBe(true);
    }
  });

  it('runs representative guest-compat canaries', async () => {
    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello fixture\n'));

    const stdio = await sandbox.run('stdio-canary /tmp/in.txt /tmp/out.txt');
    expect(stdio.exitCode).toBe(0);
    expect(stdio.stdout.trim()).toBe('stdio-ok');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/out.txt'))).toBe('hello fixture\n');

    const priority = await sandbox.run('posix-runtime-canary --case priority_unsupported');
    expect(priority.exitCode).toBe(0);
    expect(priority.stdout.trim()).toBe(
      '{"case":"priority_unsupported","exit":0,"stdout":"priority_unsupported:ok"}',
    );

    const execDenied = await sandbox.run('exec-canary execv_eacces');
    expect(execDenied.exitCode).toBe(0);
    expect(execDenied.stdout.trim()).toBe('{"case":"execv_eacces","exit":0,"errno":2}');
  });

  it('runs BusyBox applets through the multicall fixture', async () => {
    for (const name of ['busybox.wasm', 'busybox.manifest.json']) {
      expect(existsSync(resolve(FIXTURES, name))).toBe(true);
    }

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    const link = await sandbox.run('readlink /usr/bin/grep');
    expect(link.stdout.trim()).toBe('/usr/bin/busybox');

    const grep = await sandbox.run('grep foo /tmp/data.txt');
    expect(grep.exitCode).toBe(0);
    expect(grep.stdout.trim()).toBe('foo');

    const seq = await sandbox.run('busybox seq 3');
    expect(seq.exitCode).toBe(0);
    expect(seq.stdout).toBe('1\n2\n3\n');
  });

  it('runs BusyBox ash as /usr/bin/sh', async () => {
    for (const name of ['busybox.wasm', 'busybox.manifest.json']) {
      expect(existsSync(resolve(FIXTURES, name))).toBe(true);
    }

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const binSh = await sandbox.run('readlink /bin/sh');
    expect(binSh.exitCode).toBe(0);
    expect(binSh.stdout.trim()).toBe('/usr/bin/busybox');

    const shell = await sandbox.run("sh -c 'x=3; echo ash:$((x + 2)); echo payload > /tmp/ash.txt'");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.trim()).toBe('ash:5');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/ash.txt')).trim()).toBe('payload');

    const direct = await sandbox.run("busybox ash -c 'printf direct-ash'");
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).toBe('direct-ash');

    const pipeline = await sandbox.run("ash -c 'seq 3 | wc -l'");
    expect(pipeline.exitCode).toBe(0);
    expect(pipeline.stdout.trim()).toBe('3');

    const redirected = await sandbox.run("ash -c 'seq 3 > /tmp/seq.out; wc -l /tmp/seq.out'");
    expect(redirected.exitCode).toBe(0);
    expect(redirected.stdout.trim()).toBe('3 /tmp/seq.out');
  });
});
