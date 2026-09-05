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
