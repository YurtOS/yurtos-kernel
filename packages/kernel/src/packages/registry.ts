import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import type { PackageMetadata } from './types';

/** Recursively collect .py files from a directory. */
function collectPyFiles(dir: string, prefix: string): Record<string, string> {
  const files: Record<string, string> = {};
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        Object.assign(files, collectPyFiles(full, prefix));
      } else if (entry.name.endsWith('.py')) {
        const relPath = relative(prefix, full);
        files[relPath] = readFileSync(full, 'utf-8');
      }
    }
  } catch {
    // Directory not found — package files not available (e.g. browser environment)
  }
  return files;
}

/** Root of the packages/ directory (two levels up from packages/kernel/src/packages/). */
const PACKAGES_ROOT = resolve(import.meta.dirname!, '..', '..', '..');

const PACKAGES: PackageMetadata[] = [
  {
    name: 'requests',
    version: '2.31.0',
    summary: 'HTTP library (wrapper over urllib.request)',
    dependencies: [],
    native: false,
    pythonFiles: {
      'requests/__init__.py': `"""
requests - HTTP library for Python (minimal urllib.request wrapper)
"""

__version__ = "2.31.0"

from requests.exceptions import (
    RequestException,
    HTTPError,
    ConnectionError,
    Timeout,
)
from requests.models import Response
from requests.sessions import Session
from requests.api import (
    request,
    get,
    post,
    put,
    delete,
    head,
    patch,
)
`,
      'requests/exceptions.py': `"""
requests.exceptions
~~~~~~~~~~~~~~~~~~~

Exception classes for the requests library.
"""


class RequestException(IOError):
    """Base exception for requests."""

    def __init__(self, *args, response=None, **kwargs):
        self.response = response
        super().__init__(*args, **kwargs)


class HTTPError(RequestException):
    """HTTP error (status >= 400)."""
    pass


class ConnectionError(RequestException):
    """Connection error."""
    pass


class Timeout(RequestException):
    """Request timed out."""
    pass
`,
      'requests/models.py': `"""
requests.models
~~~~~~~~~~~~~~~

Response model for the requests library.
"""

import json as _json
from requests.exceptions import HTTPError


class Response:
    """Minimal Response object compatible with the requests library API."""

    def __init__(self):
        self.status_code = None
        self.headers = {}
        self.content = b""
        self.url = ""
        self.encoding = "utf-8"
        self._text = None

    @property
    def ok(self):
        return self.status_code is not None and self.status_code < 400

    @property
    def text(self):
        if self._text is None:
            self._text = self.content.decode(self.encoding or "utf-8", errors="replace")
        return self._text

    def json(self, **kwargs):
        return _json.loads(self.text, **kwargs)

    def raise_for_status(self):
        if self.status_code is not None and self.status_code >= 400:
            raise HTTPError(
                f"{self.status_code} Error for url: {self.url}",
                response=self,
            )

    def __repr__(self):
        return f"<Response [{self.status_code}]>"
`,
      'requests/api.py': `"""
requests.api
~~~~~~~~~~~~

Core API functions wrapping urllib.request.
All urllib imports are deferred to call time so the module can be
imported even when the _socket C extension is not available (e.g. WASM).
"""

import json as _json

from requests.models import Response
from requests.exceptions import (
    RequestException,
    HTTPError,
    ConnectionError,
    Timeout,
)


def request(method, url, **kwargs):
    """Send an HTTP request.

    Args:
        method: HTTP method (GET, POST, PUT, DELETE, HEAD, PATCH).
        url: URL to send the request to.
        **kwargs: Optional arguments:
            params: dict of query string parameters.
            data: body as str, bytes, or dict (url-encoded if dict).
            json: body as dict/list (JSON-encoded, sets Content-Type).
            headers: dict of HTTP headers.
            timeout: request timeout in seconds.

    Returns:
        Response object.
    """
    # Lazy imports -- urllib.request pulls in socket which needs _socket
    from urllib.request import Request, urlopen
    from urllib.parse import urlencode
    from urllib.error import HTTPError as _HTTPError, URLError as _URLError

    params = kwargs.get("params")
    data = kwargs.get("data")
    json_body = kwargs.get("json")
    headers = dict(kwargs.get("headers") or {})
    timeout = kwargs.get("timeout")

    # Append query string parameters
    if params:
        sep = "&" if "?" in url else "?"
        url = url + sep + urlencode(params)

    # Prepare body
    body = None
    if json_body is not None:
        body = _json.dumps(json_body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    elif data is not None:
        if isinstance(data, dict):
            body = urlencode(data).encode("utf-8")
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        elif isinstance(data, str):
            body = data.encode("utf-8")
        else:
            body = data

    req = Request(url, data=body, headers=headers, method=method.upper())

    resp = Response()
    resp.url = url

    try:
        timeout_args = {"timeout": timeout} if timeout is not None else {}
        http_resp = urlopen(req, **timeout_args)
        resp.status_code = http_resp.status
        resp.headers = dict(http_resp.headers)
        resp.content = http_resp.read()
        # Detect encoding from Content-Type header
        ct = resp.headers.get("Content-Type", "")
        if "charset=" in ct:
            resp.encoding = ct.split("charset=")[-1].split(";")[0].strip()
    except _HTTPError as e:
        resp.status_code = e.code
        resp.headers = dict(e.headers)
        resp.content = e.read()
    except _URLError as e:
        raise ConnectionError(str(e.reason), response=None) from e
    except Exception as e:
        if "timed out" in str(e).lower():
            raise Timeout(str(e), response=None) from e
        raise RequestException(str(e), response=None) from e

    return resp


def get(url, **kwargs):
    """Send a GET request."""
    return request("GET", url, **kwargs)


def post(url, **kwargs):
    """Send a POST request."""
    return request("POST", url, **kwargs)


def put(url, **kwargs):
    """Send a PUT request."""
    return request("PUT", url, **kwargs)


def delete(url, **kwargs):
    """Send a DELETE request."""
    return request("DELETE", url, **kwargs)


def head(url, **kwargs):
    """Send a HEAD request."""
    return request("HEAD", url, **kwargs)


def patch(url, **kwargs):
    """Send a PATCH request."""
    return request("PATCH", url, **kwargs)
`,
      'requests/sessions.py': `"""
requests.sessions
~~~~~~~~~~~~~~~~~

Minimal Session class for the requests library.
"""

from requests import api


class Session:
    """Minimal Session that merges default headers into each request."""

    def __init__(self):
        self.headers = {}

    def request(self, method, url, **kwargs):
        # Merge session headers with per-request headers
        merged = dict(self.headers)
        if "headers" in kwargs and kwargs["headers"]:
            merged.update(kwargs["headers"])
        kwargs["headers"] = merged
        return api.request(method, url, **kwargs)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def put(self, url, **kwargs):
        return self.request("PUT", url, **kwargs)

    def delete(self, url, **kwargs):
        return self.request("DELETE", url, **kwargs)

    def head(self, url, **kwargs):
        return self.request("HEAD", url, **kwargs)

    def patch(self, url, **kwargs):
        return self.request("PATCH", url, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass
`,
    },
  },
  {
    name: 'numpy',
    version: '1.26.0',
    summary: 'Numerical computing (ndarray-backed)',
    dependencies: [],
    native: true,
    pythonFiles: {},
    pythonDir: 'numpy-rust/python',
    pythonDirPrefix: 'numpy-rust/python',
  },
  {
    name: 'pandas',
    version: '2.1.0',
    summary: 'Data analysis (calamine + xlsxwriter backed)',
    dependencies: ['numpy'],
    native: true,
    pythonFiles: {
      'pandas/__init__.py': '# placeholder - real impl in Task 9\n',
    },
  },
  {
    name: 'PIL',
    version: '10.0.0',
    summary: 'Image processing (image crate-backed)',
    dependencies: [],
    native: true,
    pythonFiles: {},
    pythonDir: 'pillow-rust/python',
    pythonDirPrefix: 'pillow-rust/python',
  },
  {
    name: 'matplotlib',
    version: '3.8.0',
    summary: 'Plotting (SVG + PIL backend)',
    dependencies: ['numpy', 'PIL'],
    native: false,
    pythonFiles: {},
    pythonDir: 'matplotlib-py/python',
    pythonDirPrefix: 'matplotlib-py/python',
  },
  {
    name: 'sklearn',
    version: '1.3.0',
    summary: 'Machine learning (linfa-backed)',
    dependencies: ['numpy'],
    native: true,
    pythonFiles: {
      'sklearn/__init__.py': '# placeholder - real impl in Task 11\n',
    },
  },
  {
    name: 'sqlite3',
    version: '3.49.0',
    summary: 'SQLite database (C FFI backed)',
    dependencies: [],
    native: true,
    // No pythonFiles needed: the native _sqlite3 module is provided by the
    // WASM binary and the frozen stdlib sqlite3 package imports from it.
    pythonFiles: {},
  },
];

export class PackageRegistry {
  private packages = new Map<string, PackageMetadata>();

  constructor() {
    for (const pkg of PACKAGES) {
      // Load Python files from directory if pythonDir is set
      if (pkg.pythonDir && Object.keys(pkg.pythonFiles).length === 0) {
        const dir = resolve(PACKAGES_ROOT, pkg.pythonDir);
        const prefix = resolve(PACKAGES_ROOT, pkg.pythonDirPrefix ?? pkg.pythonDir);
        pkg.pythonFiles = collectPyFiles(dir, prefix);
      }
      this.packages.set(pkg.name, pkg);
    }
  }

  available(): string[] {
    return [...this.packages.keys()].sort();
  }

  get(name: string): PackageMetadata | undefined {
    return this.packages.get(name);
  }

  has(name: string): boolean {
    return this.packages.has(name);
  }

  /** Returns the package + all transitive dependencies, topologically sorted */
  resolveDeps(name: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visit = (n: string) => {
      if (visited.has(n)) return;
      visited.add(n);
      const pkg = this.packages.get(n);
      if (!pkg) return;
      for (const dep of pkg.dependencies) {
        visit(dep);
      }
      result.push(n);
    };
    visit(name);
    return result;
  }
}
