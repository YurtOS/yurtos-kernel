"""
Wasmsand sitecustomize — injects socket and ssl shims at interpreter startup.

RustPython's frozen socket module takes priority over PYTHONPATH files.
By loading our shims here (which runs at interpreter startup), we inject
them into sys.modules before any other code can import the frozen versions.
"""
import sys
import importlib.machinery
import importlib.util


def _inject_shim(name, path):
    """Load a .py file and register it as a sys.modules entry."""
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_file_location(name, path, loader=loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    loader.exec_module(mod)


_inject_shim("socket", "/usr/lib/python/socket.py")
_inject_shim("ssl", "/usr/lib/python/ssl.py")
