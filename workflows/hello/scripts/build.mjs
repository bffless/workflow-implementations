#!/usr/bin/env node
// Build the workflow-hello bundle: single-file islands, the `script` step
// module copied verbatim, then `@bffless/workflow-lint`'s `workflow index`
// verb lints `.bffless/workflows/` and writes the bundle's index.json + a
// landing page.
//
// Modeled on the monorepo's apps/workflow/scripts/stage-hello.mjs (the island
// build + script copy); the index.json/landing-page half that script wrote by
// hand is replaced here by `workflow index` (M3 Phase 1) — this repo is that
// tool's first customer outside the monorepo (06).
import { mkdirSync, copyFileSync, readdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * This repo's own binaries, never `npx` (R23): a reproducible build never
 * silently reaches the network for a tool this repo already pins in
 * `package.json`.
 */
const bin = (name) => join(repoDir, 'node_modules', '.bin', name)

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

/**
 * A flag's value, validated: a flag with no following value, or one whose
 * "value" is itself another flag, is a usage error — never silently `undefined`
 * or the next flag's name.
 */
function flagValue(name, fallback) {
  const idx = args.indexOf(name)
  if (idx === -1) return fallback
  const value = args[idx + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`build.mjs: ${name} needs a value`)
  }
  return value
}

const explicitOut = flagValue('--out', null)
// The preview workflow (a PR alias, e.g. `hello-pr-7`) builds the same source
// under a different alias/display name — the published `impl` must say which
// one, since the harness reads it back to know what it just deployed.
const impl = flagValue('--impl', 'hello')
const name = flagValue('--name', 'Hello')

// `--check` is a "does it build" gate and nothing more: the whole build runs
// into a throwaway temp dir, which is discarded when it's done.
const out = checkOnly
  ? mkdtempSync(join(tmpdir(), 'workflow-hello-build-'))
  : (explicitOut ?? join(repoDir, 'dist'))

try {
  // ---------------------------------------------------------------------
  // Islands — one single-file Vite build each (see vite.islands.config.ts).
  // Read from the directory rather than hard-coded, so a third island needs
  // no change here.
  // ---------------------------------------------------------------------
  const islandsSrcDir = join(repoDir, 'islands')
  const ISLANDS = readdirSync(islandsSrcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  // Type-checked *before* anything under `out` is touched: a type error in an
  // island or the script leaves whatever bundle was built last time intact,
  // rather than a half-wiped `dist/`.
  execFileSync(bin('tsc'), ['-p', 'tsconfig.json'], { cwd: repoDir, stdio: 'inherit' })

  const islandDir = join(out, 'islands')
  rmSync(islandDir, { recursive: true, force: true })
  mkdirSync(islandDir, { recursive: true })

  for (const island of ISLANDS) {
    execFileSync(bin('vite'), ['build', '-c', 'vite.islands.config.ts'], {
      cwd: repoDir,
      stdio: 'inherit',
      env: { ...process.env, WORKFLOW_ISLAND: island, WORKFLOW_ISLANDS_OUT: islandDir },
    })
  }

  // ---------------------------------------------------------------------
  // Scripts — copied verbatim; the Worker fetches them as modules. Excludes
  // this file itself: `scripts/` holds both the implementation's own script
  // step modules and this build tool, unlike the monorepo's separate
  // `hello/scripts/` vs `scripts/` split.
  // ---------------------------------------------------------------------
  const scriptsSrcDir = join(repoDir, 'scripts')
  const scriptOut = join(out, 'scripts')
  rmSync(scriptOut, { recursive: true, force: true })

  const scriptFiles = readdirSync(scriptsSrcDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'build.mjs' && /\.m?js$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  if (scriptFiles.length > 0) {
    mkdirSync(scriptOut, { recursive: true })
    for (const file of scriptFiles) copyFileSync(join(scriptsSrcDir, file), join(scriptOut, file))
  }

  // ---------------------------------------------------------------------
  // .bffless/workflows/index.json + a landing page — `workflow index` lints
  // every workflow in .bffless/workflows and, only if they all pass, writes
  // the bundle's index.json (which also lists the islands/scripts already
  // staged above) and copies the YAMLs verbatim.
  // ---------------------------------------------------------------------
  // Requires @bffless/workflow-lint >= 1.0.1: 1.0.0's dist/cli.js silently
  // no-op'd when reached through pnpm's node_modules/.bin shim (fixed upstream).
  execFileSync(
    bin('workflow'),
    [
      'index',
      '.bffless/workflows',
      '--out',
      out,
      '--impl',
      impl,
      '--name',
      name,
      '--description',
      'M2 test implementation: hello (echo, slow job + poll, fail-on-purpose) and an interactive island round-trip; two islands (pick-line, line-viewer); analyze.',
      '--rules',
      '.bffless/proxy-rules/hello',
      '--path-prefix',
      '/api/hello',
    ],
    { cwd: repoDir, stdio: 'inherit' },
  )

  console.log('built', out)
} finally {
  if (checkOnly) rmSync(out, { recursive: true, force: true })
}
