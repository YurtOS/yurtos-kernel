"""
Lightweight requests-compatible HTTP library for the yurt sandbox.

Routes all HTTP traffic through the sandbox's network gateway via the
socket shim (_yurt.fetch). Provides the subset of the requests API
that LLMs most commonly generate:

    import requests
    r = requests.get("https://api.example.com/data")
    r = requests.post(url, json={"key": "value"})
    r = requests.get(url, headers={"Authorization": "Bearer ..."})

Supports: get, post, put, patch, delete, head, options, request.
Response: status_code, text, json(), headers, ok, content, url,
          raise_for_status().
"""

import json as _json

try:
    import _yurt
except ImportError:
    _yurt = None


class Response:
    """HTTP response object compatible with requests.Response."""

    def __init__(self, status_code, headers, text, url=""):
        self.status_code = status_code
        self.headers = CaseInsensitiveDict(headers)
        self.text = text
        self.url = url
        self.encoding = "utf-8"
        self.reason = _status_reason(status_code)

    @property
    def ok(self):
        return 200 <= self.status_code < 400

    @property
    def content(self):
        return self.text.encode(self.encoding or "utf-8")

    def json(self, **kwargs):
        return _json.loads(self.text, **kwargs)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise HTTPError(
                f"{self.status_code} {self.reason}: {self.url}",
                response=self,
            )

    def __repr__(self):
        return f"<Response [{self.status_code}]>"


class HTTPError(IOError):
    """HTTP error with attached response."""

    def __init__(self, message, response=None):
        super().__init__(message)
        self.response = response


class ConnectionError(IOError):
    """Network connection error."""
    pass


class Timeout(IOError):
    """Request timed out."""
    pass


class RequestException(IOError):
    """Base exception for requests errors."""
    pass


class CaseInsensitiveDict(dict):
    """Dictionary with case-insensitive key lookup."""

    def __init__(self, data=None, **kwargs):
        super().__init__()
        self._store = {}
        if data:
            if isinstance(data, dict):
                for k, v in data.items():
                    self[k] = v
            else:
                for k, v in data:
                    self[k] = v
        for k, v in kwargs.items():
            self[k] = v

    def __setitem__(self, key, value):
        self._store[key.lower()] = (key, value)

    def __getitem__(self, key):
        return self._store[key.lower()][1]

    def __contains__(self, key):
        return key.lower() in self._store

    def __delitem__(self, key):
        del self._store[key.lower()]

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def keys(self):
        return [v[0] for v in self._store.values()]

    def values(self):
        return [v[1] for v in self._store.values()]

    def items(self):
        return [(v[0], v[1]) for v in self._store.values()]

    def __iter__(self):
        return iter(self.keys())

    def __len__(self):
        return len(self._store)

    def __repr__(self):
        return str(dict(self.items()))


class Session:
    """Session with persistent headers and cookies (simplified)."""

    def __init__(self):
        self.headers = CaseInsensitiveDict()

    def request(self, method, url, **kwargs):
        merged_headers = CaseInsensitiveDict(self.headers)
        if "headers" in kwargs and kwargs["headers"]:
            for k, v in kwargs["headers"].items():
                merged_headers[k] = v
        kwargs["headers"] = dict(merged_headers.items())
        return request(method, url, **kwargs)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def put(self, url, **kwargs):
        return self.request("PUT", url, **kwargs)

    def patch(self, url, **kwargs):
        return self.request("PATCH", url, **kwargs)

    def delete(self, url, **kwargs):
        return self.request("DELETE", url, **kwargs)

    def head(self, url, **kwargs):
        return self.request("HEAD", url, **kwargs)

    def options(self, url, **kwargs):
        return self.request("OPTIONS", url, **kwargs)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


# ---------------------------------------------------------------------------
# Core request function
# ---------------------------------------------------------------------------


def request(method, url, **kwargs):
    """Send an HTTP request.

    Parameters
    ----------
    method : str
        HTTP method (GET, POST, PUT, DELETE, etc.)
    url : str
        Request URL.
    params : dict, optional
        Query parameters appended to URL.
    headers : dict, optional
        HTTP headers.
    data : str or bytes, optional
        Request body (form-encoded or raw).
    json : dict or list, optional
        JSON body (sets Content-Type automatically).
    timeout : float, optional
        Request timeout in seconds (informational only).

    Returns
    -------
    Response
    """
    headers = dict(kwargs.get("headers") or {})
    params = kwargs.get("params")
    data = kwargs.get("data")
    json_body = kwargs.get("json")

    # Build URL with query parameters
    if params:
        qs = "&".join(
            f"{_quote(str(k))}={_quote(str(v))}" for k, v in params.items()
        )
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{qs}"

    # Auto-prepend https if no scheme
    if not url.startswith("http://") and not url.startswith("https://"):
        url = f"https://{url}"

    # Handle JSON body
    body = None
    if json_body is not None:
        body = _json.dumps(json_body)
        headers.setdefault("Content-Type", "application/json")
    elif data is not None:
        if isinstance(data, bytes):
            body = data.decode("utf-8", errors="replace")
        elif isinstance(data, dict):
            body = "&".join(
                f"{_quote(str(k))}={_quote(str(v))}" for k, v in data.items()
            )
            headers.setdefault(
                "Content-Type", "application/x-www-form-urlencoded"
            )
        else:
            body = str(data)

    # Route through _yurt.fetch (network gateway)
    if _yurt is not None:
        resp = _yurt.fetch(method.upper(), url, headers, body)
        # Only raise on connection/network errors, not HTTP error codes.
        # HTTP 4xx/5xx should return a Response (like real requests).
        if resp.get("error") and not resp.get("status"):
            raise ConnectionError(
                f"requests.{method.lower()}() failed: {resp.get('error')}"
            )
        return Response(
            status_code=resp.get("status", 0),
            headers=resp.get("headers", {}),
            text=resp.get("body", ""),
            url=url,
        )

    # Fallback: use http.client (goes through socket shim)
    return _fetch_via_http_client(method, url, headers, body)


def _fetch_via_http_client(method, url, headers, body):
    """Fallback using stdlib http.client."""
    import http.client
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    if parsed.scheme == "https":
        conn = http.client.HTTPSConnection(host, port or 443)
    else:
        conn = http.client.HTTPConnection(host, port or 80)

    try:
        conn.request(method.upper(), path, body=body, headers=headers)
        resp = conn.getresponse()
        resp_headers = dict(resp.getheaders())
        resp_text = resp.read().decode("utf-8", errors="replace")
        return Response(
            status_code=resp.status,
            headers=resp_headers,
            text=resp_text,
            url=url,
        )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Convenience methods
# ---------------------------------------------------------------------------


def get(url, **kwargs):
    return request("GET", url, **kwargs)


def post(url, **kwargs):
    return request("POST", url, **kwargs)


def put(url, **kwargs):
    return request("PUT", url, **kwargs)


def patch(url, **kwargs):
    return request("PATCH", url, **kwargs)


def delete(url, **kwargs):
    return request("DELETE", url, **kwargs)


def head(url, **kwargs):
    return request("HEAD", url, **kwargs)


def options(url, **kwargs):
    return request("OPTIONS", url, **kwargs)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _quote(s):
    """Minimal URL encoding for query parameters."""
    result = []
    for ch in s:
        if ch.isalnum() or ch in "-_.~":
            result.append(ch)
        elif ch == " ":
            result.append("+")
        else:
            result.append(f"%{ord(ch):02X}")
    return "".join(result)


def _status_reason(code):
    reasons = {
        200: "OK", 201: "Created", 204: "No Content",
        301: "Moved Permanently", 302: "Found", 304: "Not Modified",
        400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
        404: "Not Found", 405: "Method Not Allowed",
        408: "Request Timeout", 409: "Conflict", 422: "Unprocessable Entity",
        429: "Too Many Requests",
        500: "Internal Server Error", 502: "Bad Gateway",
        503: "Service Unavailable", 504: "Gateway Timeout",
    }
    return reasons.get(code, "Unknown")


# Module-level attributes expected by code that checks requests version
__version__ = "2.32.0"
__title__ = "requests"
codes = type("codes", (), {
    "ok": 200, "created": 201, "no_content": 204,
    "bad_request": 400, "unauthorized": 401, "forbidden": 403,
    "not_found": 404, "server_error": 500,
})()
