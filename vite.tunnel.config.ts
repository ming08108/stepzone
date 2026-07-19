// TEMPORARY (untracked): dev server for the public Cloudflare quick-tunnel demo.
// Extends the real vite.config and only adds server host/port + allowedHosts so
// Vite accepts the *.trycloudflare.com Host header. Not for commit; delete when
// the tunnel demo is done.
import base from './vite.config';

const b = base as { server?: Record<string, unknown> };

export default {
  ...base,
  server: {
    ...(b.server ?? {}),
    host: true,
    port: 5174,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
  },
};
