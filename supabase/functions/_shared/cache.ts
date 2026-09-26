// Per-isolate cache for a keyed async loader (C14 + bug-hunt #30):
//  - positive entries live okMs; failures are remembered for failMs (negative cache), so an
//    anonymous caller cannot turn one vendor error into one vendor call (and log row) per request;
//  - single-flight: concurrent non-fresh callers share ONE in-flight load;
//  - stale-on-error: a non-fresh caller gets the last good value (even past okMs) when the reload
//    fails, instead of an outage page — the wording is still what the vendor last served;
//  - a `fresh` read always calls the loader and never falls back to a stale value — registration
//    must never use a cached consent wording. Its outcome refreshes both caches.

export interface LoaderCache<T> {
  get(key: string, load: () => Promise<T>, opts?: { fresh?: boolean }): Promise<T>;
  clear(): void;
}

export function loaderCache<T>(okMs: number, failMs: number, now: () => number = Date.now): LoaderCache<T> {
  const good = new Map<string, { at: number; value: T }>();
  const bad = new Map<string, { at: number; error: unknown }>();
  const inflight = new Map<string, Promise<T>>();

  async function run(key: string, load: () => Promise<T>, fresh: boolean): Promise<T> {
    try {
      const value = await load();
      good.set(key, { at: now(), value });
      bad.delete(key);
      return value;
    } catch (e) {
      bad.set(key, { at: now(), error: e });
      const stale = good.get(key);
      if (!fresh && stale) return stale.value;
      throw e;
    }
  }

  return {
    get(key, load, opts = {}) {
      const fresh = !!opts.fresh;
      if (!fresh) {
        const hit = good.get(key);
        if (hit && now() - hit.at < okMs) return Promise.resolve(hit.value);
        const miss = bad.get(key);
        if (miss && now() - miss.at < failMs) return hit ? Promise.resolve(hit.value) : Promise.reject(miss.error);
        const pending = inflight.get(key);
        if (pending) return pending;
        const p = run(key, load, false).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
      }
      return run(key, load, true);
    },
    clear() {
      good.clear();
      bad.clear();
      inflight.clear();
    },
  };
}
