import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { rollupPluginHTML as html } from '@web/rollup-plugin-html';

// Resolve paths for manual chunks
const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), html({ inputHtml: resolvePath('public/index.html') })],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          vitest: ['vitest'],
          scan: [resolvePath('src/pages/ScanJobsPage.tsx'), resolvePath('src/jobSearch.ts')],
          ai: [resolvePath('src/ai.ts'), resolvePath('src/aiQueue.ts')],
          utils: [resolvePath('src/utils.ts')],
          // Split large dependencies
          mammoth: ['mammoth'],
        },
      },
    },
  },
});