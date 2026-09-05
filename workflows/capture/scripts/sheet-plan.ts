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
  // per batch — each capture request tiles its own stills, so a short final batch still costs a sheet
  const sheets = batches.reduce((n, b) => n + Math.ceil(b.times.length / PER_SHEET), 0)

  if (stills > WARN_STILLS) {
    const mb = Math.round(sheets * SHEET_MB_ESTIMATE)
    ctx.annotate({
      level: 'warning',
      message: `${stills} stills every ${interval} s on ${sheets} sheets — about ${mb} MB of contact sheets. Past 150 MB the bundle zip lists the sheets instead of containing them; each sheet's path is in manifest.sheets[].path.`,
    })
  }

  ctx.log(`${stills} stills every ${interval} s → ${sheets} sheet(s) in ${batches.length} capture batch(es)`)
  return { batches, stills, sheets }
}
