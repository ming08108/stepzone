import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// App build/dev server. The engine's unit tests live in vitest.config.ts and do
// not use these plugins (the engine imports no React/DOM/CSS).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // Don't watch (and choke on) stray archives/media dropped in the project.
      ignored: ['**/*.zip', '**/*.7z', '**/*.rar', '**/*.mp4', '**/*.mov'],
    },
  },
});
