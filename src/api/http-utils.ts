/** Shared response/caching helpers for the HTTP API layer — used by both the
 *  existing islamicbook.ws routes (server.ts) and the shamela.ws routes
 *  (shamela-routes.ts), so the two follow the same conventions without
 *  duplicating them. Each route module owns its own cache Map (separate
 *  namespaces per source), just reusing this same TTL-cache mechanism. */

export type CacheStore = Map<string, { expires: number; value: unknown }>;

export async function cached<T>(
  store: CacheStore,
  ttlMs: number,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;

  const value = await fn();
  store.set(key, { expires: Date.now() + ttlMs, value });
  return value;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}
