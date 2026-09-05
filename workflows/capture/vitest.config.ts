/**
 * One project: `scripts/**` under `node` — the closest Vitest ships to a Worker with no DOM,
 * and the runtime fence behind tsconfig.scripts.json (a stray `document` throws here).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.{test,spec}.ts'],
  },
})
