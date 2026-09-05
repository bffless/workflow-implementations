/**
 * `sheet-plan` — `sheets` → step `plan`.
 *
 *   with:    { duration }
 *   outputs: { times, labels, interval, per_sheet }
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
    return { times: [], labels: [], interval: 0, per_sheet: 0 }
  }

  const labels = plan.times.map((t) => clockLabel(t))
  ctx.log(`${plan.times.length} frames every ~${Math.round(plan.interval)} s, ${plan.perSheet} per sheet`)
  return { times: plan.times, labels, interval: plan.interval, per_sheet: plan.perSheet }
}
