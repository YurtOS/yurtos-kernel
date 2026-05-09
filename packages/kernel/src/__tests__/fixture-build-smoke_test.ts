/**
 * Smoke tests for fixtures that CI builds from source instead of checking in.
 *
 * The broader ABI suite also covers these surfaces, but it currently
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
import { unsupportedRuntimeEngineBackend } from '../engine/backend.js';

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
      'locale-canary.wasm',
      'posix-runtime-canary.wasm',
    ]) {
      expect(existsSync(resolve(FIXTURES, name))).toBe(true);
    }
  });

  it('runs representative ABI canaries', async () => {
    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello fixture\n'));

    const stdio = await sandbox.run('stdio-canary /tmp/in.txt /tmp/out.txt');
    expect(stdio.exitCode).toBe(0);
    expect(stdio.stdout.trim()).toBe('stdio-ok');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/out.txt'))).toBe('hello fixture\n');

    sandbox.destroy();
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      runtimeBackend: unsupportedRuntimeEngineBackend,
    });
    const priority = await sandbox.run('posix-runtime-canary --case priority_unsupported');
    expect(priority.exitCode).toBe(0);
    expect(priority.stdout.trim()).toBe(
      '{"case":"priority_unsupported","exit":0,"stdout":"priority_unsupported:ok"}',
    );

    const execDenied = await sandbox.run('exec-canary execv_eacces');
    expect(execDenied.exitCode).toBe(0);
    expect(execDenied.stdout.trim()).toBe('{"case":"execv_eacces","exit":0,"errno":2}');

    const locale = await sandbox.run('locale-canary unicode_quote_ascii');
    expect(locale.exitCode).toBe(0);
    expect(locale.stdout).toContain('locale:strftime_invalid=0 first=120');
  });

  it('runs BusyBox applets through the multicall fixture', async () => {
    for (const name of ['busybox.wasm', 'busybox.manifest.json']) {
      expect(existsSync(resolve(FIXTURES, name))).toBe(true);
    }

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    const link = await sandbox.run('readlink /usr/bin/grep');
    expect(link.stdout.trim()).toBe('/usr/bin/busybox');

    const binEchoLink = await sandbox.run('readlink /bin/echo');
    expect(binEchoLink.exitCode).toBe(0);
    expect(binEchoLink.stdout.trim()).toBe('/usr/bin/busybox');

    const chmod = await sandbox.run("touch /tmp/executable.sh && chmod 755 /tmp/executable.sh && stat -c '%a' /tmp/executable.sh");
    expect(chmod.exitCode).toBe(0);
    expect(chmod.stdout.trim()).toBe('755');

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

  it('runs zsh as a source-built fixture', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run("zsh -fc 'print zsh:$((2 + 3))'");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.trim()).toBe('zsh:5');
  });

  it('lets zsh unload static modules with special hash parameters', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run("zsh -fc 'zmodload zsh/parameter; zmodload -u zsh/parameter; print after' 2>&1");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toBe('after\n');
  });

  it('runs the ncurses terminfo source-built fixture', async () => {
    expect(existsSync(resolve(FIXTURES, 'terminfo-canary.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const terminfo = await sandbox.run('terminfo-canary');
    expect(terminfo.exitCode).toBe(0);
    expect(terminfo.stdout.trim()).toBe('terminfo-ok');
  });

  it('lets zsh fork and exec another zsh', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run("zsh -fc '/usr/bin/zsh -fc \"print nested\"' 2>&1");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.trim()).toBe('nested');
  });

  it('lets zsh continue after a forked external command', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run("zsh -fc 'print before; /bin/echo child; print after' 2>&1");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.trim()).toBe('before\nchild\nafter');
  });

  it('lets zsh override argv0 for an executed program', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run("zsh -fc \"exec -a /bin/SPLATTER /bin/sh -c 'echo \\$0'\" 2>&1");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.trim()).toBe('/bin/SPLATTER');
  });

  it('keeps redirected stdout open across zsh fork and exec cleanup', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/repro.zsh', new TextEncoder().encode([
      "/usr/bin/zsh -fc '{ ( ) } always { echo foo }' > /tmp/out",
      'echo status:$?',
      'cat /tmp/out',
      '',
    ].join('\n')));

    const shell = await sandbox.run('zsh -f /tmp/repro.zsh 2>&1');
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toBe('status:0\nfoo\n');
  });

  it('starts spawned zsh processes in the parent current directory', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run("mkdir -p /tmp/zdir; cd /tmp/zdir; zsh -fc 'pwd; print PWD=$PWD' 2>&1");
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.trim()).toBe('/tmp/zdir\nPWD=/tmp/zdir');
  });

  it('lets zsh enforce noclobber through fd-based regular-file stat', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await sandbox.run([
      "zsh -fc '",
      "setopt noclobber clobberempty; ",
      "rm -f /tmp/foo; touch /tmp/foo; ",
      "print Works >/tmp/foo; cat /tmp/foo; ",
      "print Works\\\\ not >/tmp/foo; cat /tmp/foo",
      "' 2>&1",
    ].join(''));
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toBe('Works\nzsh:1: file exists: /tmp/foo\nWorks\n');
  });

  it('executes relative-PATH shebang scripts from the process cwd', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/repro.zsh', new TextEncoder().encode([
      'mkdir -p /tmp/command.tmp/dir1 /tmp/command.tmp/dir2',
      'cd /tmp/command.tmp',
      'shcmd="$(which sh)"',
      'print "#!${shcmd}\\necho This is top" >tstcmd',
      'chmod 755 tstcmd',
      'path=(. command.tmp/dir{1,2})',
      'tstcmd',
      '',
    ].join('\n')));

    const shell = await sandbox.run('zsh -f /tmp/repro.zsh 2>&1');
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toBe('This is top\n');
  });

  it('releases zsh background children killed while sleeping', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      timeoutMs: 2_000,
    });

    const shell = await sandbox.run([
      "zsh -fc '",
      "sleep 1000 & pid=$!; ",
      "kill $pid; ",
      "wait $pid; ",
      "print waited:$?",
      "' 2>&1",
    ].join(''));
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toContain('waited:143');
  });

  it('lets zsh subshells resume after sleeping children', async () => {
    expect(existsSync(resolve(FIXTURES, 'zsh.wasm'))).toBe(true);

    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      timeoutMs: 3_000,
    });

    const shell = await sandbox.run(
      "zsh -fc '( sleep 1; echo hello ); echo status:$?' 2>&1",
    );
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout).toBe('hello\nstatus:0\n');
  });
});
