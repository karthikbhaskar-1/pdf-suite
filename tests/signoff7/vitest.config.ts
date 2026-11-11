// Sign-Off 1.3.1 engine probes: run with  npx vitest run -c tests/signoff7/vitest.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  test: { environment: 'node', include: ['tests/signoff7/**/*.probe.test.ts'], testTimeout: 300000 },
});
