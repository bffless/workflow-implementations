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
    const readme = strFromU8(entries['README.md'])
    expect(readme).toContain('not embedded')
    expect(readme).toContain('sheets[].cols')
    expect(readme).not.toContain('3 per row')
  })

  it('never embeds when a sheet has no recorded size (fail safe on unknown size)', async () => {
    const { ctx, annotations } = fakeCtx({ ...base, sheets: [[{ ...sheet(1), size: undefined as unknown as number }], [sheet(2)]] }, async () => {
      throw new Error('must not fetch when not embedding')
    })
    const out = await bundle(ctx)
    const manifest = out.manifest as Manifest
    expect(manifest.embedded).toBe(false)
    expect(manifest.warnings).toEqual([expect.stringMatching(/no recorded size.*150 MB cap cannot be checked/)])
    expect(annotations).toEqual([expect.objectContaining({ level: 'warning' })])
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
