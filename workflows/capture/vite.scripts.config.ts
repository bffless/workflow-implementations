/**
 * The `script`-step build for `capture`. A script runs inside a Web Worker spawned from a
 * `data:` URL (harness spec 03/09), so each module must be ONE self-contained file: library
 * mode, one entry per build, `inlineDynamicImports` so Rollup never splits a chunk out.
 * Copied from workflows/workflow-studio/vite.scripts.config.ts.
 *
 * Env (set by scripts/stage.mjs):
 * - WORKFLOW_SCRIPT       the entry under scripts/ to build, e.g. scripts/bundle.ts (required)
 * - WORKFLOW_SCRIPTS_OUT  where <name>.js lands (default dist/scripts)
 */
import { defineConfig } from 'vite'
import { basename, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const entry = process.env.WORKFLOW_SCRIPT
if (!entry || !/^scripts\/[a-z0-9-]+\.ts$/.test(entry)) {
  throw new Error(`vite.scripts.config.ts: set WORKFLOW_SCRIPT to an entry file under scripts/ (got ${String(entry)})`)
}

const outDir = process.env.WORKFLOW_SCRIPTS_OUT ?? resolve(here, 'dist/scripts')
const name = basename(entry, extname(entry))

export default defineConfig({
  build: {
    outDir,
    // The stager clears the directory once, before the first script.
    emptyOutDir: false,
    target: 'es2022',
    lib: { entry: resolve(here, entry), formats: ['es'], fileName: () => `${name}.js` },
    rollupOptions: { output: { inlineDynamicImports: true } },
    reportCompressedSize: false,
  },
})
