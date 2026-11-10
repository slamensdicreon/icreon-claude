// Cypher's tokens, the page's base, then type; every component styles itself in its own module.
import './theme/tokens.css';
import './theme/base.css';
import './theme/type.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { API } from './lib/api';
import { loadRole } from './lib/role';
import { Watching } from './shell/Watching';

// /system lists every token and design-system item the app reads; it loads only when asked for.
const SystemPage = lazy(() =>
  import('./system/SystemPage').then((m) => ({ default: m.SystemPage })),
);

// The role decides what the app offers (a Watcher changes nothing), so it is read first.
void loadRole(API).finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {location.pathname === '/system' ? (
        <Suspense>
          <SystemPage />
        </Suspense>
      ) : (
        <>
          <App />
          <Watching />
        </>
      )}
    </StrictMode>,
  ),
);
