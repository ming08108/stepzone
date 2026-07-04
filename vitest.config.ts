import { defineConfig } from 'vitest/config';

// Engine unit tests. Pure TypeScript, Node environment — no React plugin needed,
// which also avoids the dual-Vite type clash with @vitejs/plugin-react.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
