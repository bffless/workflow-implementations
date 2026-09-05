/**
 * `bundle` — `bundle` → step `bundle`.
 *
 *   with:    { source, direction, words, text, timed, duration, language,
 *              sheets, times, cols, interval }
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
 *
 * `sheets` / `times` / `cols` arrive as one entry PER MATRIX LEG (the `sheets` job fans one
 * `video/contact-sheet` call per ≤200-still batch, spec 01: a list output collects into a
 * list of lists); a skipped leg is `null`. They are flattened in leg order here, so sheet
 * numbering runs across batches. D10: the zip embeds the sheets only while their total size
 * stays ≤ `EMBED_CAP_BYTES` — the archive is built in Worker memory — otherwise the manifest
 * lists each sheet's `path` and `embedded: false`.
 */
import type { FileRef, ScriptContext } from '@bffless/workflow-script'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { clockLabel } from './lib/clock'
import { inputError, optionalString, requireArray, requireFileRef, requireNumber, requireString } from './lib/inputs'

const NAME = 'bundle'

/** The cell height `video/contact-sheet`'s `frames` op renders at (D5). Recorded, not chosen, here. */
const CELL_HEIGHT = 1080
/** `transcribe`'s `timed` groups words into 8-second lines (Studio's timedTranscript). */
const BUCKET_SECONDS = 8
/** D10: the most sheet bytes the zip will hold — the archive is assembled in Worker memory. */
export const EMBED_CAP_BYTES = 150 * 1024 * 1024

export interface ManifestSheet {
  /** Zip-relative path when embedded; null when the sheet is listed only (D10). */
  file: string | null
  /** Uploads-relative path — `workflow_sign { runId, path }` yields a link to it. */
  path: string
  cols: number | null
  times: number[]
}

export interface Manifest {
  version: 1
  createdAt: string
  source: { name: string; path: string; spokenDuration: number; language: string | null }
  direction: string
  transcript: { words: 'transcript.json'; timed: 'transcript.md'; wordCount: number; bucketSeconds: typeof BUCKET_SECONDS }
  embedded: boolean
  sheets: ManifestSheet[]
  plan: { intervalSeconds: number; stills: number; sheets: number; cellHeight: typeof CELL_HEIGHT }
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

function optionalNullable<T>(_script: string, inputs: Record<string, unknown>, key: string, check: (v: unknown) => T): T | null {
  const v = inputs[key]
  if (v === null || v === undefined) return null
  return check(v)
}

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

function transcriptMarkdown(source: FileRef, duration: number, direction: string, timed: string): string {
  const lines = [`# ${source.name} — ${clockLabel(duration)} spoken`, '']
  if (direction.trim()) {
    lines.push(...direction.trim().split('\n').map((l) => `> ${l}`), '')
  }
  lines.push(timed.trim(), '')
  return lines.join('\n')
}

function readme(manifest: Manifest): string {
  const sheets = manifest.sheets.length && manifest.embedded
    ? `- \`sheets/\` — ${manifest.sheets.length} contact sheet(s), row-major; each cell is one still with its clock (m:ss) burned bottom-left. \`manifest.json\` → \`sheets[].cols\` gives each sheet's column count and \`sheets[].times\` its seconds in cell order.`
    : manifest.sheets.length && !manifest.embedded
      ? `- \`sheets/\` — ${manifest.sheets.length} contact sheet(s) are **not embedded** (over the 150 MB cap). \`manifest.json\` → \`sheets[].path\` names each one; exchange a path for a link with \`workflow_sign { runId, path }\`. \`sheets[].cols\` gives each sheet's column count and \`sheets[].times\` its seconds in cell order (row-major); the clock is burned bottom-left of every cell.`
      : `- No sheets: ${manifest.warnings.join(' ')}`
  return [
    `# Capture of ${manifest.source.name}`,
    '',
    `A recording with ${clockLabel(manifest.source.spokenDuration)} of speech (the last spoken word's timestamp — not the file's length), captured ${manifest.createdAt} by the \`capture\` workflow.`,
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
  const { refs: sheets, times, cols } = flattenLegs(ctx.inputs)
  const interval = requireNumber(NAME, ctx.inputs, 'interval')

  const hasUnknownSize = sheets.some((r) => typeof r.size !== 'number' || !Number.isFinite(r.size))
  const totalBytes = sheets.reduce((n, r) => n + (typeof r.size === 'number' ? r.size : 0), 0)
  const embedded = !hasUnknownSize && totalBytes <= EMBED_CAP_BYTES
  const warnings: string[] = []
  if (sheets.length === 0) {
    warnings.push(NO_SHEETS)
    ctx.annotate({ level: 'warning', message: NO_SHEETS })
  }
  if (!embedded) {
    const msg = hasUnknownSize
      ? `${sheets.length} contact sheets are not embedded in the zip — at least one sheet has no recorded size, so the 150 MB cap cannot be checked. Each is a run output: exchange manifest.sheets[].path for a link with workflow_sign.`
      : `${sheets.length} contact sheets (${Math.round(totalBytes / 1048576)} MB) are not embedded in the zip — the cap is 150 MB. Each is a run output: exchange manifest.sheets[].path for a link with workflow_sign.`
    warnings.push(msg)
    ctx.annotate({ level: 'warning', message: msg })
  }

  const manifestSheets: ManifestSheet[] = sheets.map((ref, i) => ({
    file: embedded ? sheetFileName(i) : null,
    path: ref.path,
    cols: cols[i] ?? null,
    times: times[i] ?? [],
  }))

  const manifest: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: { name: source.name, path: source.path, spokenDuration: duration, language },
    direction,
    transcript: { words: 'transcript.json', timed: 'transcript.md', wordCount: words.length, bucketSeconds: BUCKET_SECONDS },
    embedded,
    sheets: manifestSheets,
    plan: { intervalSeconds: interval, stills: manifestSheets.reduce((n, s) => n + s.times.length, 0), sheets: manifestSheets.length, cellHeight: CELL_HEIGHT },
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
  if (embedded) {
    for (const [i, ref] of sheets.entries()) {
      const res = await ctx.files.fetch(ref)
      if (!res.ok) throw new Error(`${NAME}: could not fetch sheet ${ref.name} (${res.status})`)
      entries[sheetFileName(i)] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }]
    }
  }

  const bytes = zipSync(entries)
  ctx.log(`${zipName(source)}: ${sheets.length} sheet(s)${embedded ? '' : ' (listed, not embedded)'}, ${words.length} words, ${Math.round(bytes.byteLength / 1024)} KB`)

  const zip = new File([bytes], zipName(source), { type: 'application/zip' })
  return { zip, manifest, transcript }
}
