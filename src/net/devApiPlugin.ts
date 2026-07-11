/**
 * Vite dev-server middleware serving the online API (/api/scores leaderboards
 * and /api/versus signaling) from in-memory stores, so both work in
 * `npm run dev` (and the e2e harness) exactly as the Vercel Functions serve
 * them in production — same handlers, same validation, just process-lifetime
 * storage. Node/dev only: imported by vite.config.ts, never by app code.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createHandlers, type ScoresHandlers } from './scoresApi';
import { MemoryScoreStore } from './scoreStore';
import { createSignalHandlers } from './signalApi';
import { MemorySignalStore } from './signalStore';

/** GET/POST Web-signature handler pair (scores and signaling share the shape). */
type WebHandlers = Pick<ScoresHandlers, 'GET' | 'POST'>;

/** Bridge one Connect request to the Web-signature handlers. */
async function bridge(
  handlers: WebHandlers,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const handler = method === 'POST' ? handlers.POST : method === 'GET' ? handlers.GET : null;
  if (!handler) {
    res.statusCode = 405;
    res.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://localhost${req.url ?? '/'}`, {
    method,
    ...(method === 'POST' ? { body } : {}),
  });
  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(await response.text());
}

export function scoresDevApi(): Plugin {
  const routes: Array<[string, WebHandlers]> = [
    ['/api/scores', createHandlers(new MemoryScoreStore())],
    ['/api/versus', createSignalHandlers(new MemorySignalStore())],
  ];
  return {
    name: 'stepzone-dev-api',
    configureServer(server) {
      for (const [path, handlers] of routes) {
        // Mounted with the full path so only that route hits the bridge; the
        // mount prefix is stripped from req.url, so restore it for the handler.
        server.middlewares.use(path, (req, res) => {
          req.url = `${path}${req.url === '/' ? '' : (req.url ?? '')}`;
          void bridge(handlers, req, res).catch(() => {
            res.statusCode = 500;
            res.end();
          });
        });
      }
    },
  };
}
