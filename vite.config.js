import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(['/api', '/auth'].map(path => [path, {
      target: 'http://127.0.0.1:3210',
      changeOrigin: true,
      configure(proxy) {
        // Preserve the backend's strict same-origin CSRF check in local Vite development.
        proxy.on('proxyReq', (proxyReq, req) => {
          if (req.headers.origin) proxyReq.setHeader('Origin', 'http://127.0.0.1:3210');
        });
      },
    }])),
  },
});
