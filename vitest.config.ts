import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: [
  { test: { name: 'api', include: ['apps/api/**/*.test.ts'], environment: 'node', restoreMocks: true } },
  { test: { name: 'web', include: ['apps/web/**/*.test.tsx'], environment: 'jsdom', restoreMocks: true } },
] } });

