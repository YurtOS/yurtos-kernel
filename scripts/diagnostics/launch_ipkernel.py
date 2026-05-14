"""Launch ipykernel and run its IOLoop. No watchdog — we rely on the
host sandbox timeout. Prints every step so cold-hang location is visible."""
import os
import sys

# Same import-order workaround the dry-run uses.
import ssl  # noqa: F401


def main() -> int:
    print("[launch] importing IPKernelApp…", flush=True)
    from ipykernel.kernelapp import IPKernelApp
    print("[launch] clear/instance…", flush=True)
    IPKernelApp.clear_instance()
    app = IPKernelApp.instance()
    print("[launch] initialize(['-f', '/tmp/yurt-jupyter-k.json'])", flush=True)
    try:
        app.initialize(["-f", "/tmp/yurt-jupyter-k.json"])
    except Exception as e:
        print(f"[launch] initialize raised: {type(e).__name__}: {e}",
              flush=True)
        import traceback
        traceback.print_exc()
        return 1
    print("[launch] initialize ok — about to start()", flush=True)
    try:
        app.start()
        print("[launch] start() returned normally", flush=True)
    except Exception as e:
        print(f"[launch] start raised: {type(e).__name__}: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return 2
    return 0


if __name__ == "__main__":
    os._exit(main())
