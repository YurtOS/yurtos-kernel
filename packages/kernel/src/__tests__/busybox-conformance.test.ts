/**
 * BusyBox applet conformance through the Yurt sandbox.
 *
 * Adapted from Codepod's bash-conformance cp/mv/rm/mkdir and
 * cat/echo/printf suites, but routed through Yurt's BusyBox multicall
 * fixture so these tests exercise the kernel syscall/VFS path.
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../platform/__tests__/fixtures');

describe('BusyBox conformance', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    expect(existsSync(resolve(FIXTURES, 'busybox.wasm'))).toBe(true);
    expect(existsSync(resolve(FIXTURES, 'busybox.manifest.json'))).toBe(true);
    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
  });

  afterEach(() => {
    sandbox?.destroy();
  });

  function writeFile(path: string, content: string): void {
    sandbox.writeFile(path, new TextEncoder().encode(content));
  }

  function writeBytes(path: string, content: Uint8Array): void {
    sandbox.writeFile(path, content);
  }

  describe('cat/echo/printf', () => {
    it('reads and concatenates files', async () => {
      writeFile('/tmp/a.txt', 'aaa\n');
      writeFile('/tmp/b.txt', 'bbb\n');

      const result = await sandbox.run('cat /tmp/a.txt /tmp/b.txt');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('aaa\nbbb\n');
    });

    it('reads stdin through a pipe', async () => {
      const result = await sandbox.run("echo hello | cat");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\n');
    });

    it('supports printf formatting and escapes', async () => {
      const result = await sandbox.run("printf 'hi %s\\n%d\\n' world 42");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi world\n42\n');
    });
  });

  describe('Linux process affinity surface', () => {
    it('supports BusyBox taskset against the kernel pid table', async () => {
      const current = await sandbox.run('taskset -p 1 2>&1');

      expect(current.exitCode).toBe(0);
      expect(current.stdout).toContain("pid 1's current affinity mask: 1");

      const invalid = await sandbox.run('taskset -p 0 >/tmp/taskset.out 2>/tmp/taskset.err; echo status:$?; cat /tmp/taskset.err');

      expect(invalid.stdout).toContain('status:1');
    });
  });

  describe('upstream ash behaviors', () => {
    it('exec of the current script preserves argv and exits through waitpid', async () => {
      writeFile('/tmp/ash-exec-argv0.tests', [
        'if test $# = 0; then',
        '  exec /usr/bin/ash "$0" arg',
        'fi',
        'echo "OK:$#:$1"',
        '',
      ].join('\n'));

      const result = await sandbox.run('cd /tmp; ash ./ash-exec-argv0.tests 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('OK:1:arg\n');
    });

    it('background jobs reopen stdin from /dev/null on fd 0', async () => {
      const result = await sandbox.run("ash -c 'sleep 0 & echo after' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('after\n');
    });

    it('supports upstream ash background wait ordering', async () => {
      const result = await sandbox.run(
        "ash -c 'echo First && sleep 0.2 && echo Third & sleep 0.1; echo Second; wait; echo Done' 2>&1",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('First\nSecond\nThird\nDone\n');
    });

    it('does not force forked background jobs to run before the parent resumes', async () => {
      const result = await sandbox.run([
        "ash -c '",
        'trap "false;exit" TERM;',
        'kill $$ &',
        '(sleep 1; exit 42)',
        "' 2>&1",
      ].join(' '));

      expect(result.exitCode).toBe(42);
      expect(result.stdout).toBe('');
    });

    it('resolves redirection targets relative to the process cwd', async () => {
      const result = await sandbox.run("cd /tmp; ash -c 'echo hi >tmp; cat tmp' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi\n');
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/tmp'))).toBe('hi\n');
    });

    it('flushes spawned applet output redirected by ash', async () => {
      const result = await sandbox.run("cd /tmp; ash -c '/usr/bin/busybox echo hi >spawned.out; cat spawned.out' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi\n');
      expect(new TextDecoder().decode(sandbox.readFile('/tmp/spawned.out'))).toBe('hi\n');
    });

    it('does not expose close-on-exec script fds to spawned applets', async () => {
      writeFile('/tmp/ash-fd-leak.tests', 'ls -1 /proc/self/fd | wc -l\n');

      const result = await sandbox.run('ash /tmp/ash-fd-leak.tests 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('4\n');
    });

    it('round-trips replacement-byte filenames through globbed readdir', async () => {
      const script = new Uint8Array([
        ...new TextEncoder().encode('>unicode.sh\n'),
        ...new TextEncoder().encode("printf 'echo Ok >uni"),
        0x81,
        ...new TextEncoder().encode("code\\n' >>unicode.sh\n"),
        ...new TextEncoder().encode("printf 'cat uni"),
        0x81,
        ...new TextEncoder().encode("code\\n' >>unicode.sh\n"),
        ...new TextEncoder().encode("printf 'cat uni?code\\n' >>unicode.sh\n"),
        ...new TextEncoder().encode('. ./unicode.sh\nrm uni*code*\necho Done\n'),
      ]);
      writeBytes('/tmp/ash-raw-filename.tests', script);

      const result = await sandbox.run('cd /tmp; ash ./ash-raw-filename.tests 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Ok\nOk\nDone\n');
    });

    it('does not let POSIX redirection duplicate the WASI root preopen fd', async () => {
      writeFile('/tmp/ash-hidden-preopen.tests', [
        'echo LOST >&3',
        'echo OK',
        '',
      ].join('\n'));

      const result = await sandbox.run('ash /tmp/ash-hidden-preopen.tests 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Bad file descriptor');
      expect(result.stdout.endsWith('OK\n')).toBe(true);
    });

    it('polls and reads redirected stdin for ash builtins', async () => {
      writeFile('/tmp/read-input.txt', 'from-file\n');

      const result = await sandbox.run("cd /tmp; echo from-pipe | ash -c 'read first <read-input.txt; echo $first; read second; echo $second' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('from-file\nfrom-pipe\n');
    });

    it('exports empty assignments as empty shell variables', async () => {
      const result = await sandbox.run("ash -c 'SKIP=1; export SKIP=; if [ -n \"$SKIP\" ]; then echo bad:$SKIP; else echo ok; fi' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ok\n');
    });

    it('executes chmodded relative scripts from the process cwd', async () => {
      writeFile('/tmp/relative-script.sh', '#!/usr/bin/ash\necho relative-ok\n');

      const result = await sandbox.run('cd /tmp; chmod 755 relative-script.sh; ./relative-script.sh 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('relative-ok\n');
    });

    it('inherits non-CLOEXEC descriptors for process substitution', async () => {
      const result = await sandbox.run("ash -c 'cat <(echo inherited-fd)' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('inherited-fd\n');
    });

    it('presents /dev/fd as the current process fd directory', async () => {
      const result = await sandbox.run("ash -c 'test -d /dev/fd && ls /dev/fd | grep -qx 0' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('rejects redirection from closed descriptors', async () => {
      const result = await sandbox.run("ash -c 'echo TEST 9>/dev/null; echo LOST >&9; echo status:$?' 2>&1");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('TEST\n');
      expect(result.stdout).toContain('dup2(9,1): Bad file descriptor');
      expect(result.stdout).toContain('status:1\n');
      expect(result.stdout).not.toContain('LOST\n');
    });

    it('delivers self-signals before kill returns', async () => {
      const result = await sandbox.run([
        'ash -c \'',
        'trap "echo caught" USR2;',
        'kill -USR2 $$;',
        'trap "" USR2;',
        'echo after',
        '\' 2>&1',
      ].join(' '));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('caught\nafter\n');
    });

    it('terminates an infinite upstream pipe writer when the reader exits', async () => {
      sandbox.destroy();
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
        timeoutMs: 3_000,
      });

      const result = await sandbox.run(
        'ash -c \'yes "123456789 123456789 123456789 123456789" | head -3000 | md5sum\' 2>&1',
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('546ed3f5c81c780d3ab86ada14824237  -\n');
    });

    it('runs background signal timers while the foreground shell repeatedly waits', async () => {
      sandbox.destroy();
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
        timeoutMs: 5_000,
      });
      writeFile('/tmp/ash-wait-signal.tests', [
        'trap "echo TERM;return" term',
        'f() {',
        '  (sleep 1; kill $$) &',
        '  until (exit 42) do (exit 42); done',
        '}',
        'f',
        'echo 42:$?',
        '',
      ].join('\n'));

      const result = await sandbox.run('ash /tmp/ash-wait-signal.tests 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('TERM\n42:42\n');
    });

    it('runs nested shell-function pipelines without leaking closed pipe fds', async () => {
      sandbox.destroy();
      sandbox = await Sandbox.create({
        wasmDir: FIXTURES,
        adapter: new NodeAdapter(),
        timeoutMs: 5_000,
      });
      writeFile('/tmp/ash-nommu-pipeline.tests', [
        'func() {',
        '  while read p; do echo "$p"; done',
        '}',
        'pipe_to_func() {',
        '  echo Ok | func',
        '}',
        'pipe_to_func | cat',
        'echo $?',
        '',
      ].join('\n'));

      const result = await sandbox.run('ash /tmp/ash-nommu-pipeline.tests 2>&1');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Ok\n0\n');
    });

  });

  describe('file operations', () => {
    it('copies files and directories', async () => {
      writeFile('/tmp/src.txt', 'data\n');
      let result = await sandbox.run('cp /tmp/src.txt /tmp/dst.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/dst.txt');
      expect(result.stdout).toBe('data\n');

      result = await sandbox.run('mkdir -p /tmp/d1/sub');
      expect(result.exitCode).toBe(0);
      writeFile('/tmp/d1/sub/f.txt', 'inside\n');
      result = await sandbox.run('cp -r /tmp/d1 /tmp/d2');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/d2/sub/f.txt');
      expect(result.stdout).toBe('inside\n');
    });

    it('moves files into directories', async () => {
      writeFile('/tmp/f.txt', 'hello\n');

      let result = await sandbox.run('mkdir /tmp/dir');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('mv /tmp/f.txt /tmp/dir/');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/dir/f.txt');
      expect(result.stdout).toBe('hello\n');
      result = await sandbox.run('cat /tmp/f.txt');
      expect(result.exitCode).not.toBe(0);
    });

    it('removes files and recursive directories', async () => {
      writeFile('/tmp/f.txt', 'bye\n');

      let result = await sandbox.run('rm /tmp/f.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/f.txt');
      expect(result.exitCode).not.toBe(0);

      result = await sandbox.run('mkdir -p /tmp/d/sub');
      expect(result.exitCode).toBe(0);
      writeFile('/tmp/d/sub/f.txt', 'x');
      result = await sandbox.run('rm -r /tmp/d');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('ls /tmp/d');
      expect(result.exitCode).not.toBe(0);
    });

    it('creates nested directories and removes empty directories', async () => {
      let result = await sandbox.run('mkdir -p /tmp/a/b/c');
      expect(result.exitCode).toBe(0);
      writeFile('/tmp/a/b/c/f.txt', 'deep\n');
      result = await sandbox.run('cat /tmp/a/b/c/f.txt');
      expect(result.stdout).toBe('deep\n');

      result = await sandbox.run('mkdir /tmp/empty');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('rmdir /tmp/empty');
      expect(result.exitCode).toBe(0);
    });

    it('touch creates files without truncating existing content', async () => {
      let result = await sandbox.run('touch /tmp/new.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/new.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');

      writeFile('/tmp/existing.txt', 'keep\n');
      result = await sandbox.run('touch /tmp/existing.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/existing.txt');
      expect(result.stdout).toBe('keep\n');
    });

    it('creates symbolic and hard links', async () => {
      writeFile('/tmp/target.txt', 'linked\n');

      let result = await sandbox.run('ln -s /tmp/target.txt /tmp/symlink.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/symlink.txt');
      expect(result.stdout).toBe('linked\n');

      result = await sandbox.run('ln /tmp/target.txt /tmp/hardlink.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run("printf updated > /tmp/hardlink.txt; cat /tmp/target.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('updated');
    });
  });
});
