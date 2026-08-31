/**
 * `line-viewer` — the `render: island` half of the M2 workflow (02/04), now
 * also the M3 Phase 3a proof of `workflow.sign` (Task 10).
 *
 * A viewer is opened by `IslandView` rather than by a step: the value arrives
 * as the tool input `{ value }`, and `workflow.submit`/`workflow.annotate` are
 * both refused, so this island only ever reads. It is the same file format,
 * the same sandbox and the same bridge as `pick-line` — the difference is
 * entirely in what it is allowed to do.
 *
 * When the value looks like an image File ref (`{ path, contentType: 'image/…' }`,
 * see `apps/workflow`'s File-ref shape), the sandboxed frame has no cookie to
 * fetch it with, so pointing an `<img>` straight at the deployment 401s. The
 * island instead calls the `workflow.sign` host tool with the ref's `path` and
 * renders the presigned URL it gets back. Any other value renders as today,
 * as JSON text.
 */
import { App } from '@modelcontextprotocol/ext-apps'

interface ToolResultish {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
}

interface ImageFileRef {
  path: string
  name?: string
  contentType: string
}

const valueEl = document.querySelector<HTMLPreElement>('[data-testid="viewer-value"]')!
const imageEl = document.querySelector<HTMLImageElement>('[data-testid="viewer-image"]')!
const errorEl = document.querySelector<HTMLParagraphElement>('[data-testid="island-sign-error"]')!

/** The text blocks of a tool result, joined — how the host reports an error (04). */
function resultText(result: ToolResultish): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** What a rejected `callServerTool` (not a tool error — a throw) reads as. */
const failureText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Narrows an arbitrary tool-input value to the shape `workflow.sign` needs. */
function asImageRef(value: unknown): ImageFileRef | null {
  if (value === null || typeof value !== 'object') return null
  const ref = value as Record<string, unknown>
  if (typeof ref.path !== 'string' || typeof ref.contentType !== 'string') return null
  if (!ref.contentType.startsWith('image/')) return null
  return { path: ref.path, name: typeof ref.name === 'string' ? ref.name : undefined, contentType: ref.contentType }
}

const app = new App({ name: 'line-viewer', version: '1.0.0' })

// A monotonically increasing delivery counter: re-delivery is part of the
// contract (a changed value, a reconnect), and `workflow.sign` is a network
// round trip, so an older delivery's response can land after a newer one
// already started rendering. Each call to `renderImage` captures the
// generation it was started for and checks it again after the `await` —
// a stale result is discarded rather than clobbering what's already shown.
let generation = 0

app.ontoolinput = ({ arguments: args }) => {
  const { value } = (args ?? {}) as { value?: unknown }
  const current = ++generation

  // A fresh delivery starts from a clean slate rather than layering onto
  // whatever the previous value left rendered.
  imageEl.hidden = true
  imageEl.removeAttribute('src')
  imageEl.alt = ''
  errorEl.textContent = ''

  const imageRef = asImageRef(value)
  if (imageRef) {
    valueEl.hidden = true
    valueEl.textContent = ''
    renderImage(imageRef, current).catch((error: unknown) => {
      if (current !== generation) return // superseded by a later delivery
      errorEl.textContent = failureText(error)
    })
    return
  }

  // The pre-existing behaviour, unchanged: any non-image (or malformed) value
  // renders as JSON text.
  valueEl.hidden = false
  valueEl.textContent = JSON.stringify(value ?? null, null, 2)
}

/**
 * Exchange the ref's `path` for a presigned URL over the host bridge and
 * render it. Every failure — a tool `isError`, a rejected promise (the
 * bridge gone, an old harness without the tool), or a success with no usable
 * URL — lands in the visible error slot, never a silent blank image (mirrors
 * `pick-line`'s `attempt`). Discards the result outright if a later
 * `tool-input` has already superseded this one.
 */
async function renderImage(ref: ImageFileRef, expected: number): Promise<void> {
  const result: ToolResultish = await app.callServerTool({
    name: 'workflow.sign',
    arguments: { path: ref.path },
  })
  if (expected !== generation) return // superseded while the call was in flight

  if (result.isError) {
    errorEl.textContent = resultText(result)
    return
  }
  const url = result.structuredContent?.url
  if (typeof url !== 'string' || url === '') {
    errorEl.textContent = resultText(result) || 'workflow.sign returned no url'
    return
  }
  imageEl.src = url
  imageEl.alt = ref.name ?? ref.path
  imageEl.hidden = false
}

app.onteardown = async () => ({})

await app.connect()
