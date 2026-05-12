type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
};

type AsyncLocalStorageCtor = new <T>() => AsyncLocalStorageLike<T>;

const NativeAsyncLocalStorage = await loadNativeAsyncLocalStorage();

export class ThreadIdScope {
  private readonly native = NativeAsyncLocalStorage
    ? new NativeAsyncLocalStorage<number>()
    : null;
  private fallbackCurrent = 0;
  private fallbackAsyncScopeActive = false;

  getStore(): number {
    return this.native?.getStore() ?? this.fallbackCurrent;
  }

  run<T>(tid: number, fn: () => T): T {
    if (this.native) return this.native.run(tid, fn);
    if (this.fallbackAsyncScopeActive) {
      throw new Error(
        "overlapping async thread scopes require native async context support",
      );
    }

    const previous = this.fallbackCurrent;
    this.fallbackCurrent = tid;
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.fallbackCurrent = previous;
      throw err;
    }

    if (isPromiseLike(result)) {
      this.fallbackAsyncScopeActive = true;
      return result.finally(() => {
        this.fallbackAsyncScopeActive = false;
        this.fallbackCurrent = previous;
      }) as T;
    }

    this.fallbackCurrent = previous;
    return result;
  }
}

async function loadNativeAsyncLocalStorage(): Promise<
  AsyncLocalStorageCtor | null
> {
  try {
    if (typeof Deno !== "undefined" || hasNodeProcess()) {
      return (await import("node:async_hooks")).AsyncLocalStorage;
    }
  } catch {
    // Browser and edge runtimes should still be able to import the loader.
  }
  return null;
}

function hasNodeProcess(): boolean {
  const processLike = (globalThis as {
    process?: { versions?: { node?: string } };
  }).process;
  return typeof processLike?.versions?.node === "string";
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<unknown> & {
  finally(onFinally: () => void): PromiseLike<unknown>;
} {
  return typeof value === "object" && value !== null &&
    typeof (value as { then?: unknown }).then === "function" &&
    typeof (value as { finally?: unknown }).finally === "function";
}
