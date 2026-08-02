import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { visualizer } from 'rollup-plugin-visualizer';

// Resolve paths for manual chunks
const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    visualizer({ open: true, gzipSize: true, emitFile: false }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          vitest: ['vitest'],
          scan: [resolvePath('src/pages/ScanJobsPage.tsx'), resolvePath('src/jobSearch.ts')],
          ai: [resolvePath('src/ai.ts'), resolvePath('src/aiQueue.ts')],
          utils: [resolvePath('src/utils.ts')],
          // Split large modules
          keywordExtractor: [resolvePath('src/keywordExtractor.ts')],
          documentRules: [resolvePath('src/documentRules.ts')],
          // Tree-shake mammoth
          mammoth: ['mammoth'],
        },
      },
    },
  },
});