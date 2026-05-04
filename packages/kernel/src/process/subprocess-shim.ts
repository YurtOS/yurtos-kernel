/**
 * Python source for /usr/lib/python/subprocess.py — subprocess shim for the
 * WASI sandbox. Routes execution through _yurt.spawn() which calls back
 * into the TypeScript host via host_run_command.
 *
 * Also patches os.popen at module level so code using os.popen works without
 * an explicit `import subprocess`.
 */
export const SUBPROCESS_PY_SOURCE = `\
"""subprocess shim for yurt WASI — routes via _yurt.spawn()."""
import _yurt
import io
import shlex

PIPE = -1
DEVNULL = -2
STDOUT = -3


class CalledProcessError(Exception):
    def __init__(self, returncode, cmd, output=None, stderr=None):
        self.returncode = returncode
        self.cmd = cmd
        self.output = output
        self.stdout = output
        self.stderr = stderr

    def __str__(self):
        return f"Command '{self.cmd}' returned non-zero exit status {self.returncode}"


class TimeoutExpired(Exception):
    pass


class CompletedProcess:
    def __init__(self, args, returncode, stdout=None, stderr=None):
        self.args = args
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr

    def check_returncode(self):
        if self.returncode:
            raise CalledProcessError(self.returncode, self.args, self.stdout, self.stderr)

    def __repr__(self):
        return (
            f"CompletedProcess(args={self.args!r}, returncode={self.returncode!r}, "
            f"stdout={self.stdout!r}, stderr={self.stderr!r})"
        )


def _invoke(cmd, stdin=''):
    """Run cmd via the host shell."""
    r = _yurt.spawn(cmd, stdin)
    return r.get('exit_code', 0), r.get('stdout', ''), r.get('stderr', '')


def run(args, *, stdin=None, stdout=None, stderr=None, capture_output=False,
        text=False, shell=False, input=None, check=False, env=None, cwd=None,
        timeout=None, encoding=None, errors=None, **_kwargs):
    is_text = text or encoding is not None

    if isinstance(args, (list, tuple)):
        cmd_str = shlex.join(str(a) for a in args)
    else:
        cmd_str = str(args)

    stdin_str = ''
    if input is not None:
        stdin_str = input.decode('utf-8', errors='replace') if isinstance(input, bytes) else str(input)
    elif stdin not in (None, PIPE, DEVNULL) and hasattr(stdin, 'read'):
        stdin_str = stdin.read()
    elif isinstance(stdin, (str, bytes)):
        stdin_str = stdin.decode('utf-8', errors='replace') if isinstance(stdin, bytes) else stdin

    exit_code, out_str, err_str = _invoke(cmd_str, stdin_str)

    cap_out = capture_output or stdout == PIPE
    cap_err = capture_output or stderr == PIPE

    if stderr == STDOUT:
        out_str = out_str + err_str
        err_str = ''
        cap_err = False

    if is_text:
        out = out_str if cap_out else None
        err = err_str if cap_err else None
    else:
        out = out_str.encode() if cap_out else None
        err = err_str.encode() if cap_err else None

    if not cap_out and stdout not in (None, PIPE, DEVNULL):
        import sys
        print(out_str, end='', file=sys.stdout)
    if not cap_err and stderr not in (None, PIPE, DEVNULL, STDOUT):
        import sys
        print(err_str, end='', file=sys.stderr)

    result = CompletedProcess(args, exit_code, stdout=out, stderr=err)
    if check:
        result.check_returncode()
    return result


def check_output(args, *, stderr=None, **kwargs):
    kwargs.pop('stdout', None)
    return run(args, stdout=PIPE, stderr=stderr, check=True, **kwargs).stdout


def check_call(args, **kwargs):
    run(args, check=True, **kwargs)
    return 0


def call(args, **kwargs):
    return run(args, **kwargs).returncode


def getoutput(cmd):
    return run(cmd, shell=True, stdout=PIPE, stderr=STDOUT, text=True).stdout


def getstatusoutput(cmd):
    r = run(cmd, shell=True, stdout=PIPE, stderr=STDOUT, text=True)
    return r.returncode, r.stdout.rstrip('\\n')


class Popen:
    """Minimal non-streaming Popen — runs the command eagerly on __init__."""

    def __init__(self, args, bufsize=-1, executable=None, stdin=None,
                 stdout=None, stderr=None, close_fds=True, shell=False,
                 cwd=None, env=None, universal_newlines=False, text=False,
                 encoding=None, errors=None, **_kwargs):
        self._text = text or universal_newlines or encoding is not None
        cap_out = stdout == PIPE
        cap_err = stderr == PIPE

        if isinstance(args, (list, tuple)):
            cmd_str = shlex.join(str(a) for a in args)
        else:
            cmd_str = str(args)

        stdin_str = ''
        if isinstance(stdin, str):
            stdin_str = stdin
        elif isinstance(stdin, bytes):
            stdin_str = stdin.decode('utf-8', errors='replace')

        self.returncode, self._out, self._err = _invoke(cmd_str, stdin_str)
        self.pid = -1
        self.stdin = None
        self._cap_out = cap_out
        self._cap_err = cap_err

        if cap_out:
            self.stdout = io.StringIO(self._out) if self._text else io.BytesIO(self._out.encode())
        else:
            self.stdout = None
        if cap_err:
            self.stderr = io.StringIO(self._err) if self._text else io.BytesIO(self._err.encode())
        else:
            self.stderr = None

    def communicate(self, input=None, timeout=None):
        out = (self._out if self._text else self._out.encode()) if self._cap_out else None
        err = (self._err if self._text else self._err.encode()) if self._cap_err else None
        return out, err

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        pass

    def terminate(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


# Patch os.popen so code using it without importing subprocess works.
try:
    import os as _os

    def _popen_shim(cmd, mode='r', buffering=-1):
        r = run(cmd, shell=True, capture_output=True, text=True)
        return io.StringIO(r.stdout)

    _os.popen = _popen_shim
except Exception:
    pass
`;
