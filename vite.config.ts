import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// App build/dev server. The engine's unit tests live in vitest.config.ts and do
// not use this plugin (the engine imports no React/DOM).
export default defineConfig({
  plugins: [react()],
});
