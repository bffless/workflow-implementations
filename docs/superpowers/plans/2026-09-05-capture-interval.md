# Capture Interval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the capture workflow's fixed Studio still budget with a person-chosen `interval` (seconds between stills), batching captures through CE's 200-still-per-job ceiling, and cap what the bundle zip embeds at 150 MB — on the open `feat/capture` branch (PR #9) before its first deploy.

**Architecture:** `sheet-plan` becomes an interval planner that emits `batches` of ≤200 `{ times, labels }`; a new `plan` job runs it and a `sheets` matrix job fans one `video/contact-sheet` call per batch; `bundle` flattens the per-leg lists, embeds sheets only while their total stays ≤ 150 MB (D10), and records `embedded`, per-sheet `path`, and the new `plan` shape in the manifest. Warnings fire on the plan step (>120 stills) and in the field description (D11).

**Tech Stack:** unchanged — TypeScript scripts under `tsconfig.scripts.json` (WebWorker lib), Vitest, fflate, the harness YAML (spec 01/02), `@bffless/workflow-lint` via `scripts/stage.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-05-capture-workflow-design.md` — amended 2026-09-05 (D4 rewritten, D10, D11, the `plan`/`sheets` jobs, the manifest sample). Binding.

## Global Constraints

- Work in the worktree `/home/rico/bffless/repos/workflow-implementations/.claude/worktrees/capture`, branch `feat/capture`; `git rev-parse --show-toplevel` before the first edit of every task. Never touch `workflows/workflow-studio/` or `workflows/hello/`.
- Local per-task commits are approved (conventional `feat(capture): …` / `refactor(capture): …`, trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GLtHDFR2Cf7H2KnQuj3J6n`). Do not push; the controller pushes.
- Scripts run in a Worker: `tsconfig.scripts.json` stays `"lib": ["ES2023", "WebWorker"]`, `"types": []`; the only network is `ctx.files.fetch`. Every declared script output must be present in the return value.
- Constants (exact): `MAX_STILLS_PER_JOB = 200` (CE `ffmpeg.handler.ts`, per request), `PER_SHEET = 12` (the rule's `tile.perSheet` literal), `WARN_STILLS = 120`, `SHEET_MB_ESTIMATE = 2.4`, `EMBED_CAP_BYTES = 150 * 1024 * 1024`, `CELL_HEIGHT = 1080`, `BUCKET_SECONDS = 8`.
- Output names in YAML match `^[a-z][a-z0-9_-]*$`.
- D9 holds: no spoken audio never fails the run — one empty batch, the matrix leg is `if:`-skipped, the bundle ships with a warning.
- Every verify chain includes `pnpm --filter ./workflows/capture run typecheck` (vitest does not typecheck).

---

### Task 1: `lib/clock.ts` and the interval planner

**Files:**
- Create: `workflows/capture/scripts/lib/clock.ts`, `workflows/capture/scripts/lib/clock.test.ts`
- Delete: `workflows/capture/scripts/lib/contactSheet.ts`, `workflows/capture/scripts/lib/contactSheet.test.ts`
- Modify: `workflows/capture/scripts/sheet-plan.ts`, `workflows/capture/scripts/sheet-plan.test.ts`
- Modify: `workflows/capture/scripts/bundle.ts` line 22 only — `import { clockLabel } from './lib/contactSheet'` → `import { clockLabel } from './lib/clock'` (so the package still type-checks; Task 2 owns the rest of that file)

**Interfaces:**
- Produces: `clockLabel(seconds: number): string`, `chunk<T>(items: T[], size: number): T[][]` from `scripts/lib/clock.ts`.
- Produces: script `sheet-plan` — `with: { duration: number, interval: number }` → `{ batches: { times: number[]; labels: string[] }[], stills: number, sheets: number }`. Exported type `Batch = { times: number[]; labels: string[] }`.

- [ ] **Step 1: Write `lib/clock.ts`** — `clockLabel` and `chunk` copied verbatim from `lib/contactSheet.ts` (they are Studio's), with this header:

```ts
/**
 * The two pure helpers capture keeps from Studio's contactSheet.ts (bffless/apps apps/studio
 * @ 22abda1): `clockLabel` is the `m:ss` / `h:mm:ss` clock burned onto every still and
 * printed in transcripts; `chunk` splits a list into fixed-size pieces (the ≤200-still
 * batches CE's `frames` op accepts per request). Studio's budget planner is gone — the
 * person chooses the density at kickoff (spec D4, amended 2026-09-05).
 */
```

- [ ] **Step 2: Write the failing `lib/clock.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { chunk, clockLabel } from './clock'

describe('clockLabel', () => {
  it('formats m:ss, promoting to h:mm:ss past an hour', () => {
    expect(clockLabel(0)).toBe('0:00')
    expect(clockLabel(75.9)).toBe('1:15')
    expect(clockLabel(3725)).toBe('1:02:05')
    expect(clockLabel(-3)).toBe('0:00')
  })
})

describe('chunk', () => {
  it('splits into pieces of at most size, last piece shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([1, 2], 5)).toEqual([[1, 2]])
    expect(chunk([], 3)).toEqual([])
  })
})
```

Delete `lib/contactSheet.ts` and `lib/contactSheet.test.ts` (`git rm`). Run `pnpm --filter ./workflows/capture exec vitest run scripts/lib/clock.test.ts` — expected FAIL (module missing) before Step 1's file exists; PASS after. Do the import swap in `bundle.ts` line 22 now.

- [ ] **Step 3: Write the failing `sheet-plan.test.ts`** (replace the file):

```ts
import { describe, expect, it } from 'vitest'
import sheetPlan, { type Batch } from './sheet-plan'
import { fakeCtx } from './lib/fakeCtx'

const batchesOf = (out: Record<string, unknown>) => out.batches as Batch[]

describe('sheet-plan', () => {
  it('plans one still every interval seconds, centred, labelled m:ss', async () => {
    const { ctx, annotations } = fakeCtx({ duration: 60, interval: 5 })
    const out = await sheetPlan(ctx)
    const batches = batchesOf(out)
    expect(batches).toHaveLength(1)
    expect(batches[0].times).toEqual([2.5, 7.5, 12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5, 52.5, 57.5])
    expect(batches[0].labels.slice(0, 3)).toEqual(['0:02', '0:07', '0:12'])
    expect(out.stills).toBe(12)
    expect(out.sheets).toBe(1)
    expect(annotations).toEqual([])
  })

  it('splits a dense long plan into batches of at most 200 and warns above 120 stills', async () => {
    const { ctx, annotations } = fakeCtx({ duration: 1200, interval: 1 })
    const out = await sheetPlan(ctx)
    const batches = batchesOf(out)
    expect(out.stills).toBe(1200)
    expect(batches).toHaveLength(6)
    expect(batches.every((b) => b.times.length === 200 && b.labels.length === 200)).toBe(true)
    expect(batches[5].times.at(-1)).toBe(1199.5)
    expect(out.sheets).toBe(100)
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringMatching(/1200 stills.*100 sheets.*240 MB/) })])
  })

  it('gives a recording shorter than one interval a single midpoint still', async () => {
    const { ctx } = fakeCtx({ duration: 2, interval: 5 })
    expect(batchesOf(await sheetPlan(ctx))[0].times).toEqual([1])
  })

  it('honours a coarse interval', async () => {
    const { ctx } = fakeCtx({ duration: 1200, interval: 100 })
    const out = await sheetPlan(ctx)
    expect(out.stills).toBe(12)
    expect(batchesOf(out)[0].times[0]).toBe(50)
  })

  it('emits one empty batch and warns, rather than throwing, when there is no duration (D9)', async () => {
    const { ctx, annotations } = fakeCtx({ duration: 0, interval: 5 })
    const out = await sheetPlan(ctx)
    expect(batchesOf(out)).toEqual([{ times: [], labels: [] }])
    expect(out.stills).toBe(0)
    expect(out.sheets).toBe(0)
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning' })])
  })

  it('rejects a non-positive or non-numeric interval', async () => {
    await expect(sheetPlan(fakeCtx({ duration: 60, interval: 0 }).ctx)).rejects.toThrow('sheet-plan: `interval` must be greater than 0')
    await expect(sheetPlan(fakeCtx({ duration: 60, interval: '5' }).ctx)).rejects.toThrow('sheet-plan: `interval` must be a finite number')
  })
})
```

Run: `pnpm --filter ./workflows/capture exec vitest run scripts/sheet-plan.test.ts` — expected FAIL (no `batches`, no `Batch` export).

- [ ] **Step 4: Rewrite `sheet-plan.ts`**

```ts
/**
 * `sheet-plan` — `plan` → step `plan`.
 *
 *   with:    { duration, interval }
 *   outputs: { batches, stills, sheets }
 *
 * One still every `interval` seconds of speech, centred in its slot (`interval/2`,
 * `3·interval/2`, …) up to the spoken duration; a recording shorter than one interval gets a
 * single still at its midpoint. The person chose `interval` at kickoff (spec D4, amended
 * 2026-09-05) — there is no budget here any more. `labels` are the `m:ss` clocks
 * `video/contact-sheet` burns into each cell, parallel to `times`.
 *
 * CE's `frames` op accepts at most 200 stills PER REQUEST (`MAX_STILLS_PER_JOB`, a disk and
 * envelope guard, not a per-recording cap), so the plan is split into `batches` and the
 * `sheets` job runs one capture per batch as a matrix. There is always at least one batch,
 * so the matrix has a leg; an empty batch is `if:`-skipped by the workflow.
 *
 * No spoken audio (zero duration) is NOT a failure (D9): one empty batch, a warning on the
 * card, and the bundle still ships. A dense plan gets a warning too (D11): past 120 stills
 * the card names the stills, sheets and estimated bytes, because past 150 MB of sheets the
 * bundle lists them instead of containing them (D10).
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { chunk, clockLabel } from './lib/clock'
import { inputError, requireNumber } from './lib/inputs'

const NAME = 'sheet-plan'

/** CE `ffmpeg.handler.ts` MAX_STILLS_PER_JOB — the ceiling for one `frames` request. */
const MAX_STILLS_PER_JOB = 200
/** The rule's `tile.perSheet` literal. */
const PER_SHEET = 12
/** Above this the plan warns (Studio's whole budget was 120 stills). */
const WARN_STILLS = 120
/** Measured on the first live run: a full 3×4 sheet of 1080-row cells is ~2.4 MB. */
const SHEET_MB_ESTIMATE = 2.4

export interface Batch {
  times: number[]
  labels: string[]
}

/** Stills centred every `interval` seconds, strictly inside the recording. */
export function planTimes(duration: number, interval: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return []
  const times: number[] = []
  for (let t = interval / 2; t < duration - 0.05; t += interval) times.push(Math.round(t * 1000) / 1000)
  if (times.length === 0) times.push(Math.round((duration / 2) * 1000) / 1000)
  return times
}

export default async function sheetPlan(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const duration = requireNumber(NAME, ctx.inputs, 'duration')
  const interval = requireNumber(NAME, ctx.inputs, 'interval')
  if (interval <= 0) throw inputError(NAME, 'interval', 'must be greater than 0')

  const times = planTimes(duration, interval)
  const stills = times.length
  const sheets = Math.ceil(stills / PER_SHEET)

  if (stills === 0) {
    ctx.annotate({
      level: 'warning',
      message:
        'No spoken audio was heard, so there is no duration to plan contact sheets from. The bundle will carry the transcript (if any) and no sheets.',
    })
    return { batches: [{ times: [], labels: [] }], stills: 0, sheets: 0 }
  }

  const labels = times.map((t) => clockLabel(t))
  const batches: Batch[] = chunk(times, MAX_STILLS_PER_JOB).map((slice, i) => ({
    times: slice,
    labels: labels.slice(i * MAX_STILLS_PER_JOB, i * MAX_STILLS_PER_JOB + slice.length),
  }))

  if (stills > WARN_STILLS) {
    const mb = Math.round(sheets * SHEET_MB_ESTIMATE)
    ctx.annotate({
      level: 'warning',
      message: `${stills} stills every ${interval} s on ${sheets} sheets — about ${mb} MB of contact sheets. Past 150 MB the bundle zip lists the sheets instead of containing them; each is still a run output.`,
    })
  }

  ctx.log(`${stills} stills every ${interval} s → ${sheets} sheet(s) in ${batches.length} capture batch(es)`)
  return { batches, stills, sheets }
}
```

- [ ] **Step 5: Verify**

```bash
pnpm --filter ./workflows/capture exec vitest run scripts/sheet-plan.test.ts scripts/lib/clock.test.ts
pnpm --filter ./workflows/capture run typecheck
pnpm --filter ./workflows/capture run lint
grep -rn "contactSheet\|planContactSheet" workflows/capture/scripts ; echo "grep exit=$? (1 = clean)"
```
Expected: 8 tests pass; tsc + eslint clean; grep clean. `bundle.test.ts` is NOT expected to pass yet (Task 2 changes the contract) — do not run the whole suite as a gate here, and say so in the report.

- [ ] **Step 6: Commit**

```
refactor(capture): interval planner with ≤200-still batches; keep only clockLabel/chunk from Studio
```

---

### Task 2: `bundle` — flatten batches, 150 MB embed cap, new manifest

**Files:**
- Modify: `workflows/capture/scripts/bundle.ts`
- Modify: `workflows/capture/scripts/bundle.test.ts`

**Interfaces:**
- Consumes: `clockLabel` from `./lib/clock` (Task 1).
- Produces: script `bundle` — `with: { source, direction, words, text, timed, duration, language, sheets, times, cols, interval }` where `sheets` is `(FileRef[] | null)[] | null` (one entry per matrix leg), `times` is `(number[][] | null)[] | null`, `cols` is `((number | null)[] | null)[] | null`, `interval` is the kickoff number. Returns `{ zip: File, manifest: Manifest, transcript: string }`.
- `Manifest` (exported): `{ version: 1, createdAt, source: { name, path, spokenDuration, language }, direction, transcript: { words, timed, wordCount, bucketSeconds: 8 }, embedded: boolean, sheets: { file: string | null, path: string, cols: number | null, times: number[] }[], plan: { intervalSeconds: number, stills: number, sheets: number, cellHeight: 1080 }, warnings: string[] }`.

- [ ] **Step 1: Rewrite `bundle.test.ts`** (replace the file; fixtures now carry legs and sizes):

```ts
import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import type { FileRef } from '@bffless/workflow-script'
import bundle, { EMBED_CAP_BYTES, type Manifest } from './bundle'
import { fakeCtx } from './lib/fakeCtx'

const source: FileRef = { path: 'workflows/capture/inputs/walkthrough.mp4', name: 'walkthrough.mp4', contentType: 'video/mp4', size: 10, url: '/api/uploads/workflows/capture/inputs/walkthrough.mp4' }
const sheet = (n: number, size = 3): FileRef => ({ path: `run/sheets/${n}/sheet-01.jpg`, name: 'sheet-01.jpg', contentType: 'image/jpeg', size, url: `/api/uploads/run/sheets/${n}/sheet-01.jpg` })
const words = [{ text: 'Hello', start: 0.1, end: 0.4, speaker: null }, { text: 'world', start: 0.5, end: 0.9, speaker: null }]

// Two matrix legs (batches), one sheet each, as the harness collects them.
const base = {
  source,
  direction: 'Make me a deck.',
  words,
  text: 'Hello world',
  timed: '[0:00] Hello world',
  duration: 120,
  language: 'en',
  sheets: [[sheet(1)], [sheet(2)]],
  times: [[[15, 45, 75]], [[105]]],
  cols: [[3], [1]],
  interval: 30,
}

const fetchBytes = async (ref: FileRef) => new Response(new Uint8Array([1, 2, ref.path.includes('/1/') ? 1 : 2]))

async function unzip(out: Record<string, unknown>) {
  const zip = out.zip as File
  return { zip, entries: unzipSync(new Uint8Array(await zip.arrayBuffer())) }
}

describe('bundle', () => {
  it('flattens the matrix legs in order and packs everything into one zip named after the source', async () => {
    const { ctx } = fakeCtx(base, fetchBytes)
    const out = await bundle(ctx)
    const { zip, entries } = await unzip(out)
    expect(zip.name).toBe('walkthrough.capture.zip')
    expect(zip.type).toBe('application/zip')
    expect(Object.keys(entries).sort()).toEqual(['README.md', 'manifest.json', 'sheets/sheet-01.jpg', 'sheets/sheet-02.jpg', 'transcript.json', 'transcript.md'])
    expect(Array.from(entries['sheets/sheet-01.jpg'])).toEqual([1, 2, 1])
    expect(Array.from(entries['sheets/sheet-02.jpg'])).toEqual([1, 2, 2])
    expect(JSON.parse(strFromU8(entries['transcript.json']))).toEqual(words)
    const readme = strFromU8(entries['README.md'])
    expect(readme).toContain('2 contact sheet(s)')
    expect(readme).toContain('sheets[].cols')
  })

  it('writes the manifest the spec describes and returns it as an output too', async () => {
    const { ctx } = fakeCtx(base, fetchBytes)
    const out = await bundle(ctx)
    const { entries } = await unzip(out)
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Manifest
    expect(out.manifest).toEqual(manifest)
    expect(manifest.version).toBe(1)
    expect(manifest.embedded).toBe(true)
    expect(manifest.source).toEqual({ name: 'walkthrough.mp4', path: source.path, spokenDuration: 120, language: 'en' })
    expect(manifest.sheets).toEqual([
      { file: 'sheets/sheet-01.jpg', path: 'run/sheets/1/sheet-01.jpg', cols: 3, times: [15, 45, 75] },
      { file: 'sheets/sheet-02.jpg', path: 'run/sheets/2/sheet-01.jpg', cols: 1, times: [105] },
    ])
    expect(manifest.plan).toEqual({ intervalSeconds: 30, stills: 4, sheets: 2, cellHeight: 1080 })
    expect(manifest.warnings).toEqual([])
  })

  it('drops skipped legs (null) and keeps sheet numbering continuous', async () => {
    const { ctx } = fakeCtx({ ...base, sheets: [[sheet(1)], null, [sheet(2)]], times: [[[15]], null, [[105]]], cols: [[3], null, [1]] }, fetchBytes)
    const manifest = (await bundle(ctx)).manifest as Manifest
    expect(manifest.sheets.map((s) => s.file)).toEqual(['sheets/sheet-01.jpg', 'sheets/sheet-02.jpg'])
    expect(manifest.plan.stills).toBe(2)
  })

  it('lists rather than embeds the sheets when their total exceeds the cap (D10)', async () => {
    const big = Math.ceil(EMBED_CAP_BYTES / 2) + 1
    const { ctx, annotations } = fakeCtx({ ...base, sheets: [[sheet(1, big)], [sheet(2, big)]] }, async () => {
      throw new Error('must not fetch when not embedding')
    })
    const out = await bundle(ctx)
    const { entries } = await unzip(out)
    expect(Object.keys(entries).sort()).toEqual(['README.md', 'manifest.json', 'transcript.json', 'transcript.md'])
    const manifest = out.manifest as Manifest
    expect(manifest.embedded).toBe(false)
    expect(manifest.sheets.map((s) => s.file)).toEqual([null, null])
    expect(manifest.sheets.map((s) => s.path)).toEqual(['run/sheets/1/sheet-01.jpg', 'run/sheets/2/sheet-01.jpg'])
    expect(manifest.warnings).toEqual([expect.stringMatching(/not embedded.*150 MB.*workflow_sign/)])
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning' })])
    expect(strFromU8(entries['README.md'])).toContain('not embedded')
  })

  it('leads transcript.md with the source, spoken duration and the direction as a quote', async () => {
    const { ctx } = fakeCtx(base, fetchBytes)
    const out = await bundle(ctx)
    const md = out.transcript as string
    expect(md).toMatch(/^# walkthrough\.mp4 — 2:00 spoken\n/)
    expect(md).toContain('> Make me a deck.')
    expect(md.trimEnd().endsWith('[0:00] Hello world')).toBe(true)
  })

  it('omits the quote when direction is blank', async () => {
    const { ctx } = fakeCtx({ ...base, direction: null }, fetchBytes)
    const out = await bundle(ctx)
    expect(out.transcript as string).not.toMatch(/^>/m)
    expect((out.manifest as Manifest).direction).toBe('')
  })

  it('ships without sheets when every leg was skipped (D9), and says so', async () => {
    const { ctx, annotations } = fakeCtx({ ...base, sheets: [null], times: [null], cols: [null] })
    const out = await bundle(ctx)
    const { entries } = await unzip(out)
    expect(Object.keys(entries).sort()).toEqual(['README.md', 'manifest.json', 'transcript.json', 'transcript.md'])
    const manifest = out.manifest as Manifest
    expect(manifest.sheets).toEqual([])
    expect(manifest.embedded).toBe(true)
    expect(manifest.plan).toEqual({ intervalSeconds: 30, stills: 0, sheets: 0, cellHeight: 1080 })
    expect(manifest.warnings).toHaveLength(1)
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning' })])
  })

  it('tolerates sheets arriving as null (the whole job skipped)', async () => {
    const { ctx } = fakeCtx({ ...base, sheets: null, times: null, cols: null })
    expect(((await bundle(ctx)).manifest as Manifest).sheets).toEqual([])
  })

  it('fails loudly when a sheet cannot be fetched', async () => {
    const { ctx } = fakeCtx(base, async () => new Response(null, { status: 404 }))
    await expect(bundle(ctx)).rejects.toThrow('bundle: could not fetch sheet sheet-01.jpg (404)')
  })
})
```

Run `pnpm --filter ./workflows/capture exec vitest run scripts/bundle.test.ts` — expected FAIL (no `EMBED_CAP_BYTES` export, flat-shape validation rejects the nested fixtures).

- [ ] **Step 2: Edit `bundle.ts`**

1. Header comment: `with:` line lists `sheets, times, cols, interval` and add a paragraph: "`sheets` / `times` / `cols` arrive as one entry PER MATRIX LEG (the `sheets` job fans one `video/contact-sheet` call per ≤200-still batch, spec 01: a list output collects into a list of lists); a skipped leg is `null`. They are flattened in leg order here, so sheet numbering runs across batches. D10: the zip embeds the sheets only while their total size stays ≤ `EMBED_CAP_BYTES` — the archive is built in Worker memory — otherwise the manifest lists each sheet's `path` and `embedded: false`."
2. Constants: after `BUCKET_SECONDS` add
   ```ts
   /** D10: the most sheet bytes the zip will hold — the archive is assembled in Worker memory. */
   export const EMBED_CAP_BYTES = 150 * 1024 * 1024
   ```
3. Types:
   ```ts
   export interface ManifestSheet {
     /** Zip-relative path when embedded; null when the sheet is listed only (D10). */
     file: string | null
     /** Uploads-relative path — `workflow_sign { runId, path }` yields a link to it. */
     path: string
     cols: number | null
     times: number[]
   }
   ```
   and in `Manifest`: add `embedded: boolean` before `sheets`, and `plan: { intervalSeconds: number; stills: number; sheets: number; cellHeight: typeof CELL_HEIGHT }`.
4. Replace the `sheets`/`times`/`cols` parsing with a leg flattener:
   ```ts
   const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
   const isFileRef = (v: unknown): v is FileRef => isRecord(v) && typeof v.path === 'string' && v.path.length > 0

   /** One matrix leg's collected outputs, flattened in leg order; a null leg (skipped) contributes nothing. */
   function flattenLegs(inputs: Record<string, unknown>): { refs: FileRef[]; times: number[][]; cols: (number | null)[] } {
     const legsOf = (key: string): unknown[] => {
       const v = inputs[key]
       if (v === null || v === undefined) return []
       if (!Array.isArray(v)) throw inputError(NAME, key, 'must be a list (one entry per matrix leg) when present')
       return v
     }
     const sheetLegs = legsOf('sheets')
     const timeLegs = legsOf('times')
     const colLegs = legsOf('cols')
     const refs: FileRef[] = []
     const times: number[][] = []
     const cols: (number | null)[] = []
     sheetLegs.forEach((leg, i) => {
       if (leg === null || leg === undefined) return
       if (!Array.isArray(leg) || !leg.every(isFileRef)) throw inputError(NAME, 'sheets', `leg ${i} must be a list of File refs`)
       const legTimes = timeLegs[i]
       if (!Array.isArray(legTimes) || !legTimes.every((row) => Array.isArray(row) && row.every((t) => typeof t === 'number'))) {
         throw inputError(NAME, 'times', `leg ${i} must be a list of number lists`)
       }
       const legCols = Array.isArray(colLegs[i]) ? (colLegs[i] as unknown[]) : []
       leg.forEach((ref, j) => {
         refs.push(ref)
         times.push((legTimes[j] as number[]) ?? [])
         const c = legCols[j]
         cols.push(typeof c === 'number' && c > 0 ? c : null)
       })
     })
     return { refs, times, cols }
   }
   ```
   (`inputError` comes from `./lib/inputs`; remove the now-unused `optionalFileRefs` import and the `optionalNullable` uses for times/cols — keep `optionalNullable` for `language`.)
5. In the default export: `const { refs: sheets, times, cols } = flattenLegs(ctx.inputs)`, then
   ```ts
   const totalBytes = sheets.reduce((n, r) => n + (typeof r.size === 'number' ? r.size : 0), 0)
   const embedded = totalBytes <= EMBED_CAP_BYTES
   const warnings: string[] = []
   if (sheets.length === 0) { warnings.push(NO_SHEETS); ctx.annotate({ level: 'warning', message: NO_SHEETS }) }
   if (!embedded) {
     const msg = `${sheets.length} contact sheets (${Math.round(totalBytes / 1048576)} MB) are not embedded in the zip — the cap is 150 MB. Each is a run output: exchange manifest.sheets[].path for a link with workflow_sign.`
     warnings.push(msg); ctx.annotate({ level: 'warning', message: msg })
   }
   const manifestSheets: ManifestSheet[] = sheets.map((ref, i) => ({ file: embedded ? sheetFileName(i) : null, path: ref.path, cols: cols[i] ?? null, times: times[i] ?? [] }))
   ```
   manifest gains `embedded`, and `plan: { intervalSeconds: interval, stills: manifestSheets.reduce((n, s) => n + s.times.length, 0), sheets: manifestSheets.length, cellHeight: CELL_HEIGHT }`.
   The fetch loop runs only `if (embedded)`.
6. `readme()` sheets line: when `manifest.sheets.length && manifest.embedded` keep the current line; when `manifest.sheets.length && !manifest.embedded` use ``- `sheets/` — ${n} contact sheet(s) are **not embedded** (over the 150 MB cap). `manifest.json` → `sheets[].path` names each one; exchange a path for a link with `workflow_sign { runId, path }`. Cells are 3 per row, clock burned bottom-left.``; else the existing "No sheets" line.
7. Log line: `${zipName(source)}: ${sheets.length} sheet(s)${embedded ? '' : ' (listed, not embedded)'}, ${words.length} words, ${Math.round(bytes.byteLength / 1024)} KB`.

- [ ] **Step 3: Verify**

```bash
pnpm --filter ./workflows/capture exec vitest run scripts/bundle.test.ts
pnpm --filter ./workflows/capture run typecheck
pnpm --filter ./workflows/capture run lint
pnpm --filter ./workflows/capture run test:run
```
Expected: 9 bundle tests pass; tsc + eslint clean; whole suite green (build.test.ts skips until Task 3 stages).

- [ ] **Step 4: Commit**

```
feat(capture): bundle flattens capture batches and lists sheets past the 150 MB embed cap
```

---

### Task 3: Workflow YAML, stager, docs

**Files:**
- Modify: `workflows/capture/.bffless/workflows/capture.workflow.yaml`
- Modify: `workflows/capture/README.md`, `workflows/capture/bffless/README.md`
- Modify: `docs/superpowers/specs/2026-09-05-capture-workflow-design.md` (one line, below)
- No stager change: `SCRIPTS = ['bundle', 'sheet-plan']` still holds.

**Interfaces:**
- Consumes: `sheet-plan` `{ duration, interval } → { batches, stills, sheets }`; `bundle` `{ …, sheets, times, cols, interval }` (Tasks 1–2).

- [ ] **Step 1: Edit the YAML**

1. Inputs — after `language:` add:
   ```yaml
      interval:
        type: number
        default: 5
        min: 0.5
        step: 0.5
        label: Seconds between stills
        description: "One still every N seconds of speech, 12 stills per sheet, about 2.4 MB per sheet. A 20-minute recording at 1 s is 1200 stills on 100 sheets; at 30 s it is 40 stills on 4 sheets. Past 150 MB of sheets the zip lists them instead of containing them (each sheet is still a run output)."
   ```
2. Run outputs: remove the `sheets:` line (a matrix job's file list collects into a list of lists, which the `images` renderer does not draw; the manifest carries every sheet's `path`). Keep `bundle`, `transcript`, `words`, `manifest`.
3. Replace the whole `sheets:` job with two jobs:
   ```yaml
  plan:
    name: Plan the stills
    needs: extract
    steps:
      - id: plan
        name: Plan the stills
        uses: script
        with:
          src: scripts/sheet-plan.js
          duration: ${{ needs.extract.outputs.duration }}
          interval: ${{ inputs.interval }}
        outputs:
          batches: { type: json }
          stills:  { type: number }
          sheets:  { type: number }
        summary: "${{ steps.plan.outputs.stills }} stills every ${{ inputs.interval }} s → ${{ steps.plan.outputs.sheets }} sheet(s) in ${{ length(steps.plan.outputs.batches) }} batch(es)."
    outputs:
      batches: ${{ steps.plan.outputs.batches }}
      stills:  ${{ steps.plan.outputs.stills }}
      sheets:  ${{ steps.plan.outputs.sheets }}

  # One leg per ≤200-still batch (CE's `frames` op ceiling is per request, not per
  # recording). Outputs collect per leg into lists of lists (spec 01); `bundle` flattens
  # them in leg order. An empty batch (no spoken audio, D9) is skipped and contributes null.
  sheets:
    name: Grab the stills
    needs: plan
    strategy: { matrix: { batch: "${{ needs.plan.outputs.batches }}" }, max-parallel: 2 }
    steps:
      - id: sheets
        name: Grab the stills
        uses: pipeline
        if: "${{ length(matrix.batch.times) > 0 }}"
        with:
          path: video/contact-sheet
          body: { source: "${{ inputs.recording.path }}", outPrefix: "${{ step.prefix }}", times: "${{ matrix.batch.times }}", labels: "${{ matrix.batch.labels }}" }
        poll: { path: job, query: { id: "${{ response.jobId }}" }, until: "${{ response.status == 'done' }}", fail: "${{ response.status == 'error' }}", every: 3s, timeout: 20m }
        retry: { max: 3, delay: 10s, if: "${{ error.code == 'FFMPEG_BUSY' }}" }
        outputs:
          sheets: { type: file, list: true, value: "${{ response.result.paths }}", render: images }
          times:  { type: json, value: "${{ response.result.times }}" }
          cols:   { type: json, value: "${{ response.result.cols }}" }
        summary: "${{ length(steps.sheets.outputs.sheets) }} contact sheet(s) from ${{ length(matrix.batch.times) }} stills."
    outputs:
      sheets: ${{ steps.sheets.outputs.sheets }}
      times:  ${{ steps.sheets.outputs.times }}
      cols:   ${{ steps.sheets.outputs.cols }}
   ```
4. `bundle` job: `needs: [extract, sheets]` stays; in `with:` replace `interval: ${{ needs.sheets.outputs.interval }}` with `interval: ${{ inputs.interval }}`; `sheets`/`times`/`cols` lines unchanged (they now resolve to per-leg lists). Summary: `"Bundle ready: **${{ steps.bundle.outputs.zip.name }}** (${{ steps.bundle.outputs.manifest.plan.stills }} stills on ${{ length(steps.bundle.outputs.manifest.sheets) }} sheets, ${{ steps.bundle.outputs.manifest.transcript.wordCount }} words)."`

If `workflow index` rejects `min`/`step` on the number input, drop `step:` first, then `min:`, and record it. Any other finding: fix the YAML keeping the names above.

- [ ] **Step 2: Docs**

- `workflows/capture/README.md`: in the outputs table drop the `sheets` row and add to the `manifest` row "…, `embedded`, per-sheet `path`/`cols`/`times`, `plan.intervalSeconds`/`stills`"; in the intro replace "Studio-style contact sheets" with "contact sheets at the density you pick (one still every N seconds)"; add a short "## Density" section: the `interval` input, the 200-per-request batching, the 150 MB embed cap, and that past the cap the sheets are fetched via `workflow_sign` from `manifest.sheets[].path`.
- `workflows/capture/bffless/README.md`: in the Rules table's contact-sheet row append "; called once per ≤200-still batch (CE `MAX_STILLS_PER_JOB`)".
- Spec: in the `bundle` step's row change "`interval` (`inputs.interval`), `stills`" to "`interval` (`inputs.interval`)" and in "Run outputs" delete the `sheets:` line, adding after the block: "The per-leg `sheets` lists are not a run output (a list of lists does not render as images); the manifest carries every sheet's `path`."

- [ ] **Step 3: Verify**

```bash
pnpm --filter ./workflows/capture run stage
pnpm --filter ./workflows/capture run test:run
pnpm --filter ./workflows/capture run lint
node -e "const i=require('./workflows/capture/dist/.bffless/workflows/index.json'); console.log(i.impl, i.scripts, i.workflows.map(w=>w.headlessSafe))"
grep -rn "per_sheet\|perSheet\|contactSheet\|10 sheets\|120-frame\|Studio budget" workflows/capture --include=*.ts --include=*.yaml --include=*.md --include=*.mjs | grep -v node_modules ; echo "grep exit=$? (1 = clean)"
```
Expected: stage green (lint finds nothing; `rule-missing` satisfied), 20 tests including the two `build.test.ts` cases, index lists both scripts with `headlessSafe: true`, grep clean.

- [ ] **Step 4: Commit**

```
feat(capture): seconds-between-stills kickoff input, batched matrix capture, density warnings
```

---

### Task 4 (controller): live proof on the preview

After Task 3 is pushed and `Preview capture` republishes `capture-pr-9`, start two headless runs over the harness MCP with the existing upload (a whole File ref: `path: workflows/capture-pr-9/capture/inputs/88632a88-f0a5-48c5-8544-40afd562c58a-2026-09-05_16-14-05.mp4`, `name: "2026-09-05 16-14-05.mp4"`, `contentType: video/mp4`, `size` from `workflow_outputs` of the first run or 0, `url: /api/uploads/<path>`):

1. `interval: 30` → expect 4 stills, 1 batch, 1 sheet, `embedded: true`.
2. `interval: 1` → expect 102 stills, 1 batch (≤200), 9 sheets, no >120 warning; `embedded: true`.
3. `interval: 0.5` → 204 stills, **2 batches**, 17 sheets, warning fired; proves the matrix fan-out and the flatten.

Record run ids, wall times, sheet counts and bundle sizes on PR #9. The 150 MB branch is proven by the unit test only (no recording long enough is on hand).
