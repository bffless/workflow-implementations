# Capture Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `workflows/capture/`, a Workflow-harness implementation that turns one screen recording into a zip (word-timed transcript + Studio-style contact sheets + the person's direction text) a later Claude session fetches through the harness MCP, deployed to both harnesses (j5s, workflow.bffless.dev).

**Architecture:** One workflow YAML with three non-interactive jobs (`extract` → `sheets` → `bundle`) over four rules copied from `workflow-studio` and renamed (`job/get`, `video/extract-audio`, `video/contact-sheet`, `transcribe`, schemas `capture_jobs`/`capture_uploads`). Two TypeScript `script` steps run in the harness Worker: `sheet-plan` (Studio's pure `planContactSheet`) and `bundle` (fflate zip of manifest + transcript + sheets, returned as a `File`). A trimmed copy of Studio's stager type-checks, builds the two scripts and runs `workflow index`; the deploy is Studio's two-job `publish-workflow@v1` shape.

**Tech Stack:** TypeScript 6, Vite 8 lib builds, Vitest 4, fflate, `@bffless/workflow-script` (types), `@bffless/workflow-lint` 1.5.x (`workflow index`), `bffless` CLI 0.3.x (`rules validate/test`), `bffless/publish-workflow@v1`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-05-capture-workflow-design.md` (same branch). Decisions D1–D9 there are binding; cite them in comments as `(D5)` etc.

## Global Constraints

- Alias is `capture`, permanently: rule set `capture`, API prefix `/api/capture/…`, files prefix `/w/capture/…`, deploy alias `capture`, preview aliases `capture-pr-<n>` (D7).
- Identity file `workflows/capture/.bffless/workflow.json` is exactly `{ "alias": "capture", "harness": "workflow" }`; CI `check-identity` compares it to `deploy-capture.yml`'s `alias:`.
- No `workflow_studio` / `workflow-studio` string may survive under `workflows/capture/` (a `grep -r` is part of Task 4's verification).
- Scripts run in a Worker with an opaque origin: `tsconfig.scripts.json` has `"lib": ["ES2023", "WebWorker"]`, `"types": []`; the only network is `ctx.files.fetch` (spec 03).
- Every declared script output must be present in the return value (`null`/`[]`/`''` allowed, `undefined` refused).
- Contact-sheet cell height is `1080` (D5); tiling stays `perSheet: 12`, `columns: 3`.
- No spoken audio never fails the run (D9): the plan is empty, the sheet step is `if:`-skipped, the bundle still ships with a warning.
- Never commit without the user's approval (workspace rule). Each task ends at "ready to commit"; the executor shows the diff summary and asks. Commit messages use conventional commits (`feat(capture): …`) and end with the session's attribution trailer.
- Work happens in the worktree `.claude/worktrees/capture` (branch `feat/capture`) of `/home/rico/bffless/repos/workflow-implementations`. Run `git rev-parse --show-toplevel` before the first edit of every task and confirm it prints that worktree path.
- Package manager is pnpm 10 (`packageManager` in root `package.json`); Node 20+.

---

### Task 1: Package scaffold + shared libs

**Files:**
- Create: `workflows/capture/.bffless/workflow.json`
- Create: `workflows/capture/package.json`
- Create: `workflows/capture/tsconfig.json`, `tsconfig.scripts.json`, `tsconfig.node.json`
- Create: `workflows/capture/vite.scripts.config.ts`
- Create: `workflows/capture/vitest.config.ts`
- Create: `workflows/capture/eslint.config.js`
- Create: `workflows/capture/scripts/lib/contactSheet.ts` (copy of `workflows/workflow-studio/vendor/studio/lib/contactSheet.ts`)
- Create: `workflows/capture/scripts/lib/inputs.ts`
- Create: `workflows/capture/scripts/lib/fakeCtx.ts` (copy of `workflows/workflow-studio/scripts/lib/fakeCtx.ts`)
- Test: `workflows/capture/scripts/lib/contactSheet.test.ts`
- Modify: `package.json` (repo root) — add `capture:*` scripts

**Interfaces:**
- Produces (for Tasks 2–3): `planContactSheet(duration): { interval, times, perSheet }`, `chunk<T>(items, size): T[][]`, `clockLabel(seconds): string`, `MAX_FRAMES`, `TILE_COLUMNS` from `scripts/lib/contactSheet.ts`; `inputError`, `requireNumber`, `requireString`, `optionalString`, `requireArray`, `requireNumbers`, `requireFileRef`, `requireFileRefs`, `optionalFileRefs` from `scripts/lib/inputs.ts`; `fakeCtx(inputs, fetchImpl?) → { ctx, logs, annotations, abort }` from `scripts/lib/fakeCtx.ts`.

- [ ] **Step 1: Create the package directory and identity file**

```bash
cd /home/rico/bffless/repos/workflow-implementations/.claude/worktrees/capture
mkdir -p workflows/capture/.bffless workflows/capture/scripts/lib
printf '{ "alias": "capture", "harness": "workflow" }\n' > workflows/capture/.bffless/workflow.json
```

- [ ] **Step 2: Write `workflows/capture/package.json`**

```json
{
  "name": "capture",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "lint": "eslint .",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc -p tsconfig.scripts.json && tsc -p tsconfig.node.json",
    "build": "node scripts/stage.mjs",
    "stage": "node scripts/stage.mjs",
    "rules:validate": "bffless rules validate .bffless/proxy-rules/capture",
    "rules:test": "bffless rules test .bffless/proxy-rules/capture"
  },
  "dependencies": {
    "fflate": "^0.8.3"
  },
  "devDependencies": {
    "@bffless/workflow-lint": "^1.5.1",
    "@bffless/workflow-script": "^1.0.0",
    "@eslint/js": "^10.0.1",
    "@types/node": "^24.12.3",
    "bffless": "^0.3.3",
    "eslint": "^10.3.0",
    "globals": "^17.6.0",
    "typescript": "~6.0.2",
    "typescript-eslint": "^8.59.2",
    "vite": "^8.0.12",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 3: Write the three tsconfigs**

`workflows/capture/tsconfig.json`:
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.scripts.json" }, { "path": "./tsconfig.node.json" }]
}
```

`workflows/capture/tsconfig.scripts.json` — no `DOM` (unlike workflow-studio: nothing here reaches Studio's browser capture code):
```json
{
  /* `script` steps run inside a Web Worker on an opaque origin (harness spec 03/09): no DOM,
     no window, no Node. `WebWorker` gives `self`/`fetch`/`Blob`/`File`; `"types": []` keeps
     `process`/`Buffer`/`node:*` out. `scripts/build.test.ts` reads `node:fs` through a
     computed specifier for exactly this reason. */
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023", "WebWorker"],
    "module": "esnext",
    "types": [],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["scripts"]
}
```

`workflows/capture/tsconfig.node.json`:
```json
{
  /* Node-side tooling only: the Vite build config the stager drives. Kept out of
     tsconfig.scripts.json so Worker code can never type-check against Node types. */
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023"],
    "module": "esnext",
    "types": ["node"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.scripts.config.ts"]
}
```

- [ ] **Step 4: Write `vite.scripts.config.ts`, `vitest.config.ts`, `eslint.config.js`**

`workflows/capture/vite.scripts.config.ts`:
```ts
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
```

`workflows/capture/vitest.config.ts`:
```ts
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
```

`workflows/capture/eslint.config.js`:
```js
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    // The stager is Node, not a Worker.
    files: ['scripts/*.mjs'],
    languageOptions: { globals: globals.node },
  },
])
```

- [ ] **Step 5: Copy the two libs verbatim and write `inputs.ts`**

```bash
cp workflows/workflow-studio/vendor/studio/lib/contactSheet.ts workflows/capture/scripts/lib/contactSheet.ts
cp workflows/workflow-studio/scripts/lib/fakeCtx.ts workflows/capture/scripts/lib/fakeCtx.ts
```

Edit the first line of `scripts/lib/contactSheet.ts` to read:
```ts
// Copied from workflows/workflow-studio/vendor/studio/lib/contactSheet.ts (itself frozen from bffless/apps apps/studio @ 22abda1). Pure planning only; capture uses planContactSheet, chunk and clockLabel.
```

Edit `scripts/lib/fakeCtx.ts`'s header comment to say "the `scripts/*.test.ts` suites" (drop the mention of six suites / Task 24); code unchanged.

`workflows/capture/scripts/lib/inputs.ts` (trimmed from workflow-studio's, plus three optional-shape guards the bundle step needs):
```ts
/**
 * The `ctx.inputs` guards the `script` modules share. A script step's inputs are the YAML's
 * `with` keys after expression evaluation, so they arrive as `unknown`; a precise Error naming
 * the script and the key is the useful failure (the harness shows it on the failed step).
 * Pure and DOM-free — these run inside the Worker.
 */
import type { FileRef } from '@bffless/workflow-script'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function inputError(script: string, key: string, expectation: string): Error {
  return new Error(`${script}: \`${key}\` ${expectation}`)
}

/** A finite number. Rejects a numeric string — the YAML's `${{ }}` keeps types. */
export function requireNumber(script: string, inputs: Record<string, unknown>, key: string): number {
  const v = inputs[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw inputError(script, key, 'must be a finite number')
  return v
}

/** A string; `''` is legitimate. */
export function requireString(script: string, inputs: Record<string, unknown>, key: string): string {
  const v = inputs[key]
  if (typeof v !== 'string') throw inputError(script, key, 'must be a string')
  return v
}

/** A string, or `''` when the input is null/undefined (an optional kickoff field left blank). */
export function optionalString(script: string, inputs: Record<string, unknown>, key: string): string {
  const v = inputs[key]
  if (v === null || v === undefined) return ''
  if (typeof v !== 'string') throw inputError(script, key, 'must be a string when present')
  return v
}

export function requireArray(script: string, inputs: Record<string, unknown>, key: string): unknown[] {
  const v = inputs[key]
  if (!Array.isArray(v)) throw inputError(script, key, 'must be a list')
  return v
}

export function requireNumbers(script: string, inputs: Record<string, unknown>, key: string): number[] {
  return requireArray(script, inputs, key).map((v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw inputError(script, key, 'must be a list of finite numbers')
    return v
  })
}

const isFileRef = (v: unknown): v is FileRef => isRecord(v) && typeof v.path === 'string' && v.path.length > 0

/** One harness File ref (`{ path, name, contentType, size, url }`). */
export function requireFileRef(script: string, inputs: Record<string, unknown>, key: string): FileRef {
  const v = inputs[key]
  if (!isFileRef(v)) throw inputError(script, key, 'must be a File ref')
  return v
}

export function requireFileRefs(script: string, inputs: Record<string, unknown>, key: string): FileRef[] {
  return requireArray(script, inputs, key).map((v) => {
    if (!isFileRef(v)) throw inputError(script, key, 'must be a list of File refs')
    return v
  })
}

/** A list of File refs, or `[]` when the input is null/undefined — the outputs of an
 *  `if:`-skipped step arrive as null (D9: no sheets is not a failure). */
export function optionalFileRefs(script: string, inputs: Record<string, unknown>, key: string): FileRef[] {
  const v = inputs[key]
  if (v === null || v === undefined) return []
  return requireFileRefs(script, inputs, key)
}
```

- [ ] **Step 6: Write the failing test for the copied planner**

`workflows/capture/scripts/lib/contactSheet.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { chunk, clockLabel, MAX_FRAMES, MAX_SHEETS, planContactSheet } from './contactSheet'

describe('planContactSheet (Studio budget, one recording)', () => {
  it('plans nothing for a zero or invalid duration', () => {
    expect(planContactSheet(0)).toEqual({ interval: 0, times: [], perSheet: 0 })
    expect(planContactSheet(Number.NaN).times).toEqual([])
  })

  it('samples a short clip at 5 s and prefers 9 cells per sheet', () => {
    const plan = planContactSheet(60)
    expect(plan.times).toHaveLength(12)
    expect(plan.perSheet).toBe(9)
    expect(chunk(plan.times, plan.perSheet)).toHaveLength(2)
    expect(plan.times[0]).toBeGreaterThan(0)
    expect(plan.times.at(-1)!).toBeLessThan(60)
  })

  it('spends the whole budget on a 20-minute recording: 120 frames at 10 s, 10 sheets of 12', () => {
    const plan = planContactSheet(1200)
    expect(plan.times).toHaveLength(MAX_FRAMES)
    expect(plan.interval).toBe(10)
    expect(plan.perSheet).toBe(12)
    expect(chunk(plan.times, plan.perSheet)).toHaveLength(MAX_SHEETS)
  })

  it('caps a very long recording at the frame budget', () => {
    expect(planContactSheet(4 * 3600).times).toHaveLength(MAX_FRAMES)
  })

  it('labels clocks as m:ss, promoting to h:mm:ss past an hour', () => {
    expect(clockLabel(0)).toBe('0:00')
    expect(clockLabel(75.9)).toBe('1:15')
    expect(clockLabel(3725)).toBe('1:02:05')
  })
})
```

- [ ] **Step 7: Register the package and install**

Add to the root `package.json` `scripts` (alphabetically after the `hello:*` block, before `workflow-studio:*`):
```json
    "capture:lint": "pnpm --filter ./workflows/capture run --if-present lint",
    "capture:stage": "pnpm --filter ./workflows/capture run --if-present stage",
    "capture:build": "pnpm --filter ./workflows/capture run --if-present build",
    "capture:test": "pnpm --filter ./workflows/capture run --if-present test:run",
```

Then:
```bash
pnpm install
```
Expected: `pnpm-lock.yaml` gains an `workflows/capture` importer; no errors.

- [ ] **Step 8: Run typecheck and the test**

```bash
pnpm --filter ./workflows/capture run typecheck
pnpm --filter ./workflows/capture run test:run
pnpm --filter ./workflows/capture run lint
```
Expected: `tsc` clean for both projects; 5 tests pass; ESLint clean.

- [ ] **Step 9: Stop and ask to commit**

Show `git status --short` and propose:
```
feat(capture): scaffold the capture implementation package with Studio's contact-sheet planner
```

---

### Task 2: `sheet-plan` script

**Files:**
- Create: `workflows/capture/scripts/sheet-plan.ts`
- Test: `workflows/capture/scripts/sheet-plan.test.ts`

**Interfaces:**
- Consumes: `planContactSheet`, `clockLabel` (Task 1); `requireNumber` (Task 1); `fakeCtx` (Task 1).
- Produces: script step contract `with: { duration: number }` → `{ times: number[], labels: string[], interval: number, perSheet: number }`. The workflow YAML (Task 5) names it `scripts/sheet-plan.js`.

- [ ] **Step 1: Write the failing test**

`workflows/capture/scripts/sheet-plan.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import sheetPlan from './sheet-plan'
import { fakeCtx } from './lib/fakeCtx'

describe('sheet-plan', () => {
  it('plans Studio-spaced captures with a clock label per time', async () => {
    const { ctx } = fakeCtx({ duration: 1200 })
    const out = await sheetPlan(ctx)
    const times = out.times as number[]
    const labels = out.labels as string[]
    expect(times).toHaveLength(120)
    expect(labels).toHaveLength(120)
    expect(labels[0]).toBe('0:05')
    expect(out.interval).toBe(10)
    expect(out.perSheet).toBe(12)
  })

  it('returns an empty plan and warns, rather than throwing, when there is no duration (D9)', async () => {
    const { ctx, annotations } = fakeCtx({ duration: 0 })
    const out = await sheetPlan(ctx)
    expect(out.times).toEqual([])
    expect(out.labels).toEqual([])
    expect(out.interval).toBe(0)
    expect(out.perSheet).toBe(0)
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning' })])
  })

  it('rejects a non-numeric duration', async () => {
    const { ctx } = fakeCtx({ duration: '1200' })
    await expect(sheetPlan(ctx)).rejects.toThrow('sheet-plan: `duration` must be a finite number')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter ./workflows/capture exec vitest run scripts/sheet-plan.test.ts
```
Expected: FAIL — `Cannot find module './sheet-plan'`.

- [ ] **Step 3: Write the script**

`workflows/capture/scripts/sheet-plan.ts`:
```ts
/**
 * `sheet-plan` — `sheets` → step `plan`.
 *
 *   with:    { duration }
 *   outputs: { times, labels, interval, perSheet }
 *
 * Studio's clip-wide contact-sheet plan for ONE recording (D4, D6): sample no finer than
 * 5 s and no coarser than 30 s, at most 120 frames, tiled into at most 10 sheets. `times`
 * are the seconds ffmpeg seeks; `labels` are the `m:ss` clocks `video/contact-sheet` burns
 * into each cell, parallel to `times`.
 *
 * A recording with no duration (the transcript heard nothing) plans no captures. That is
 * NOT a failure here (D9) — the workflow `if:`-skips the capture step on an empty plan and
 * the bundle still ships — but say so on the step card.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { clockLabel, planContactSheet } from './lib/contactSheet'
import { requireNumber } from './lib/inputs'

const NAME = 'sheet-plan'

export default async function sheetPlan(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const duration = requireNumber(NAME, ctx.inputs, 'duration')
  const plan = planContactSheet(duration)

  if (plan.times.length === 0) {
    ctx.annotate({
      level: 'warning',
      message:
        'No spoken audio was heard, so there is no duration to plan contact sheets from. The bundle will carry the transcript (if any) and no sheets.',
    })
    return { times: [], labels: [], interval: 0, perSheet: 0 }
  }

  const labels = plan.times.map((t) => clockLabel(t))
  ctx.log(`${plan.times.length} frames every ~${Math.round(plan.interval)} s, ${plan.perSheet} per sheet`)
  return { times: plan.times, labels, interval: plan.interval, perSheet: plan.perSheet }
}
```

- [ ] **Step 4: Run the test**

```bash
pnpm --filter ./workflows/capture exec vitest run scripts/sheet-plan.test.ts
pnpm --filter ./workflows/capture run typecheck
```
Expected: 3 pass; tsc clean.

- [ ] **Step 5: Stop and ask to commit**

```
feat(capture): add the sheet-plan script step
```

---

### Task 3: `bundle` script

**Files:**
- Create: `workflows/capture/scripts/bundle.ts`
- Test: `workflows/capture/scripts/bundle.test.ts`

**Interfaces:**
- Consumes: `clockLabel`, `requireFileRef`, `optionalFileRefs`, `optionalString`, `requireNumber`, `requireArray`, `requireString` (Task 1), `fakeCtx` (Task 1), `fflate` `zipSync`/`strToU8`/`unzipSync`/`strFromU8`.
- Produces: script step contract, named `scripts/bundle.js` by the YAML (Task 5):
  - `with`: `source` (FileRef), `direction` (string|null), `words` (array of `{word,start,end}`), `text` (string), `timed` (string), `duration` (number), `language` (string|null), `sheets` (FileRef[]|null), `times` (number[][]|null — the rule's per-sheet chunks), `cols` ((number|null)[]|null), `interval` (number), `perSheet` (number).
  - returns `{ zip: File, manifest: Manifest, transcript: string }`.
  - `Manifest` shape (exported type): `{ version: 1, createdAt: string, source: { name, path, duration, language: string|null }, direction: string, transcript: { words: 'transcript.json', timed: 'transcript.md', wordCount: number, bucketSeconds: 8 }, sheets: { file: string, cols: number|null, times: number[] }[], plan: { intervalSeconds: number, frames: number, cellHeight: 1080 }, warnings: string[] }`.

- [ ] **Step 1: Write the failing test**

`workflows/capture/scripts/bundle.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import type { FileRef } from '@bffless/workflow-script'
import bundle, { type Manifest } from './bundle'
import { fakeCtx } from './lib/fakeCtx'

const source: FileRef = { path: 'workflows/capture/inputs/walkthrough.mp4', name: 'walkthrough.mp4', contentType: 'video/mp4', size: 10, url: '/api/uploads/workflows/capture/inputs/walkthrough.mp4' }
const sheet = (n: number): FileRef => ({ path: `run/sheets/sheet-0${n}.jpg`, name: `sheet-0${n}.jpg`, contentType: 'image/jpeg', size: 3, url: `/api/uploads/run/sheets/sheet-0${n}.jpg` })
const words = [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'world', start: 0.5, end: 0.9 }]

const base = {
  source,
  direction: 'Make me a deck.',
  words,
  text: 'Hello world',
  timed: '[0:00] Hello world',
  duration: 120,
  language: 'en',
  sheets: [sheet(1), sheet(2)],
  times: [[15, 45, 75], [105]],
  cols: [3, 1],
  interval: 30,
  perSheet: 3,
}

const fetchBytes = async (ref: FileRef) => new Response(new Uint8Array([1, 2, ref.path.endsWith('1.jpg') ? 1 : 2]))

async function unzip(out: Record<string, unknown>) {
  const zip = out.zip as File
  return { zip, entries: unzipSync(new Uint8Array(await zip.arrayBuffer())) }
}

describe('bundle', () => {
  it('packs manifest, README, transcripts and sheets into one zip named after the source', async () => {
    const { ctx } = fakeCtx(base, fetchBytes)
    const out = await bundle(ctx)
    const { zip, entries } = await unzip(out)
    expect(zip.name).toBe('walkthrough.capture.zip')
    expect(zip.type).toBe('application/zip')
    expect(Object.keys(entries).sort()).toEqual(['README.md', 'manifest.json', 'sheets/sheet-01.jpg', 'sheets/sheet-02.jpg', 'transcript.json', 'transcript.md'])
    expect(Array.from(entries['sheets/sheet-01.jpg'])).toEqual([1, 2, 1])
    expect(JSON.parse(strFromU8(entries['transcript.json']))).toEqual(words)
  })

  it('writes the manifest the spec describes and returns it as an output too', async () => {
    const { ctx } = fakeCtx(base, fetchBytes)
    const out = await bundle(ctx)
    const { entries } = await unzip(out)
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Manifest
    expect(out.manifest).toEqual(manifest)
    expect(manifest.version).toBe(1)
    expect(manifest.source).toEqual({ name: 'walkthrough.mp4', path: source.path, duration: 120, language: 'en' })
    expect(manifest.direction).toBe('Make me a deck.')
    expect(manifest.transcript).toEqual({ words: 'transcript.json', timed: 'transcript.md', wordCount: 2, bucketSeconds: 8 })
    expect(manifest.sheets).toEqual([
      { file: 'sheets/sheet-01.jpg', cols: 3, times: [15, 45, 75] },
      { file: 'sheets/sheet-02.jpg', cols: 1, times: [105] },
    ])
    expect(manifest.plan).toEqual({ intervalSeconds: 30, frames: 4, cellHeight: 1080 })
    expect(manifest.warnings).toEqual([])
    expect(() => new Date(manifest.createdAt).toISOString()).not.toThrow()
  })

  it('leads transcript.md with the source, duration and the direction as a quote', async () => {
    const { ctx } = fakeCtx(base, fetchBytes)
    const out = await bundle(ctx)
    const md = out.transcript as string
    expect(md).toMatch(/^# walkthrough\.mp4 — 2:00\n/)
    expect(md).toContain('> Make me a deck.')
    expect(md.trimEnd().endsWith('[0:00] Hello world')).toBe(true)
    const { entries } = await unzip(out)
    expect(strFromU8(entries['transcript.md'])).toBe(md)
  })

  it('omits the quote when direction is blank', async () => {
    const { ctx } = fakeCtx({ ...base, direction: null }, fetchBytes)
    const out = await bundle(ctx)
    expect(out.transcript as string).not.toContain('>')
    expect((out.manifest as Manifest).direction).toBe('')
  })

  it('ships without sheets when the sheet step was skipped (D9), and says so', async () => {
    const { ctx, annotations } = fakeCtx({ ...base, sheets: null, times: null, cols: null, interval: 0, perSheet: 0 })
    const out = await bundle(ctx)
    const { entries } = await unzip(out)
    expect(Object.keys(entries).sort()).toEqual(['README.md', 'manifest.json', 'transcript.json', 'transcript.md'])
    const manifest = out.manifest as Manifest
    expect(manifest.sheets).toEqual([])
    expect(manifest.plan.frames).toBe(0)
    expect(manifest.warnings).toHaveLength(1)
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning' })])
  })

  it('fails loudly when a sheet cannot be fetched', async () => {
    const { ctx } = fakeCtx(base, async () => new Response(null, { status: 404 }))
    await expect(bundle(ctx)).rejects.toThrow('bundle: could not fetch sheet sheet-01.jpg (404)')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter ./workflows/capture exec vitest run scripts/bundle.test.ts
```
Expected: FAIL — `Cannot find module './bundle'`.

- [ ] **Step 3: Write the script**

`workflows/capture/scripts/bundle.ts`:
```ts
/**
 * `bundle` — `bundle` → step `bundle`.
 *
 *   with:    { source, direction, words, text, timed, duration, language,
 *              sheets, times, cols, interval, perSheet }
 *   outputs: { zip, manifest, transcript }
 *
 * The deliverable (D1): one archive a later Claude session fetches through the harness MCP
 * (`workflow_outputs` → the `zip` File ref's url). It holds `manifest.json` (what the run
 * was and how the pieces relate), `README.md` (how to read it), `transcript.md` (Studio's
 * 8-second `[m:ss]` buckets, led by the person's direction), `transcript.json` (word
 * timings) and `sheets/sheet-NN.jpg` — the contact sheets `video/contact-sheet` tiled.
 *
 * A Worker has no network but `ctx.files.fetch` (spec 03), which is how the sheet bytes
 * come back; a returned `File` becomes the `zip` output — the harness uploads it. `sheets`
 * / `times` / `cols` arrive null when the sheet step was `if:`-skipped (D9): the bundle
 * still ships, with a warning in the manifest and on the step card.
 */
import type { FileRef, ScriptContext } from '@bffless/workflow-script'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { clockLabel } from './lib/contactSheet'
import { optionalFileRefs, optionalString, requireArray, requireFileRef, requireNumber, requireString } from './lib/inputs'

const NAME = 'bundle'

/** The cell height `video/contact-sheet`'s `frames` op renders at (D5). Recorded, not chosen, here. */
const CELL_HEIGHT = 1080
/** `transcribe`'s `timed` groups words into 8-second lines (Studio's timedTranscript). */
const BUCKET_SECONDS = 8

export interface ManifestSheet {
  file: string
  cols: number | null
  times: number[]
}

export interface Manifest {
  version: 1
  createdAt: string
  source: { name: string; path: string; duration: number; language: string | null }
  direction: string
  transcript: { words: 'transcript.json'; timed: 'transcript.md'; wordCount: number; bucketSeconds: typeof BUCKET_SECONDS }
  sheets: ManifestSheet[]
  plan: { intervalSeconds: number; frames: number; cellHeight: typeof CELL_HEIGHT }
  warnings: string[]
}

const NO_SHEETS = 'No contact sheets: the recording had no spoken audio to plan captures from.'

function sheetFileName(index: number): string {
  return `sheets/sheet-${String(index + 1).padStart(2, '0')}.jpg`
}

/** `<basename without extension>.capture.zip` — a name that says which recording it was. */
function zipName(source: FileRef): string {
  const stem = source.name.replace(/\.[^.]+$/, '') || 'recording'
  return `${stem}.capture.zip`
}

function optionalNullable<T>(script: string, inputs: Record<string, unknown>, key: string, check: (v: unknown) => T): T | null {
  const v = inputs[key]
  if (v === null || v === undefined) return null
  return check(v)
}

function transcriptMarkdown(source: FileRef, duration: number, direction: string, timed: string): string {
  const lines = [`# ${source.name} — ${clockLabel(duration)}`, '']
  if (direction.trim()) {
    lines.push(...direction.trim().split('\n').map((l) => `> ${l}`), '')
  }
  lines.push(timed.trim(), '')
  return lines.join('\n')
}

function readme(manifest: Manifest): string {
  const sheets = manifest.sheets.length
    ? `- \`sheets/\` — ${manifest.sheets.length} contact sheet(s), ${manifest.sheets[0].cols ?? 3} columns, row-major; each cell is one still with its clock (m:ss) burned bottom-left. \`manifest.json\` → \`sheets[].times\` lists each sheet's seconds in cell order.`
    : `- No sheets: ${manifest.warnings.join(' ')}`
  return [
    `# Capture of ${manifest.source.name}`,
    '',
    `A ${clockLabel(manifest.source.duration)} recording, captured ${manifest.createdAt} by the \`capture\` workflow.`,
    '',
    `- \`manifest.json\` — what this is; start here.`,
    `- \`transcript.md\` — the spoken words in ${manifest.transcript.bucketSeconds}-second \`[m:ss]\` lines${manifest.direction ? ', led by the direction the person gave' : ''}.`,
    `- \`transcript.json\` — every word with its start/end second.`,
    sheets,
    '',
    'The run that produced this is listed by `workflow_runs { impl: "capture" }` on the harness MCP.',
    '',
  ].join('\n')
}

export default async function bundle(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const source = requireFileRef(NAME, ctx.inputs, 'source')
  const direction = optionalString(NAME, ctx.inputs, 'direction')
  const words = requireArray(NAME, ctx.inputs, 'words')
  const timed = requireString(NAME, ctx.inputs, 'timed')
  requireString(NAME, ctx.inputs, 'text') // present in the contract; the markdown carries `timed`
  const duration = requireNumber(NAME, ctx.inputs, 'duration')
  const language = optionalNullable(NAME, ctx.inputs, 'language', (v) => {
    if (typeof v !== 'string') throw new Error(`${NAME}: \`language\` must be a string when present`)
    return v
  })
  const sheets = optionalFileRefs(NAME, ctx.inputs, 'sheets')
  const times = optionalNullable(NAME, ctx.inputs, 'times', (v) => {
    if (!Array.isArray(v) || !v.every((row) => Array.isArray(row) && row.every((t) => typeof t === 'number'))) {
      throw new Error(`${NAME}: \`times\` must be a list of number lists when present`)
    }
    return v as number[][]
  }) ?? []
  const cols = optionalNullable(NAME, ctx.inputs, 'cols', (v) => {
    if (!Array.isArray(v)) throw new Error(`${NAME}: \`cols\` must be a list when present`)
    return v.map((c) => (typeof c === 'number' && c > 0 ? c : null))
  }) ?? []
  const interval = requireNumber(NAME, ctx.inputs, 'interval')
  requireNumber(NAME, ctx.inputs, 'perSheet')

  const warnings: string[] = []
  if (sheets.length === 0) {
    warnings.push(NO_SHEETS)
    ctx.annotate({ level: 'warning', message: NO_SHEETS })
  }

  const manifestSheets: ManifestSheet[] = sheets.map((_ref, i) => ({
    file: sheetFileName(i),
    cols: cols[i] ?? null,
    times: times[i] ?? [],
  }))

  const manifest: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: { name: source.name, path: source.path, duration, language },
    direction,
    transcript: { words: 'transcript.json', timed: 'transcript.md', wordCount: words.length, bucketSeconds: BUCKET_SECONDS },
    sheets: manifestSheets,
    plan: { intervalSeconds: interval, frames: manifestSheets.reduce((n, s) => n + s.times.length, 0), cellHeight: CELL_HEIGHT },
    warnings,
  }

  const transcript = transcriptMarkdown(source, duration, direction, timed)

  // Text is deflated; JPEGs are already compressed, so store them (level 0).
  const entries: Zippable = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'README.md': strToU8(readme(manifest)),
    'transcript.md': strToU8(transcript),
    'transcript.json': strToU8(JSON.stringify(words)),
  }
  for (const [i, ref] of sheets.entries()) {
    const res = await ctx.files.fetch(ref)
    if (!res.ok) throw new Error(`${NAME}: could not fetch sheet ${ref.name} (${res.status})`)
    entries[sheetFileName(i)] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }]
  }

  const bytes = zipSync(entries)
  ctx.log(`${zipName(source)}: ${sheets.length} sheet(s), ${words.length} words, ${Math.round(bytes.byteLength / 1024)} KB`)

  const zip = new File([bytes], zipName(source), { type: 'application/zip' })
  return { zip, manifest, transcript }
}
```

- [ ] **Step 4: Run the tests, typecheck, lint**

```bash
pnpm --filter ./workflows/capture exec vitest run scripts/bundle.test.ts
pnpm --filter ./workflows/capture run typecheck
pnpm --filter ./workflows/capture run lint
```
Expected: 6 pass; clean. If `File` is not in the `WebWorker` lib for TS 6, replace `new File(...)` with `new Blob([bytes], { type: 'application/zip' })` AND drop the `zip.name` assertion — but first check `pnpm --filter ./workflows/capture exec tsc -p tsconfig.scripts.json` output; `File` is in `lib.webworker.d.ts` and expected to compile.

- [ ] **Step 5: Stop and ask to commit**

```
feat(capture): add the bundle script step (manifest, transcripts, sheets → one zip)
```

---

### Task 4: Rule set `capture` (copied from workflow-studio, renamed)

**Files:**
- Create: `workflows/capture/.bffless/proxy-rules/capture/ruleset.yaml`
- Create: `workflows/capture/.bffless/proxy-rules/capture/schemas/capture_jobs.schema.yaml`, `capture_uploads.schema.yaml`
- Create: `workflows/capture/.bffless/proxy-rules/capture/rules/job/get/**`, `rules/video/extract-audio/post/**`, `rules/video/contact-sheet/post/**`, `rules/transcribe/post/**` (copies)

**Interfaces:**
- Produces (for Task 5's YAML): `POST video/extract-audio { source, outPrefix } → { jobId }`, result `{ path }`; `POST transcribe { audio, diarize, language } → { jobId }`, result `{ words, text, timed, duration, language }`; `POST video/contact-sheet { source, outPrefix, times, labels } → { jobId }`, result `{ paths, times, cols, drawn }`; `GET job?id= → { status, result, error, code }`.

- [ ] **Step 1: Copy the four rules and two schemas**

```bash
cd /home/rico/bffless/repos/workflow-implementations/.claude/worktrees/capture
SRC=workflows/workflow-studio/.bffless/proxy-rules/workflow-studio
DST=workflows/capture/.bffless/proxy-rules/capture
mkdir -p $DST/rules/job $DST/rules/video $DST/rules/transcribe $DST/schemas
cp -r $SRC/rules/job/get $DST/rules/job/get
cp -r $SRC/rules/video/extract-audio $DST/rules/video/extract-audio
cp -r $SRC/rules/video/contact-sheet $DST/rules/video/contact-sheet
cp -r $SRC/rules/transcribe/post $DST/rules/transcribe/post
cp $SRC/schemas/workflow_studio_jobs.schema.yaml $DST/schemas/capture_jobs.schema.yaml
cp $SRC/schemas/workflow_studio_uploads.schema.yaml $DST/schemas/capture_uploads.schema.yaml
```

- [ ] **Step 2: Rename every schema id and set name**

```bash
grep -rl 'workflow_studio_' $DST | xargs sed -i 's/workflow_studio_jobs/capture_jobs/g; s/workflow_studio_uploads/capture_uploads/g'
grep -rn 'workflow_studio\|workflow-studio' $DST ; echo "exit=$? (1 means clean)"
```
Expected: the second command prints nothing and `exit=1`.

- [ ] **Step 3: Write `ruleset.yaml` and reword the rule descriptions**

`$DST/ruleset.yaml`:
```yaml
name: capture
description: "Backend of the capture workflow: the async job poll and the three Studio-derived pipelines it needs — video/extract-audio and video/contact-sheet (CE ffmpeg ops, enqueued) and transcribe (WhisperX on Replicate, word timings). No AI stages: the bundle is for a later Claude session to read."
```

In `$DST/rules/job/get/rule.yaml` change `name: Workflow Studio job poll` → `name: Capture job poll`, and in both `description:` strings replace "studio.workflow.yaml" with "capture.workflow.yaml" and "Workflow Studio" with "Capture" (keep the rest of the sentences).

In `$DST/rules/video/contact-sheet/post/rule.yaml`, inside the `sheets` step's `config:` (the `operation: frames` block), add directly under `outputPrefix:`:
```yaml
        # D5: a capture sheet is read by a person/agent zooming into screen text, not by a
        # model at ~1 MP, so cells render at 1080 rows (CE default 720). 3 columns → 5760 px wide.
        height: 1080
```
Change that rule's `name:` to `Capture contact sheets (ffmpeg frames + tile, async)`; leave its description's Studio history sentence intact (it is provenance, not identity).

- [ ] **Step 4: Validate and run the fixture tests**

```bash
pnpm --filter ./workflows/capture run rules:validate
pnpm --filter ./workflows/capture run rules:test
```
Expected: both exit 0; `rules:test` runs every `*.fn.test.yaml` under the four rules (prep/check/sweep/flatten/shape) and reports all cases passing. If `rules validate` complains that `height` is not a known `frames` key, check `repos/ce/apps/backend/src/pipelines/handlers/ffmpeg.handler.ts` line ~279 (`this.knob(config.height, 'height', 'integer')`) — the knob exists; the complaint would be a CLI schema lag, in which case record it in `bffless/README.md` and keep the key.

- [ ] **Step 5: Stop and ask to commit**

```
feat(capture): add the capture rule set (job, extract-audio, contact-sheet at 1080, transcribe)
```

---

### Task 5: Workflow YAML + stager + build test

**Files:**
- Create: `workflows/capture/.bffless/workflows/capture.workflow.yaml`
- Create: `workflows/capture/scripts/stage.mjs`
- Test: `workflows/capture/scripts/build.test.ts`

**Interfaces:**
- Consumes: rules from Task 4; scripts `scripts/sheet-plan.js`, `scripts/bundle.js` (Tasks 2–3) with the input/output names defined there.
- Produces: `dist/` bundle (`.bffless/workflows/index.json`, `scripts/*.js`, `index.html`) that `publish-workflow@v1` uploads (Task 6); `stage.mjs --impl <alias> --name <display>` flags the preview workflow uses.

- [ ] **Step 1: Write the workflow**

`workflows/capture/.bffless/workflows/capture.workflow.yaml`:
```yaml
spec: 1
name: Capture a recording for Claude
description: >
  Turn one screen recording into context a later Claude session can work from: the transcript
  with word timings, contact sheets with the clock burned into every still, and your own
  direction text — packed into one zip you fetch through the harness MCP.

on:
  manual:
    inputs:
      recording: { type: file, accept: "video/*", required: true, maxSize: 5GB, label: Recording }
      direction:
        type: string
        format: textarea
        label: Direction
        description: "What you want done with this recording, in your own words. Carried into the bundle verbatim for the Claude session that reads it."
      # WhisperX's `language`, pinned by default (same reasoning as Studio: a wrong auto-detect
      # loses every word timing). The list is exactly the languages WhisperX can align.
      language:
        type: choice
        default: en
        label: Spoken language
        description: "Pick it rather than auto-detect when you can: a wrong guess loses every word timing, and the run stops."
        options:
          - { value: auto, label: "Auto-detect (may guess wrong)" }
          - { value: en, label: English }
          - { value: es, label: Spanish }
          - { value: fr, label: French }
          - { value: de, label: German }
          - { value: it, label: Italian }
          - { value: pt, label: Portuguese }
          - { value: nl, label: Dutch }
          - { value: sv, label: Swedish }
          - { value: da, label: Danish }
          - { value: no, label: Norwegian }
          - { value: fi, label: Finnish }
          - { value: pl, label: Polish }
          - { value: cs, label: Czech }
          - { value: hu, label: Hungarian }
          - { value: el, label: Greek }
          - { value: tr, label: Turkish }
          - { value: ru, label: Russian }
          - { value: uk, label: Ukrainian }
          - { value: ja, label: Japanese }
          - { value: zh, label: Chinese }
          - { value: ko, label: Korean }
          - { value: vi, label: Vietnamese }
          - { value: ar, label: Arabic }
          - { value: he, label: Hebrew }
          - { value: hi, label: Hindi }
          - { value: ur, label: Urdu }
          - { value: fa, label: Persian }
          - { value: ca, label: Catalan }
          - { value: eu, label: Basque }
          - { value: gl, label: Galician }
          - { value: te, label: Telugu }
          - { value: ml, label: Malayalam }
          - { value: ka, label: Georgian }
          - { value: lv, label: Latvian }
          - { value: sk, label: Slovak }
          - { value: sl, label: Slovenian }
          - { value: hr, label: Croatian }
          - { value: ro, label: Romanian }
          - { value: bg, label: Bulgarian }
          - { value: nn, label: Norwegian Nynorsk }
          - { value: tl, label: Tagalog }

outputs:
  bundle:     ${{ jobs.bundle.outputs.zip }}
  transcript: ${{ jobs.bundle.outputs.transcript }}
  words:      ${{ jobs.extract.outputs.words }}
  sheets:     ${{ jobs.sheets.outputs.sheets }}
  manifest:   ${{ jobs.bundle.outputs.manifest }}

jobs:
  extract:
    name: Audio and transcript
    steps:
      - id: audio
        name: Pull the audio out
        uses: pipeline
        with:
          path: video/extract-audio
          # No `executor`: the instance's configured default executor runs (Admin → Features → Executor).
          body: { source: "${{ inputs.recording.path }}", outPrefix: "${{ step.prefix }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          wav: { type: file, value: "${{ response.result.path }}" }
      - id: transcribe
        name: Write the transcript
        uses: pipeline
        with: { path: transcribe, body: { audio: "${{ steps.audio.outputs.wav.path }}", diarize: false, language: "${{ inputs.language }}" } }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 5s, timeout: 30m }
        outputs:
          words:    { type: json, value: "${{ response.result.words }}", render: transcript }
          text:     { type: string, value: "${{ response.result.text }}" }
          timed:    { type: string, value: "${{ response.result.timed }}" }
          duration: { type: number, value: "${{ response.result.duration }}", format: seconds }
          language: { type: string, value: "${{ response.result.language }}" }
        summary: "Transcribed **${{ inputs.recording.name }}** (${{ steps.transcribe.outputs.language }}) — ${{ length(steps.transcribe.outputs.words) }} words."
        annotations:
          - { level: warning, if: "${{ length(steps.transcribe.outputs.words) < 50 }}", message: "Very short transcript — is the audio silent?" }
    outputs:
      source:   { type: file, value: "${{ inputs.recording }}" }
      wav:      ${{ steps.audio.outputs.wav }}
      words:    ${{ steps.transcribe.outputs.words }}
      text:     ${{ steps.transcribe.outputs.text }}
      timed:    ${{ steps.transcribe.outputs.timed }}
      duration: ${{ steps.transcribe.outputs.duration }}
      language: ${{ steps.transcribe.outputs.language }}

  sheets:
    name: Contact sheets
    needs: extract
    steps:
      - id: plan
        name: Plan the captures
        uses: script
        with:
          src: scripts/sheet-plan.js
          duration: ${{ needs.extract.outputs.duration }}
        outputs:
          times:    { type: json }
          labels:   { type: json }
          interval: { type: number, format: seconds }
          perSheet: { type: number }
      - id: sheets
        name: Grab the stills
        uses: pipeline
        # An empty plan (no spoken audio) skips this step and its outputs are null; `bundle`
        # tolerates that (D9). `video/contact-sheet` refuses an empty `times` anyway.
        if: "${{ length(steps.plan.outputs.times) > 0 }}"
        with:
          path: video/contact-sheet
          body: { source: "${{ inputs.recording.path }}", outPrefix: "${{ step.prefix }}", times: "${{ steps.plan.outputs.times }}", labels: "${{ steps.plan.outputs.labels }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          sheets: { type: file, list: true, value: "${{ response.result.paths }}", render: images }
          times:  { type: json, value: "${{ response.result.times }}" }
          cols:   { type: json, value: "${{ response.result.cols }}" }
        summary: "${{ length(steps.sheets.outputs.sheets) }} contact sheet(s), ${{ length(steps.plan.outputs.times) }} stills."
    outputs:
      sheets:   ${{ steps.sheets.outputs.sheets }}
      times:    ${{ steps.sheets.outputs.times }}
      cols:     ${{ steps.sheets.outputs.cols }}
      interval: ${{ steps.plan.outputs.interval }}
      perSheet: ${{ steps.plan.outputs.perSheet }}

  bundle:
    name: Pack the bundle
    needs: [extract, sheets]
    steps:
      - id: bundle
        name: Pack the bundle
        uses: script
        with:
          src: scripts/bundle.js
          source:    ${{ needs.extract.outputs.source }}
          direction: ${{ inputs.direction }}
          words:     ${{ needs.extract.outputs.words }}
          text:      ${{ needs.extract.outputs.text }}
          timed:     ${{ needs.extract.outputs.timed }}
          duration:  ${{ needs.extract.outputs.duration }}
          language:  ${{ needs.extract.outputs.language }}
          sheets:    ${{ needs.sheets.outputs.sheets }}
          times:     ${{ needs.sheets.outputs.times }}
          cols:      ${{ needs.sheets.outputs.cols }}
          interval:  ${{ needs.sheets.outputs.interval }}
          perSheet:  ${{ needs.sheets.outputs.perSheet }}
        outputs:
          zip:        { type: file }
          manifest:   { type: json }
          transcript: { type: markdown }
        summary: "Bundle ready: **${{ steps.bundle.outputs.zip.name }}** (${{ length(steps.bundle.outputs.manifest.sheets) }} sheets, ${{ steps.bundle.outputs.manifest.transcript.wordCount }} words)."
    outputs:
      zip:        ${{ steps.bundle.outputs.zip }}
      manifest:   ${{ steps.bundle.outputs.manifest }}
      transcript: ${{ steps.bundle.outputs.transcript }}
```

If `workflow index` (Step 4) rejects `format: seconds` on a `number` output or `inputs.recording.name` in a summary, drop that key/expression rather than fighting the linter, and note the finding in the PR description.

- [ ] **Step 2: Write the stager**

`workflows/capture/scripts/stage.mjs` — workflow-studio's `scripts/stage.mjs` with islands and skills removed. Copy it, then apply exactly these edits:

1. Header comment: replace the first paragraph with
   ```
   // Stage the `capture` bundle: type-check, build each `script` step as one self-contained ES
   // module, then let `@bffless/workflow-lint`'s `workflow index` verb lint `.bffless/workflows/`
   // and write the bundle's index.json + a landing page. Trimmed from
   // workflows/workflow-studio/scripts/stage.mjs (no islands, no skills).
   ```
2. `const TSCONFIGS = ['tsconfig.scripts.json', 'tsconfig.node.json']`
3. `const SCRIPTS = ['bundle', 'sheet-plan']`
4. `const DESCRIPTION = 'Turn one screen recording into context for a later Claude session: a word-timed transcript, contact sheets with the clock burned in, and your direction — one zip, fetched through the harness MCP.'`
5. `const BUNDLE_ENTRIES = ['.bffless', 'scripts', 'index.html']`
6. `const impl = flagValue('--impl', 'capture')` and `const name = flagValue('--name', 'Capture')`
7. `mkdtempSync(join(tmpdir(), 'capture-stage-'))`
8. Delete the whole "Islands" block (from its comment banner through the `for (const island …)` loop) and the whole "Skills" block (comment banner through `cpSync(...)`). Remove `cpSync` from the `node:fs` import.
9. In the `workflow index` args: `'--rules', '.bffless/proxy-rules/capture', '--path-prefix', '/api/capture'`.

- [ ] **Step 3: Write the build test**

`workflows/capture/scripts/build.test.ts` — copy `workflows/workflow-studio/scripts/build.test.ts` and change:
- header: "each of the two entries"
- `const SCRIPT_NAMES = ['bundle', 'sheet-plan']`
- remove the "Task 24's stager" sentence (say "the stager builds both before CI stages the bundle").

- [ ] **Step 4: Stage, then test**

```bash
pnpm --filter ./workflows/capture run stage
ls workflows/capture/dist workflows/capture/dist/scripts workflows/capture/dist/.bffless/workflows
node -e "const i=require('./workflows/capture/dist/.bffless/workflows/index.json'); console.log(i.impl, i.workflows.map(w=>w.id||w.name), i.scripts)"
pnpm --filter ./workflows/capture run test:run
pnpm --filter ./workflows/capture run lint
```
Expected: stage prints `staged …/dist` with zero lint findings (the `rule-missing` check sees `rules/job/get`, `rules/video/extract-audio/post`, `rules/video/contact-sheet/post`, `rules/transcribe/post`); `dist/scripts/{bundle,sheet-plan}.js` exist; `index.json` has `impl: "capture"` and lists both scripts; vitest now runs `build.test.ts` too (2 more passes, not skipped); ESLint clean including `stage.mjs`.

Also run the root aggregates once:
```bash
pnpm run rules:validate && pnpm run rules:test && node scripts/check-identity.mjs
```
Expected: the first two pass for all three packages; `check-identity` FAILS for `capture` with `deploy-capture.yml` missing — that is Task 6's job; note it and move on.

- [ ] **Step 5: Stop and ask to commit**

```
feat(capture): add capture.workflow.yaml (extract → sheets → bundle) and the stager
```

---

### Task 6: Deploy + preview workflows, READMEs

**Files:**
- Create: `.github/workflows/deploy-capture.yml`
- Create: `.github/workflows/preview-capture.yml`
- Create: `workflows/capture/README.md`
- Create: `workflows/capture/bffless/README.md`
- Modify: `README.md` (repo root) — mention `capture` in the layout example list

**Interfaces:**
- Consumes: `pnpm --filter ./workflows/capture run stage [--impl X --name Y]` (Task 5); dist paths.
- Produces: alias `capture` on both harnesses after merge; `capture-pr-<n>` on j5s per PR.

- [ ] **Step 1: Write `deploy-capture.yml`**

Copy `.github/workflows/deploy-workflow-studio.yml` and apply:
- `name: Deploy capture`
- both `paths:` entries → `'workflows/capture/**'`, `'.github/workflows/deploy-capture.yml'`
- `concurrency: { group: deploy-capture, cancel-in-progress: false }`
- in BOTH jobs: `run: pnpm --filter ./workflows/capture run stage`; `alias: capture`; `name: Capture`; `description:` = the exact `DESCRIPTION` string from `stage.mjs` (Task 5 step 2 item 4); `path: workflows/capture/dist`; `workflows: workflows/capture/.bffless/workflows`; `rules: workflows/capture/.bffless/proxy-rules/capture`; `EXPECTED_IMPL: capture`; the `node -e` reads `workflows/capture/dist/.bffless/workflows/index.json`.
- Replace the header comment with:
  ```
  # Publishes workflows/capture/ to the harness project as the `capture` implementation (lint +
  # index the workflow, sync the rule set under /api/capture/, upload the bundle to the alias,
  # attach the set to the harness alias — all inside `bffless/publish-workflow@v1`), first to the
  # j5s harness (canary), then to workflow.bffless.dev. Same shape as deploy-workflow-studio.yml.
  ```
- Keep the `publish-bffless-dev` job's `needs: publish` and its `BFFLESS_DEV_URL`/`BFFLESS_DEV_API_KEY` references verbatim.

- [ ] **Step 2: Write `preview-capture.yml`**

Copy `.github/workflows/preview-workflow-studio.yml` and apply: `name: Preview capture`; paths → `'workflows/capture/**'`, `'.github/workflows/preview-capture.yml'`; concurrency group `preview-capture-${{ github.event.number }}`; stage line `"pnpm --filter ./workflows/capture run stage --impl capture-pr-${{ github.event.number }} --name 'Capture (PR #${{ github.event.number }})'"`; `alias: capture-pr-${{ github.event.number }}`; `name: "Capture (PR #${{ github.event.number }})"`; the same `description:` string; the three `workflows/capture/...` paths; `EXPECTED_IMPL: capture-pr-${{ github.event.number }}`; the teardown job's alias likewise.

- [ ] **Step 3: Verify identity and YAML**

```bash
node scripts/check-identity.mjs
npx --yes actionlint .github/workflows/deploy-capture.yml .github/workflows/preview-capture.yml 2>&1 | head -20
```
Expected: `capture: alias "capture" matches deploy-capture.yml`; actionlint reports nothing (if `npx actionlint` is unavailable, `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/deploy-capture.yml .github/workflows/preview-capture.yml` must exit 0).

- [ ] **Step 4: Write `workflows/capture/README.md`**

```markdown
# Capture

A Workflow-harness implementation (`bffless/apps` → `apps/workflow`) that turns **one screen
recording** into context a later Claude session can work from: the transcript with word
timings, Studio-style contact sheets with the clock burned into every still, and the
direction you typed at kickoff — packed into one `<recording>.capture.zip`.

It is a simplified Studio: Studio's first two jobs (audio → transcript, planned contact
sheets), none of its AI or editing stages, a bundle at the end instead of a short. Design:
[`docs/superpowers/specs/2026-09-05-capture-workflow-design.md`](../../docs/superpowers/specs/2026-09-05-capture-workflow-design.md).

## What a run produces

| Output | Type | What |
| --- | --- | --- |
| `bundle` | file | `manifest.json`, `README.md`, `transcript.md`, `transcript.json`, `sheets/sheet-NN.jpg` |
| `transcript` | markdown | 8-second `[m:ss]` lines, led by your direction as a quote |
| `words` | json | WhisperX word timings `[{ word, start, end }]` |
| `sheets` | file list | the contact sheets (3 columns, 1080-row cells, clock bottom-left) |
| `manifest` | json | source, duration, language, direction, per-sheet timestamps |

A recording with no spoken audio still produces a bundle — with no sheets and a warning.

## Reading a run from a Claude session

The harness's MCP server exposes runs to any connected Claude session:

1. `workflow_runs { impl: "capture", status: "succeeded" }` — pick the run.
2. `workflow_outputs { runId }` — the `bundle` File ref carries a fetchable `url`.
3. Fetch and unzip it; read `manifest.json` first, then `transcript.md`; open `sheets/*.jpg`
   as images. `manifest.sheets[].times` maps each cell (row-major) to a second.

Want a share link? Upload the zip to a Handoff deployment with the `handoff-api` skill
(`prepare → PUT → register` into a folder of your choosing). Publishing it from inside the run is
a planned follow-up (spec → Follow-ups).

## Development

- `pnpm --filter ./workflows/capture run typecheck` — `tsc -p tsconfig.scripts.json && tsc -p tsconfig.node.json`
- `pnpm --filter ./workflows/capture run lint` — ESLint
- `pnpm --filter ./workflows/capture run stage` — type-check, build `scripts/{sheet-plan,bundle}.ts`
  into `dist/scripts/`, then `workflow index` into `dist/` (also lints the workflow against the
  rule set). `build` is the same command.
- `pnpm --filter ./workflows/capture run test:run` — Vitest. Run **after** `stage`:
  `scripts/build.test.ts` inspects the built scripts and skips itself when `dist/` is absent.
- `pnpm --filter ./workflows/capture run rules:validate` / `rules:test` — the rule set's
  validation and `*.fn.test.yaml` fixtures.

## Layout

- `.bffless/workflows/capture.workflow.yaml` — the contract: three jobs, `extract` → `sheets` → `bundle`.
- `.bffless/proxy-rules/capture/` — four rules copied from `workflow-studio` and renamed
  (`job/get`, `video/extract-audio`, `video/contact-sheet` at `height: 1080`, `transcribe`)
  over schemas `capture_jobs` / `capture_uploads`.
- `scripts/` — the two `script` steps (Worker, opaque origin, `ctx.files.fetch` only) and
  `scripts/lib/` (Studio's pure `contactSheet.ts` planner, input guards, a test-only fake ctx).
- `bffless/README.md` — the per-project setup the rule set does not carry.

## Deploy

A merge to `main` that touches `workflows/capture/**` runs `.github/workflows/deploy-capture.yml`:
publish to the j5s harness, then to `workflow.bffless.dev`. PRs get `capture-pr-<n>` on j5s
(`preview-capture.yml`), torn down on close.
```

- [ ] **Step 5: Write `workflows/capture/bffless/README.md`**

```markdown
# Capture — backend and project setup

The backend is the authored rule set `.bffless/proxy-rules/capture/`, published under
`/api/capture/…` in project `bffless/workflow` on each harness instance by `publish-workflow@v1`.
Nothing here is standalone; see `workflows/workflow-studio/bffless/README.md` for the shared
harness-project conventions (rule-set isolation, the `/w/<alias>/*` forwarder, no domain needed).

## Manual setup (per instance) — nothing new

`transcribe` runs WhisperX on Replicate. It needs, on project `bffless/workflow`:

| Needs | Used by | Already there because |
| --- | --- | --- |
| `HF_TOKEN` secret | `transcribe` (`victor-upmeet/whisperx`) | Studio's `transcribe` uses the same rule |
| Replicate provider token (Settings → AI) | `transcribe` | same |

Before the first live run on an instance, check both: MCP `list_secrets` for
`bffless/workflow` lists `HF_TOKEN`, and a Studio run has succeeded there. The ffmpeg ops use
the instance's default executor (Admin → Features → Executor) exactly as Studio's do.

Schemas `capture_jobs` and `capture_uploads` carry no `id:`; the first publish creates them.

## Rules

| Rule | Copied from workflow-studio | Change |
| --- | --- | --- |
| `job/get` | ✓ | schema id, wording |
| `video/extract-audio/post` | ✓ | schema id |
| `video/contact-sheet/post` | ✓ | schema id; `frames.height: 1080` (spec D5) |
| `transcribe/post` | ✓ | schema id; `diarize` still accepted, the workflow sends `false` |
```

- [ ] **Step 6: Update the root README layout snippet**

In `README.md` (repo root), change the line
```
    <impl>/               # one directory per implementation (hello, workflow-studio, …)
```
to
```
    <impl>/               # one directory per implementation (hello, workflow-studio, capture, …)
```

- [ ] **Step 7: Full local CI pass**

```bash
node scripts/check-identity.mjs
pnpm run capture:lint && pnpm run capture:stage && pnpm run capture:test
pnpm run rules:validate && pnpm run rules:test
```
Expected: all green.

- [ ] **Step 8: Stop and ask to commit, then to push and open the PR**

```
feat(capture): deploy + preview workflows and READMEs
```

PR title (conventional; the squash commit inherits it): `feat(capture): recording → transcript + contact sheets bundle for Claude sessions`. Body: link the spec and plan, list the three follow-up issues to file, and state that the merge is a live deploy to both harnesses. Push every commit before opening the PR (workspace memory: the user merges fast).

---

### Task 7: Live walk on the PR preview, then merge

**Files:** none (verification only; findings go into the PR description or new issues).

- [ ] **Step 1: Wait for `Preview capture` to publish `capture-pr-<n>`**

```bash
gh run list --workflow preview-capture.yml --limit 3
```
Expected: the latest run is `completed success`. Then from a Claude session with the harness MCP connected: `workflow_list { impl: "capture-pr-<n>" }` shows one workflow with `headlessSafe: true`.

- [ ] **Step 2: Confirm the j5s project prerequisites**

`list_secrets` (j5s MCP) on `bffless/workflow` lists `HF_TOKEN`. Note the result in the PR.

- [ ] **Step 3: Run it once with a short recording**

Open `https://workflow.j5s.dev/w/capture-pr-<n>/` (or whatever `workflow_describe` reports as the page), upload a 1–3 minute screen recording with speech, type a one-line direction, keep English, start. Watch: `extract` (audio + transcribe), `sheets` (plan + stills), `bundle`.

- [ ] **Step 4: Read it back the way a later session will**

`workflow_runs { impl: "capture-pr-<n>", status: "succeeded" }` → `workflow_outputs { runId }` → fetch the `bundle` url with `curl -L -o /tmp/claude-…/scratchpad/capture.zip` → `unzip -l`. Check: five entry kinds present; `manifest.json` fields as the spec's sample; `transcript.md` starts with `# <name> — m:ss` and the quoted direction; each sheet opens (Read tool) and the clock labels and screen text are legible at zoom.

- [ ] **Step 5: Record findings and merge**

Paste the manifest excerpt and one sheet observation into the PR. Any deviation from the spec → fix on the branch (re-run from Task 5 Step 4) before merge. Merging is the user's call and is a live deploy to both harnesses; after merge, repeat Step 4 once against `workflow.bffless.dev` (`workflow_list` there should show `capture`).

- [ ] **Step 6: File the follow-ups**

Three issues, referenced from the PR: (1) `bffless/apps` — Handoff `POST /api/import { url, parentId, filename }` via `file_upload_handler sourceUrl`, and here a `publish` job (spec D2); (2) `bffless/apps` (workflow harness) — per-workflow `keep:` retention; (3) this repo — expose contact-sheet cell height as a kickoff input if 1080 proves wrong.
