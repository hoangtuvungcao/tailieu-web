import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ApiError } from './lib/api-client';
import { SeoProvider } from './lib/seo';
import './styles.css';

/**
 * Theme initialisation, before first paint.
 *
 * Done here rather than in React so the correct theme is applied to <html>
 * before the browser paints. Setting it inside a component would render one
 * frame in the wrong theme — a white flash for dark-mode users on every load.
 *
 * The stored choice wins over the OS setting, so a user who explicitly picked
 * light does not get dark because their laptop switched at sunset.
 */
(() => {
  try {
    const stored = localStorage.getItem('tailieu-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = stored ? stored === 'dark' : prefersDark;
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    // localStorage can throw in private-mode or with storage disabled. Falling
    // back to light is harmless; crashing the app before render is not.
  }
})();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // One retry, not the default three. A failing request here is usually a
      // 4xx — a permission denial or a missing document — and retrying those
      // three times triples the latency before the user sees the error.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
      // 30 seconds of staleness suits a document library: content changes on a
      // scale of minutes, not seconds, and re-fetching on every tab focus
      // would make browsing feel busy and waste the tunnel's bandwidth.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Keep cached pages for five minutes so back-navigation is instant.
      gcTime: 5 * 60_000,
    },
    mutations: {
      retry: 0,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SeoProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </SeoProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
