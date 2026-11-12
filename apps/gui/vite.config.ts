import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '../..', 'KAIROS_');
  const host = environment.KAIROS_HOST ?? '127.0.0.1';
  const port = environment.KAIROS_PORT ?? '4317';
  const target = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          headers: { origin: target },
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
