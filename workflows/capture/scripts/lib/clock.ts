/**
 * The two pure helpers capture keeps from Studio's contactSheet.ts (bffless/apps apps/studio
 * @ 22abda1): `clockLabel` is the `m:ss` / `h:mm:ss` clock burned onto every still and
 * printed in transcripts; `chunk` splits a list into fixed-size pieces (the ≤200-still
 * batches CE's `frames` op accepts per request). Studio's budget planner is gone — the
 * person chooses the density at kickoff (spec D4, amended 2026-09-05).
 */

/** Split `items` into chunks of at most `size` (the per-sheet tiling). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length ? [items] : []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Clock label burned onto each frame: `m:ss`, promoting to `h:mm:ss` once the
 * clip passes an hour. Plain wall-clock (no tenths) so the director can read it
 * at thumbnail size and map a scene back to an original-video timestamp.
 */
export function clockLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  if (h) return `${h}:${m.toString().padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}
