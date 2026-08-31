// Frozen from bffless/apps apps/studio @ 22abda1aedaac48f240535dcc0f50cbb0bbd50f8 (M4 Decision 3 — divergence from Studio is deliberate from here).
/**
 * One thing audible at a time. The cut editor's original-audio player (and any
 * other `<audio>` element) claims playback here; claiming pauses whatever was
 * playing before.
 */
let current: HTMLAudioElement | null = null

/** An `<audio>` element is taking over: pause whatever else was playing and
 *  track the element so the next claim pauses it in turn. */
export function claimPlayback(el: HTMLAudioElement) {
  if (current && current !== el) current.pause()
  current = el
}
