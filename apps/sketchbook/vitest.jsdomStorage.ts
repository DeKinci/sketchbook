/**
 * Vitest setup: give jsdom a WORKING `localStorage`.
 *
 * Node ≥22 can ship its own global `localStorage` which, without `--localstorage-file`,
 * is inert and SHADOWS jsdom's real Storage — every `localStorage.clear()` then throws.
 * The `test` script passes `NODE_OPTIONS=--no-experimental-webstorage`; this file covers
 * a bare `npx vitest run` that never sees that env. Guarded on the broken shape, so it
 * is a no-op wherever jsdom's own Storage is intact.
 */
if (typeof window !== "undefined" && typeof localStorage.clear !== "function") {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void map.set(String(k), String(v)),
    removeItem: (k: string) => void map.delete(String(k)),
    clear: () => map.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
