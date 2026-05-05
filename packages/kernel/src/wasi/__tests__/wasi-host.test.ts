import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { WasiHost } from '../wasi-host.js';
import { VFS } from '../../vfs/vfs.js';
import { ProcessKernel } from '../../process/kernel.js';
import {
  WASI_EBADF,
  WASI_EMFILE,
  WASI_ENOENT,
  WASI_ENOSYS,
  WASI_ESUCCESS,
  WASI_FILETYPE_DIRECTORY,
  WASI_FILETYPE_REGULAR_FILE,
  WASI_PREOPENTYPE_DIR,
} from '../types.js';

function getImportsAndView(host: WasiHost, memory: WebAssembly.Memory) {
  const imports = host.getImports();
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  return { wasi: imports.wasi_snapshot_preview1, view, bytes };
}

describe('WasiHost', () => {
  let vfs: VFS;
  let memory: WebAssembly.Memory;
  let host: WasiHost;

  beforeEach(() => {
    vfs = new VFS();
    memory = new WebAssembly.Memory({ initial: 1 }); // 64KB
    host = new WasiHost({
      vfs,
      args: ['program', 'arg1'],
      env: { HOME: '/home/user', PATH: '/usr/bin' },
      preopens: { '/': '/' },
    });
    host.setMemory(memory);
  });

  describe('args_sizes_get', () => {
    it('returns correct argument count and buffer size', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.args_sizes_get(0, 4);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint32(0, true)).toBe(2); // argc
      // "program\0" = 8, "arg1\0" = 5, total = 13
      expect(view.getUint32(4, true)).toBe(13);
    });
  });

  describe('args_get', () => {
    it('populates argv pointers and string buffer', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);
      // argv array at 0, string buffer at 100
      const errno = wasi.args_get(0, 100);
      expect(errno).toBe(WASI_ESUCCESS);

      const ptr0 = view.getUint32(0, true);
      expect(ptr0).toBe(100);
      const arg0 = new TextDecoder().decode(bytes.slice(ptr0, ptr0 + 7));
      expect(arg0).toBe('program');

      const ptr1 = view.getUint32(4, true);
      expect(ptr1).toBe(108); // 100 + 8 ("program\0")
      const arg1 = new TextDecoder().decode(bytes.slice(ptr1, ptr1 + 4));
      expect(arg1).toBe('arg1');
    });
  });

  describe('environ_sizes_get', () => {
    it('returns correct environment variable count and buffer size', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.environ_sizes_get(0, 4);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint32(0, true)).toBe(2); // 2 env vars
      // "HOME=/home/user\0" = 16, "PATH=/usr/bin\0" = 14, total = 30
      expect(view.getUint32(4, true)).toBe(30);
    });
  });

  describe('environ_get', () => {
    it('populates environment string buffer', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);
      const errno = wasi.environ_get(0, 200);
      expect(errno).toBe(WASI_ESUCCESS);

      const ptr0 = view.getUint32(0, true);
      expect(ptr0).toBe(200);
      // Read until null terminator
      let end = ptr0;
      while (bytes[end] !== 0) end++;
      const env0 = new TextDecoder().decode(bytes.slice(ptr0, end));
      expect(env0).toBe('HOME=/home/user');
    });
  });

  describe('fd_write to stdout', () => {
    it('captures stdout output via iovec', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      // Write "hello" into memory at offset 200
      const encoded = new TextEncoder().encode('hello');
      bytes.set(encoded, 200);

      // Set up one iovec at offset 100: { buf: 200, buf_len: 5 }
      view.setUint32(100, 200, true);
      view.setUint32(104, 5, true);

      // fd_write(fd=1, iovs=100, iovs_len=1, nwritten_ptr=300)
      const errno = wasi.fd_write(1, 100, 1, 300);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint32(300, true)).toBe(5);
      expect(host.getStdout()).toBe('hello');
    });

    it('handles multiple iovecs', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      bytes.set(new TextEncoder().encode('abc'), 200);
      bytes.set(new TextEncoder().encode('def'), 210);

      // Two iovecs at offset 100
      view.setUint32(100, 200, true);
      view.setUint32(104, 3, true);
      view.setUint32(108, 210, true);
      view.setUint32(112, 3, true);

      const errno = wasi.fd_write(1, 100, 2, 300);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint32(300, true)).toBe(6);
      expect(host.getStdout()).toBe('abcdef');
    });
  });

  describe('fd_write to stderr', () => {
    it('captures stderr output', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      bytes.set(new TextEncoder().encode('error!'), 200);
      view.setUint32(100, 200, true);
      view.setUint32(104, 6, true);

      const errno = wasi.fd_write(2, 100, 1, 300);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(host.getStderr()).toBe('error!');
    });
  });

  describe('fd_write to file', () => {
    it('writes data to a VFS file via FdTable', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      // Use path_open to create a file: we need to set up the path string
      const pathStr = 'tmp/test-output.txt';
      const pathBytes = new TextEncoder().encode(pathStr);
      bytes.set(pathBytes, 500);

      // path_open(dirfd=3, dirflags=0, path=500, path_len, oflags=CREAT|TRUNC, rights_base, rights_inheriting, fdflags, fd_out)
      const errno1 = wasi.path_open(3, 0, 500, pathStr.length, 0x09, BigInt(0), BigInt(0), 0, 400);
      expect(errno1).toBe(WASI_ESUCCESS);
      const newFd = view.getUint32(400, true);

      // Write "file content" to the new fd
      const content = new TextEncoder().encode('file content');
      bytes.set(content, 200);
      view.setUint32(100, 200, true);
      view.setUint32(104, content.length, true);

      const errno2 = wasi.fd_write(newFd, 100, 1, 300);
      expect(errno2).toBe(WASI_ESUCCESS);
      expect(view.getUint32(300, true)).toBe(content.length);

      // Close flushes to VFS
      const errno3 = wasi.fd_close(newFd);
      expect(errno3).toBe(WASI_ESUCCESS);

      // Verify via VFS
      const written = new TextDecoder().decode(vfs.readFile('/tmp/test-output.txt'));
      expect(written).toBe('file content');
    });
  });

  describe('fd_read', () => {
    it('reads from a VFS file', () => {
      vfs.writeFile('/tmp/hello.txt', new TextEncoder().encode('goodbye'));
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      // Open the file
      const pathBytes = new TextEncoder().encode('tmp/hello.txt');
      bytes.set(pathBytes, 500);
      const errno1 = wasi.path_open(3, 0, 500, pathBytes.length, 0, BigInt(0), BigInt(0), 0, 400);
      expect(errno1).toBe(WASI_ESUCCESS);
      const fd = view.getUint32(400, true);

      // Set up read iovec at offset 100 pointing to buffer at 200
      view.setUint32(100, 200, true);
      view.setUint32(104, 20, true); // buf_len = 20

      const errno2 = wasi.fd_read(fd, 100, 1, 300);
      expect(errno2).toBe(WASI_ESUCCESS);
      const nread = view.getUint32(300, true);
      expect(nread).toBe(7);
      expect(new TextDecoder().decode(bytes.slice(200, 207))).toBe('goodbye');
    });
  });

  describe('fd_seek and fd_tell', () => {
    it('seeks and tells position', () => {
      vfs.writeFile('/tmp/seek.txt', new TextEncoder().encode('0123456789'));
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      // Open file
      const pathBytes = new TextEncoder().encode('tmp/seek.txt');
      bytes.set(pathBytes, 500);
      wasi.path_open(3, 0, 500, pathBytes.length, 0, BigInt(0), BigInt(0), 0, 400);
      const fd = view.getUint32(400, true);

      // Seek to offset 5
      const errno = wasi.fd_seek(fd, BigInt(5), 0, 300);
      expect(errno).toBe(WASI_ESUCCESS);
      const newPos = view.getBigUint64(300, true);
      expect(newPos).toBe(BigInt(5));

      // Tell should also return 5
      const errno2 = wasi.fd_tell(fd, 300);
      expect(errno2).toBe(WASI_ESUCCESS);
      expect(view.getBigUint64(300, true)).toBe(BigInt(5));
    });
  });

  describe('fd_close', () => {
    it('returns EBADF for invalid fd', () => {
      const { wasi } = getImportsAndView(host, memory);
      const errno = wasi.fd_close(99);
      expect(errno).toBe(WASI_EBADF);
    });
  });

  describe('clock_time_get', () => {
    it('returns a nanosecond timestamp for realtime clock', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.clock_time_get(0, BigInt(0), 100);
      expect(errno).toBe(WASI_ESUCCESS);
      const timestamp = view.getBigUint64(100, true);
      expect(timestamp).toBeGreaterThan(BigInt(0));
    });

    it('returns a nanosecond timestamp for monotonic clock', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.clock_time_get(1, BigInt(0), 100);
      expect(errno).toBe(WASI_ESUCCESS);
      const timestamp = view.getBigUint64(100, true);
      expect(timestamp).toBeGreaterThan(BigInt(0));
    });
  });

  describe('random_get', () => {
    it('fills buffer with random bytes', () => {
      const { wasi, bytes } = getImportsAndView(host, memory);
      bytes.fill(0, 100, 116);
      const errno = wasi.random_get(100, 16);
      expect(errno).toBe(WASI_ESUCCESS);
      const filled = bytes.slice(100, 116);
      expect(filled.some(b => b !== 0)).toBe(true);
    });
  });

  describe('proc_exit', () => {
    it('records exit code and throws WasiExitError', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(() => wasi.proc_exit(42)).toThrow();
      expect(host.getExitCode()).toBe(42);
    });

    it('records zero exit code', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(() => wasi.proc_exit(0)).toThrow();
      expect(host.getExitCode()).toBe(0);
    });
  });

  describe('fd_prestat_get', () => {
    it('returns preopened dir info for fd 3', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.fd_prestat_get(3, 100);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint8(100)).toBe(WASI_PREOPENTYPE_DIR);
      // name length for "/" = 1
      expect(view.getUint32(104, true)).toBe(1);
    });

    it('returns EBADF for non-preopened fd', () => {
      const { wasi } = getImportsAndView(host, memory);
      const errno = wasi.fd_prestat_get(99, 100);
      expect(errno).toBe(WASI_EBADF);
    });

    it('returns EBADF for stdio fds', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(wasi.fd_prestat_get(0, 100)).toBe(WASI_EBADF);
      expect(wasi.fd_prestat_get(1, 100)).toBe(WASI_EBADF);
      expect(wasi.fd_prestat_get(2, 100)).toBe(WASI_EBADF);
    });
  });

  describe('fd_prestat_dir_name', () => {
    it('writes the preopened dir path to memory', () => {
      const { wasi, bytes } = getImportsAndView(host, memory);
      const errno = wasi.fd_prestat_dir_name(3, 100, 1);
      expect(errno).toBe(WASI_ESUCCESS);
      const name = new TextDecoder().decode(bytes.slice(100, 101));
      expect(name).toBe('/');
    });
  });

  describe('fd_fdstat_get', () => {
    it('returns character device type for stdout', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.fd_fdstat_get(1, 100);
      expect(errno).toBe(WASI_ESUCCESS);
      // first byte is filetype: CHARACTER_DEVICE = 2
      expect(view.getUint8(100)).toBe(2);
    });

    it('returns directory type for preopened dir', () => {
      const { wasi, view } = getImportsAndView(host, memory);
      const errno = wasi.fd_fdstat_get(3, 100);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint8(100)).toBe(WASI_FILETYPE_DIRECTORY);
    });
  });

  describe('path_open', () => {
    it('opens an existing file for reading', () => {
      vfs.writeFile('/tmp/data.txt', new TextEncoder().encode('content'));
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/data.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_open(3, 0, 500, pathStr.length, 0, BigInt(0), BigInt(0), 0, 400);
      expect(errno).toBe(WASI_ESUCCESS);
      const fd = view.getUint32(400, true);
      expect(fd).toBeGreaterThanOrEqual(4);
    });

    it('creates a new file with CREAT flag', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/new-file.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      // oflags = CREAT (1) | TRUNC (8) = 9
      const errno = wasi.path_open(3, 0, 500, pathStr.length, 9, BigInt(0), BigInt(0), 0, 400);
      expect(errno).toBe(WASI_ESUCCESS);
      const fd = view.getUint32(400, true);
      expect(fd).toBeGreaterThanOrEqual(4);
    });

    it('applies the kernel process umask when creating files', () => {
      const kernel = new ProcessKernel();
      const pid = kernel.allocPid(1, 'guest');
      kernel.setUmask(pid, 0o077);
      host = new WasiHost({
        vfs,
        args: ['program'],
        env: {},
        preopens: { '/': '/' },
        kernel,
        pid,
      });
      host.setMemory(memory);
      const { wasi, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/umask-created.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_open(3, 0, 500, pathStr.length, 9, BigInt(0), BigInt(0), 0, 400);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(vfs.stat('/tmp/umask-created.txt').permissions).toBe(0o600);
    });

    it('enforces RLIMIT_NOFILE from the kernel process state', () => {
      const kernel = new ProcessKernel();
      const pid = kernel.allocPid(1, 'guest');
      kernel.setResourceLimit(pid, 7, 4, 1024);
      host = new WasiHost({
        vfs,
        args: ['program'],
        env: {},
        preopens: { '/': '/' },
        kernel,
        pid,
      });
      host.setMemory(memory);
      vfs.writeFile('/tmp/limit.txt', new TextEncoder().encode('content'));
      const { wasi, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/limit.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_open(3, 0, 500, pathStr.length, 0, BigInt(0), BigInt(0), 0, 400);
      expect(errno).toBe(WASI_EMFILE);
    });

    it('returns ENOENT for non-existent file without CREAT', () => {
      const { wasi, bytes } = getImportsAndView(host, memory);

      const pathStr = 'nope.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_open(3, 0, 500, pathStr.length, 0, BigInt(0), BigInt(0), 0, 400);
      expect(errno).toBe(WASI_ENOENT);
    });

    it('resolves root-preopen relative paths from process cwd', () => {
      vfs.mkdir('/tmp/std-process-cwd');
      vfs.writeFile('/tmp/std-process-cwd/marker.txt', new TextEncoder().encode('cwd-ok'));
      const cwdHost = new WasiHost({
        vfs,
        args: ['program'],
        env: {},
        preopens: { '/': '/' },
        cwd: '/tmp/std-process-cwd',
      });
      cwdHost.setMemory(memory);
      const { wasi, view, bytes } = getImportsAndView(cwdHost, memory);

      const pathStr = 'marker.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_open(3, 0, 500, pathStr.length, 0, BigInt(0), BigInt(0), 0, 400);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint32(400, true)).toBeGreaterThanOrEqual(4);
    });
  });

  describe('path_create_directory', () => {
    it('creates a directory', () => {
      const { wasi, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/newdir';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_create_directory(3, 500, pathStr.length);
      expect(errno).toBe(WASI_ESUCCESS);

      const stat = vfs.stat('/tmp/newdir');
      expect(stat.type).toBe('dir');
    });
  });

  describe('path_remove_directory', () => {
    it('removes an empty directory', () => {
      vfs.mkdir('/tmp/removeme');
      const { wasi, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/removeme';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_remove_directory(3, 500, pathStr.length);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(() => vfs.stat('/tmp/removeme')).toThrow();
    });
  });

  describe('path_unlink_file', () => {
    it('removes a file', () => {
      vfs.writeFile('/tmp/delete-me.txt', new Uint8Array(0));
      const { wasi, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/delete-me.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_unlink_file(3, 500, pathStr.length);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(() => vfs.stat('/tmp/delete-me.txt')).toThrow();
    });
  });

  describe('path_rename', () => {
    it('renames a file', () => {
      vfs.writeFile('/tmp/old-name.txt', new TextEncoder().encode('data'));
      const { wasi, bytes } = getImportsAndView(host, memory);

      const oldPath = 'tmp/old-name.txt';
      const newPath = 'tmp/new-name.txt';
      bytes.set(new TextEncoder().encode(oldPath), 500);
      bytes.set(new TextEncoder().encode(newPath), 600);

      const errno = wasi.path_rename(3, 500, oldPath.length, 3, 600, newPath.length);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(() => vfs.stat('/tmp/old-name.txt')).toThrow();
      const content = new TextDecoder().decode(vfs.readFile('/tmp/new-name.txt'));
      expect(content).toBe('data');
    });
  });

  describe('path_filestat_get', () => {
    it('returns stat info for a file', () => {
      vfs.writeFile('/tmp/stat-me.txt', new TextEncoder().encode('12345'));
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      const pathStr = 'tmp/stat-me.txt';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_filestat_get(3, 0, 500, pathStr.length, 100);
      expect(errno).toBe(WASI_ESUCCESS);
      // Offset 16 = filetype (1 byte at offset 16 in filestat structure)
      // filestat layout: dev(8) + ino(8) + filetype(1)
      expect(view.getUint8(116)).toBe(WASI_FILETYPE_REGULAR_FILE);
      // size at offset 32 (dev:8 + ino:8 + filetype:1+padding:7 + nlink:8 + size:8)
      const size = view.getBigUint64(132, true);
      expect(size).toBe(BigInt(5));
    });

    it('returns stat info for a directory', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      const pathStr = 'home';
      bytes.set(new TextEncoder().encode(pathStr), 500);

      const errno = wasi.path_filestat_get(3, 0, 500, pathStr.length, 100);
      expect(errno).toBe(WASI_ESUCCESS);
      expect(view.getUint8(116)).toBe(WASI_FILETYPE_DIRECTORY);
    });
  });

  describe('fd_readdir', () => {
    it('lists directory entries', () => {
      vfs.writeFile('/home/user/a.txt', new Uint8Array(0));
      vfs.writeFile('/home/user/b.txt', new Uint8Array(0));

      const { wasi, view, bytes } = getImportsAndView(host, memory);

      // Open /home/user as a directory
      const pathStr = 'home/user';
      bytes.set(new TextEncoder().encode(pathStr), 500);
      wasi.path_open(3, 0, 500, pathStr.length, 2, BigInt(0), BigInt(0), 0, 400);
      const dirFd = view.getUint32(400, true);

      // Read directory entries: fd_readdir(fd, buf, buf_len, cookie, bufused_ptr)
      const errno = wasi.fd_readdir(dirFd, 1000, 4096, BigInt(0), 900);
      expect(errno).toBe(WASI_ESUCCESS);
      const bufused = view.getUint32(900, true);
      expect(bufused).toBeGreaterThan(0);
    });
  });

  describe('sched_yield', () => {
    it('returns ESUCCESS', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(wasi.sched_yield()).toBe(WASI_ESUCCESS);
    });
  });

  describe('safe no-op stubs return ESUCCESS', () => {
    it('fd_advise returns ESUCCESS', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(wasi.fd_advise(3, BigInt(0), BigInt(0), 0)).toBe(WASI_ESUCCESS);
    });

    it('fd_allocate returns ESUCCESS', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(wasi.fd_allocate(3, BigInt(0), BigInt(0))).toBe(WASI_ESUCCESS);
    });
  });

  describe('unsupported stubs return ENOSYS', () => {
    it('sock_accept returns ENOSYS', () => {
      const { wasi } = getImportsAndView(host, memory);
      expect(wasi.sock_accept(3, 0, 0)).toBe(WASI_ENOSYS);
    });
  });

  describe('getStdout and getStderr', () => {
    it('accumulates multiple writes', () => {
      const { wasi, view, bytes } = getImportsAndView(host, memory);

      bytes.set(new TextEncoder().encode('one'), 200);
      view.setUint32(100, 200, true);
      view.setUint32(104, 3, true);
      wasi.fd_write(1, 100, 1, 300);

      bytes.set(new TextEncoder().encode('two'), 200);
      view.setUint32(100, 200, true);
      view.setUint32(104, 3, true);
      wasi.fd_write(1, 100, 1, 300);

      expect(host.getStdout()).toBe('onetwo');
    });
  });
});
