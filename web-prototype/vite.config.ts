import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1500 },
  server: { port: Number(process.env.PORT) || 5174 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never);
