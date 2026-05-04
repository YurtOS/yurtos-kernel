"""
Wasmsand socket shim (full mode) — proxies to _yurt.socket_*() syscalls.

Replaces the standard socket module. Unlike socket_fetch.py (which buffers
entire HTTP requests and routes through fetch), this shim creates real TCP/TLS
connections via the host's socket bridge. Supports arbitrary protocols.
"""

import _yurt

# Constants expected by http.client, urllib3, asyncio, etc.
AF_INET = 2
AF_INET6 = 10
AF_UNSPEC = 0
SOCK_STREAM = 1
SOCK_DGRAM = 2
SOCK_RAW = 3
IPPROTO_TCP = 6
IPPROTO_UDP = 17
IPPROTO_IP = 0
SOL_SOCKET = 1
SOL_TCP = 6
SO_KEEPALIVE = 9
SO_REUSEADDR = 2
SO_ERROR = 4
TCP_NODELAY = 1
SHUT_RDWR = 2
MSG_DONTWAIT = 64
MSG_PEEK = 2
AI_PASSIVE = 1
AI_CANONNAME = 2
AI_NUMERICHOST = 4
AI_NUMERICSERV = 1024
NI_NUMERICHOST = 1
NI_NUMERICSERV = 2
EAI_NONAME = -2
SOMAXCONN = 128
has_ipv6 = True
_GLOBAL_DEFAULT_TIMEOUT = object()
timeout = OSError
error = OSError
herror = OSError
gaierror = OSError


def create_connection(address, timeout=_GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    sock = socket(AF_INET, SOCK_STREAM)
    if timeout is not _GLOBAL_DEFAULT_TIMEOUT and timeout is not None:
        sock.settimeout(timeout)
    sock.connect((host, port))
    return sock


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if isinstance(port, str):
        port = int(port) if port else 0
    results = []
    if family == 0 or family == AF_INET:
        results.append((AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80)))
    if family == 0 or family == AF_INET6:
        results.append((AF_INET6, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80)))
    return results if results else [(AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port or 80))]


def getfqdn(name=''):
    return name or 'localhost'


def gethostname():
    return 'localhost'


def gethostbyname(hostname):
    return '127.0.0.1'


def inet_aton(ip_string):
    parts = ip_string.split('.')
    return bytes(int(p) for p in parts)


def inet_ntoa(packed_ip):
    return '.'.join(str(b) for b in packed_ip)


def getnameinfo(sockaddr, flags):
    host, port = sockaddr[:2]
    return (str(host), str(port))


class socket:
    """Socket that proxies to host via _yurt.socket_*() syscalls."""

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self._family = family
        self._type = type
        self._host = None
        self._port = None
        self._timeout = None
        self._closed = False
        self._socket_id = None  # assigned on connect
        self._tls = False

    @property
    def family(self):
        return self._family

    @property
    def type(self):
        return self._type

    def connect(self, address):
        host, port = address
        if isinstance(port, str):
            port = int(port)
        self._host = host
        self._port = port
        self._socket_id = _yurt.socket_connect(host, port, self._tls)

    def connect_ex(self, address):
        try:
            self.connect(address)
            return 0
        except Exception:
            return 1

    def sendall(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        if isinstance(data, str):
            data = data.encode('utf-8')
        view = data
        while len(view) > 0:
            sent = _yurt.socket_send(self._socket_id, view)
            if sent <= 0:
                raise OSError("socket send failed")
            view = view[sent:]

    def send(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        if isinstance(data, str):
            data = data.encode('utf-8')
        return _yurt.socket_send(self._socket_id, data)

    def recv(self, bufsize):
        if self._socket_id is None:
            return b""
        return _yurt.socket_recv(self._socket_id, bufsize)

    def recv_into(self, buffer, nbytes=0):
        data = self.recv(nbytes or len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def makefile(self, mode="r", buffering=-1, **kwargs):
        return _SocketFile(self, mode)

    def settimeout(self, timeout):
        self._timeout = timeout

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self._timeout = None if flag else 0.0

    def setsockopt(self, *args):
        pass

    def getsockopt(self, *args):
        return 0

    def getpeername(self):
        return (self._host, self._port)

    def fileno(self):
        return -1

    def close(self):
        if not self._closed:
            self._closed = True
            if self._socket_id is not None:
                try:
                    _yurt.socket_close(self._socket_id)
                except Exception:
                    pass
                self._socket_id = None

    def shutdown(self, how):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class _SocketFile:
    """File-like wrapper returned by socket.makefile() — used by http.client."""

    def __init__(self, sock, mode):
        self._sock = sock
        self._mode = mode
        self._buf = b""
        self.closed = False

    def read(self, n=-1):
        if n is None or n < 0:
            # Read until EOF
            chunks = [self._buf]
            self._buf = b""
            while True:
                data = self._sock.recv(65536)
                if not data:
                    break
                chunks.append(data)
            return b"".join(chunks)
        # Read exactly n bytes
        while len(self._buf) < n:
            data = self._sock.recv(n - len(self._buf))
            if not data:
                break
            self._buf += data
        result = self._buf[:n]
        self._buf = self._buf[n:]
        return result

    def read1(self, n=-1):
        if n is None or n < 0:
            n = 65536
        if self._buf:
            result = self._buf[:n]
            self._buf = self._buf[n:]
            return result
        return self._sock.recv(n)

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)

    def readline(self, limit=-1):
        while True:
            idx = self._buf.find(b"\n")
            if idx >= 0:
                if limit > 0 and idx >= limit:
                    line = self._buf[:limit]
                    self._buf = self._buf[limit:]
                else:
                    line = self._buf[:idx + 1]
                    self._buf = self._buf[idx + 1:]
                return line
            if limit > 0 and len(self._buf) >= limit:
                line = self._buf[:limit]
                self._buf = self._buf[limit:]
                return line
            data = self._sock.recv(4096)
            if not data:
                line = self._buf
                self._buf = b""
                return line
            self._buf += data

    def readlines(self, hint=-1):
        lines = []
        while True:
            line = self.readline()
            if not line:
                break
            lines.append(line)
        return lines

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self._sock.sendall(data)
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.closed = True

    def readable(self):
        return "r" in self._mode or "b" in self._mode

    def writable(self):
        return "w" in self._mode

    def seekable(self):
        return False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __iter__(self):
        return self

    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line
