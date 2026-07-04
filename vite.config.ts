import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { RemoteCatalog } from './src/io/catalog';
import { MIME, safePath, scanCatalog, sendFile } from './scripts/songLibrary.ts';

/**
 * Serves the local ITGmania/StepMania Songs library at `/songs/*` from the same
 * dev (and preview) server, so notefield auto-loads it with no separate process,
 * URL, or CORS. Point it elsewhere with the SONGS_DIR env var.
 */
function songsPlugin(): Plugin {
  const root = (process.env.SONGS_DIR || 'C:/Games/ITGmania/Songs').replace(/[\\/]+$/, '');
  let cache: RemoteCatalog | null = null;
  let cacheAt = 0;
  const catalog = (): RemoteCatalog => {
    const now = Date.now();
    if (cache && now - cacheAt < 60_000) return cache;
    cache = scanCatalog(root);
    cacheAt = now;
    return cache;
  };
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url || '';
    if (url !== '/songs' && !url.startsWith('/songs/')) return next();
    const path = url.slice('/songs'.length).split('?')[0] || '/';
    if (path === '/catalog.json' || path === '/') {
      res.setHeader('Content-Type', MIME['.json']);
      res.end(JSON.stringify(catalog()));
      return;
    }
    const file = safePath(root, path);
    if (!file) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    sendFile(req, res, file);
  };
  return {
    name: 'notefield-songs',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// App build/dev server. The engine's unit tests live in vitest.config.ts and do
// not use these plugins (the engine imports no React/DOM/CSS).
export default defineConfig({
  plugins: [react(), tailwindcss(), songsPlugin()],
});
