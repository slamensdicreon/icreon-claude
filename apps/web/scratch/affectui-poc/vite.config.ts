import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Serves the proof of concept on its own, with the app's fonts: pnpm --filter @lw/web exec vite scratch/affectui-poc
export default defineConfig({
  root: __dirname,
  publicDir: '../../public',
  plugins: [react()],
  server: { port: 5174 },
});
