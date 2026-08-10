import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { scoresDevApi } from './src/net/devApiPlugin';

// App build/dev server. The engine's unit tests live in vitest.config.ts and do
// not use these plugins (the engine imports no React/DOM/CSS).
export default defineConfig({
  // Keep Vite's many small cache files on the machine's native temp volume.
  // This preserves the fast-cache intent without embedding one user's path.
  cacheDir: resolve(tmpdir(), 'vite-notefield-cache'),
  // scoresDevApi serves /api/scores in dev (in-memory) the way the Vercel
  // Function does in production — same handlers, docs/LEADERBOARDS.md.
  plugins: [
    react(),
    tailwindcss(),
    scoresDevApi(),
    {
      name: 'exclude-dev-debug-assets',
      apply: 'build',
      closeBundle() {
        // public/debug contains local retargeting fixtures, not product assets.
        rmSync(resolve(process.cwd(), 'dist', 'debug'), { recursive: true, force: true });
      },
    },
  ],
  optimizeDeps: {
    // ffmpeg.wasm spawns its worker via `new Worker(new URL(...))` relative to
    // its own module URL — esbuild pre-bundling breaks that in dev.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core'],
  },
  server: {
    watch: {
      // Don't watch (and choke on) stray archives/media dropped in the project.
      ignored: ['**/*.zip', '**/*.7z', '**/*.rar', '**/*.mp4', '**/*.mov'],
    },
  },
});
