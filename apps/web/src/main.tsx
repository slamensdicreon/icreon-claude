// The old stylesheet first, Cypher's theme after it, so the theme's bridge wins where they meet.
// Both old files go per surface at cut-over and whole in phase 5.
import './styles/prototype.css';
import './styles/app.css';
import './theme/tokens.css';
import './theme/type.css';
import './theme/bridge.css';
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
