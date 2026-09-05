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
