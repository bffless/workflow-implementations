/**
 * The `ctx.inputs` guards the `script` modules share. A script step's inputs are the YAML's
 * `with` keys after expression evaluation, so they arrive as `unknown`; a precise Error naming
 * the script and the key is the useful failure (the harness shows it on the failed step).
 * Pure and DOM-free — these run inside the Worker.
 */
import type { FileRef } from '@bffless/workflow-script'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function inputError(script: string, key: string, expectation: string): Error {
  return new Error(`${script}: \`${key}\` ${expectation}`)
}

/** A finite number. Rejects a numeric string — the YAML's `${{ }}` keeps types. */
export function requireNumber(script: string, inputs: Record<string, unknown>, key: string): number {
  const v = inputs[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw inputError(script, key, 'must be a finite number')
  return v
}

/** A string; `''` is legitimate. */
export function requireString(script: string, inputs: Record<string, unknown>, key: string): string {
  const v = inputs[key]
  if (typeof v !== 'string') throw inputError(script, key, 'must be a string')
  return v
}

/** A string, or `''` when the input is null/undefined (an optional kickoff field left blank). */
export function optionalString(script: string, inputs: Record<string, unknown>, key: string): string {
  const v = inputs[key]
  if (v === null || v === undefined) return ''
  if (typeof v !== 'string') throw inputError(script, key, 'must be a string when present')
  return v
}

export function requireArray(script: string, inputs: Record<string, unknown>, key: string): unknown[] {
  const v = inputs[key]
  if (!Array.isArray(v)) throw inputError(script, key, 'must be a list')
  return v
}

const isFileRef = (v: unknown): v is FileRef => isRecord(v) && typeof v.path === 'string' && v.path.length > 0

/** One harness File ref (`{ path, name, contentType, size, url }`). */
export function requireFileRef(script: string, inputs: Record<string, unknown>, key: string): FileRef {
  const v = inputs[key]
  if (!isFileRef(v)) throw inputError(script, key, 'must be a File ref')
  return v
}
