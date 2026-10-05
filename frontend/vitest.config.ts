import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Frontend test configuration.
 *
 * jsdom rather than a real browser: the logic worth testing here is the API
 * client and the pure formatting helpers, both of which depend on browser
 * globals (`document.cookie`, `fetch`) but not on rendering. A full browser via
 * Playwright would be the right tool for the pages, and is deliberately not
 * set up — testing components that mostly arrange other components is a poor
 * return until there is a page with real interaction logic of its own.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
    // The API client test controls timers around the refresh race window.
    testTimeout: 15_000,
  },
});
