import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './fonts';
import './styles/index.css';

// In Electron the preload exposes `window.claudeos`. Anywhere else (vite in a browser, screenshots) load the
// in-memory mock — as a separate lazily-loaded chunk, so the production panel never executes it.
if (!window.claudeos) {
  const { installMockApi } = await import('./dev/mockApi');
  installMockApi();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
