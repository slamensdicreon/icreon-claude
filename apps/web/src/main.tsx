// Cypher's tokens, the page's base, then type; every component styles itself in its own module.
import './theme/tokens.css';
import './theme/base.css';
import './theme/type.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// /system lists every token and design-system item the app reads; it loads only when asked for.
const SystemPage = lazy(() =>
  import('./system/SystemPage').then((m) => ({ default: m.SystemPage })),
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname === '/system' ? (
      <Suspense>
        <SystemPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
