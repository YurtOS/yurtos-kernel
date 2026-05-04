import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { getSocketShimSource, getSslShimSource, getSiteCustomizeSource } from '../socket-shim.js';

const SOCKET_SHIM_SOURCE = getSocketShimSource();
const SSL_SHIM_SOURCE = getSslShimSource();
const SITE_CUSTOMIZE_SOURCE = getSiteCustomizeSource();

describe('socket shim source', () => {
  it('exports a non-empty Python source string', () => {
    expect(typeof SOCKET_SHIM_SOURCE).toBe('string');
    expect(SOCKET_SHIM_SOURCE.length).toBeGreaterThan(100);
  });

  it('contains the required socket API surface', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('class socket:');
    expect(SOCKET_SHIM_SOURCE).toContain('def connect(');
    expect(SOCKET_SHIM_SOURCE).toContain('def send(');
    expect(SOCKET_SHIM_SOURCE).toContain('def sendall(');
    expect(SOCKET_SHIM_SOURCE).toContain('def recv(');
    expect(SOCKET_SHIM_SOURCE).toContain('def makefile(');
    expect(SOCKET_SHIM_SOURCE).toContain('def close(');
    expect(SOCKET_SHIM_SOURCE).toContain('def create_connection(');
    expect(SOCKET_SHIM_SOURCE).toContain('def getaddrinfo(');
    expect(SOCKET_SHIM_SOURCE).toContain('import _yurt');
  });

  it('contains Content-Length aware flush logic', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('content-length');
    expect(SOCKET_SHIM_SOURCE).toContain('_should_flush');
  });

  it('contains asyncio-required constants', () => {
    // These constants are probed by asyncio at import time
    expect(SOCKET_SHIM_SOURCE).toContain('AF_UNSPEC = 0');
    expect(SOCKET_SHIM_SOURCE).toContain('SOCK_RAW = 3');
    expect(SOCKET_SHIM_SOURCE).toContain('IPPROTO_UDP = 17');
    expect(SOCKET_SHIM_SOURCE).toContain('IPPROTO_IP = 0');
    expect(SOCKET_SHIM_SOURCE).toContain('SOL_TCP = 6');
    expect(SOCKET_SHIM_SOURCE).toContain('SO_REUSEADDR = 2');
    expect(SOCKET_SHIM_SOURCE).toContain('SO_ERROR = 4');
    expect(SOCKET_SHIM_SOURCE).toContain('MSG_DONTWAIT = 64');
    expect(SOCKET_SHIM_SOURCE).toContain('MSG_PEEK = 2');
    expect(SOCKET_SHIM_SOURCE).toContain('AI_PASSIVE = 1');
    expect(SOCKET_SHIM_SOURCE).toContain('AI_CANONNAME = 2');
    expect(SOCKET_SHIM_SOURCE).toContain('AI_NUMERICHOST = 4');
    expect(SOCKET_SHIM_SOURCE).toContain('AI_NUMERICSERV = 1024');
    expect(SOCKET_SHIM_SOURCE).toContain('NI_NUMERICHOST = 1');
    expect(SOCKET_SHIM_SOURCE).toContain('NI_NUMERICSERV = 2');
    expect(SOCKET_SHIM_SOURCE).toContain('EAI_NONAME = -2');
    expect(SOCKET_SHIM_SOURCE).toContain('SOMAXCONN = 128');
    expect(SOCKET_SHIM_SOURCE).toContain('has_ipv6 = True');
  });

  it('contains inet_aton, inet_ntoa, and getnameinfo stubs', () => {
    expect(SOCKET_SHIM_SOURCE).toContain('def inet_aton(');
    expect(SOCKET_SHIM_SOURCE).toContain('def inet_ntoa(');
    expect(SOCKET_SHIM_SOURCE).toContain('def getnameinfo(');
  });

  it('getaddrinfo respects family parameter', () => {
    // getaddrinfo should check family against AF_INET and AF_INET6
    expect(SOCKET_SHIM_SOURCE).toContain('family == AF_INET');
    expect(SOCKET_SHIM_SOURCE).toContain('family == AF_INET6');
    // Should return both families when family=0 (AF_UNSPEC)
    expect(SOCKET_SHIM_SOURCE).toContain('family == 0 or family == AF_INET');
    expect(SOCKET_SHIM_SOURCE).toContain('family == 0 or family == AF_INET6');
  });

  it('exports SITE_CUSTOMIZE_SOURCE that injects socket and ssl into sys.modules', () => {
    expect(typeof SITE_CUSTOMIZE_SOURCE).toBe('string');
    expect(SITE_CUSTOMIZE_SOURCE).toContain('sys.modules[name]');
    expect(SITE_CUSTOMIZE_SOURCE).toContain('_inject_shim("socket"');
    expect(SITE_CUSTOMIZE_SOURCE).toContain('_inject_shim("ssl"');
  });

  it('exports SSL_SHIM_SOURCE with required ssl API surface', () => {
    expect(typeof SSL_SHIM_SOURCE).toBe('string');
    expect(SSL_SHIM_SOURCE.length).toBeGreaterThan(100);
    expect(SSL_SHIM_SOURCE).toContain('class SSLContext');
    expect(SSL_SHIM_SOURCE).toContain('def wrap_socket(');
    expect(SSL_SHIM_SOURCE).toContain('def create_default_context(');
    expect(SSL_SHIM_SOURCE).toContain('CERT_NONE');
    expect(SSL_SHIM_SOURCE).toContain('CERT_REQUIRED');
    expect(SSL_SHIM_SOURCE).toContain('PROTOCOL_TLS_CLIENT');
    expect(SSL_SHIM_SOURCE).toContain('class SSLError');
    expect(SSL_SHIM_SOURCE).toContain('_create_default_https_context');
  });
});
