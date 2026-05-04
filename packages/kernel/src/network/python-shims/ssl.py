"""
Wasmsand ssl shim — makes urllib HTTPS work via the host network bridge.

The actual TLS is handled by the host. This module provides just enough
API surface for http.client and urllib to use HTTPSHandler.
"""
import socket as _socket

PROTOCOL_TLS = 2
PROTOCOL_TLS_CLIENT = 16
PROTOCOL_TLS_SERVER = 17
CERT_NONE = 0
CERT_OPTIONAL = 1
CERT_REQUIRED = 2
OP_NO_SSLv2 = 0x01000000
OP_NO_SSLv3 = 0x02000000
HAS_SNI = True
HAS_ECDH = True
HAS_NPN = False
HAS_ALPN = True
OPENSSL_VERSION = "Wasmsand 0.0.0"
OPENSSL_VERSION_INFO = (0, 0, 0, 0, 0)
OPENSSL_VERSION_NUMBER = 0

_RESTRICTED_SERVER_CIPHERS = ""


class SSLError(OSError):
    pass


class SSLCertVerificationError(SSLError):
    pass


class CertificateError(SSLError):
    pass


class SSLContext:
    """Minimal SSLContext — wrapping is a no-op since the host does TLS."""

    def __init__(self, protocol=PROTOCOL_TLS_CLIENT):
        self.protocol = protocol
        self.verify_mode = CERT_NONE
        self.check_hostname = False
        self.options = 0
        self.post_handshake_auth = False
        self.keylog_filename = None
        self._cadata = None
        self._cafile = None
        self._capath = None

    def set_default_verify_paths(self):
        pass

    def load_default_certs(self, purpose=None):
        pass

    def load_verify_locations(self, cafile=None, capath=None, cadata=None):
        self._cafile = cafile
        self._capath = capath
        self._cadata = cadata

    def load_cert_chain(self, certfile, keyfile=None, password=None):
        pass

    def set_ciphers(self, ciphers):
        pass

    def set_alpn_protocols(self, protocols):
        pass

    def wrap_socket(self, sock, server_side=False, do_handshake_on_connect=True,
                    suppress_ragged_eofs=True, server_hostname=None):
        # Mark the socket as HTTPS (port 443) so the shim builds https:// URLs
        if server_hostname and hasattr(sock, '_host'):
            sock._host = server_hostname
        if hasattr(sock, '_port') and sock._port in (None, 80):
            sock._port = 443
        return sock


class Purpose:
    SERVER_AUTH = "SERVER_AUTH"
    CLIENT_AUTH = "CLIENT_AUTH"


def create_default_context(purpose=Purpose.SERVER_AUTH, cafile=None, capath=None, cadata=None):
    ctx = SSLContext(PROTOCOL_TLS_CLIENT)
    ctx.verify_mode = CERT_REQUIRED
    ctx.check_hostname = True
    if cafile or capath or cadata:
        ctx.load_verify_locations(cafile, capath, cadata)
    else:
        ctx.set_default_verify_paths()
    return ctx


def _create_unverified_context(protocol=PROTOCOL_TLS_CLIENT):
    ctx = SSLContext(protocol)
    ctx.verify_mode = CERT_NONE
    ctx.check_hostname = False
    return ctx

_create_default_https_context = create_default_context


def wrap_socket(sock, keyfile=None, certfile=None, server_side=False,
                cert_reqs=CERT_NONE, ssl_version=PROTOCOL_TLS,
                ca_certs=None, do_handshake_on_connect=True,
                suppress_ragged_eofs=True, ciphers=None,
                server_hostname=None):
    ctx = SSLContext(ssl_version)
    ctx.verify_mode = cert_reqs
    return ctx.wrap_socket(sock, server_side=server_side,
                           server_hostname=server_hostname)
