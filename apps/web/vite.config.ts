import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The Control Center. In development the Control API runs on :4000 and Vite proxies to it, so
 * the browser sees one origin (cookies and EventSource need no CORS). Set VITE_API_URL to point a
 * build at an API on another origin.
 */
const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
const proxy = Object.fromEntries(
  ['/projects', '/portfolio', '/playbooks', '/auth', '/health', '/intake', '/integrations'].map(
    (p) => [p, { target: api, changeOrigin: true }],
  ),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
});
