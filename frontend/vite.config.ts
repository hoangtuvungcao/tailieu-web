import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite configuration.
 *
 * The dev server proxies `/api` to the backend on :3000. That is not just a
 * convenience — it makes local development match production, where the Pages
 * Function also serves the API from the same origin. Developing against a
 * direct cross-origin API would exercise a CORS path that never runs in
 * production, and would hide same-origin cookie problems until deploy.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
        // Cookies (the refresh token) must survive the proxy, otherwise every
        // reload signs the user out during development only.
        cookieDomainRewrite: '',
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the heaviest dependencies so a change to application code does
        // not invalidate the vendor bundle in every visitor's cache.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          forms: ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },
});
