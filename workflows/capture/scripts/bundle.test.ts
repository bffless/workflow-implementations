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
    const readme = strFromU8(entries['README.md'])
    expect(readme).toContain('2 contact sheet(s)')
    expect(readme).toContain('sheets[].cols')
    expect(readme).not.toContain('3 columns')
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
