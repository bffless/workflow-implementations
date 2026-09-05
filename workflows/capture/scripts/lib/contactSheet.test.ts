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
