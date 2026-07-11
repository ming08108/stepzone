/**
 * Shared Web-standard Response helpers for the API handlers (net/scoresApi.ts,
 * net/signalApi.ts) — one JSON envelope shape so their error responses can't
 * silently diverge.
 */

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json(status, { ok: false, code, message });
}
