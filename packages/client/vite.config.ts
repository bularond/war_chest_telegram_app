import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/health': { target: 'http://localhost:8787' },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
