/**
 * Python source for /usr/lib/python/yurt_ext.py — bridge to host
 * extensions via the _yurt native module.
 */
export const YURT_EXT_SOURCE = `\
"""yurt_ext -- bridge to host extensions via _yurt native module."""
import _yurt

def call(extension_name, method, **kwargs):
    """Call a host extension method. Returns the result."""
    return _yurt.extension_call(extension_name, method, **kwargs)

def is_extension(name):
    """Check if a named extension is available."""
    return _yurt.is_extension(name)
`;

/**
 * Generate the Python source for /usr/lib/python/<name>/_shim.py —
 * a thin wrapper that routes calls to the extension's command handler
 * via yurt_ext.call(), without requiring subprocess.
 *
 * Auto-injected for every extension that has a `command` handler.
 */
export function generateCommandShim(extensionName: string): string {
  const quoted = JSON.stringify(extensionName);
  return `\
"""Auto-generated command shim for the ${quoted} extension."""
import yurt_ext as _ce


def run(*args, stdin=''):
    """Call the ${quoted} host extension command.

    Args:
        *args: positional string arguments passed to the command.
        stdin: standard input string (default: '').
    Returns:
        dict with keys exit_code (int), stdout (str), stderr (str).
    """
    return _ce.call(${quoted}, 'command', args=list(args), stdin=stdin or '')
`;
}
