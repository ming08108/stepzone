import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createCatalogCache, handleSongRequest, resolveSongsRoot } from './scripts/songLibrary.ts';

/**
 * Serves the local ITGmania/StepMania Songs library at `/songs/*` from the same
 * dev (and preview) server, so stepzone auto-loads it with no separate process,
 * URL, or CORS. Point it elsewhere with the SONGS_DIR env var.
 */
function songsPlugin(): Plugin {
  const root = resolveSongsRoot();
  const catalog = createCatalogCache(root);
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url || '';
    if (url !== '/songs' && !url.startsWith('/songs/')) return next();
    handleSongRequest(req, res, root, catalog, url.slice('/songs'.length) || '/');
  };
  return {
    name: 'stepzone-songs',
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
  server: {
    watch: {
      // Don't watch (and choke on) stray archives/media dropped in the project.
      ignored: ['**/*.zip', '**/*.7z', '**/*.rar', '**/*.mp4', '**/*.mov'],
    },
  },
});
