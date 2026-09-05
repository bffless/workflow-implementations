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
