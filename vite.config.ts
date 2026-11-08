import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/': 'http://localhost:3000',
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
