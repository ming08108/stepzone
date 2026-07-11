import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { scoresDevApi } from './src/net/devApiPlugin';

// App build/dev server. The engine's unit tests live in vitest.config.ts and do
// not use these plugins (the engine imports no React/DOM/CSS).
export default defineConfig({
  // scoresDevApi serves /api/scores in dev (in-memory) the way the Vercel
  // Function does in production — same handlers, docs/LEADERBOARDS.md.
  plugins: [react(), tailwindcss(), scoresDevApi()],
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
