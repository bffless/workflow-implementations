// Frozen from bffless/apps apps/studio @ 22abda1aedaac48f240535dcc0f50cbb0bbd50f8 (M4 Decision 3 — divergence from Studio is deliberate from here).
/**
 * The one slug rule Studio names downloads with: lowercased, every run of
 * non-alphanumerics collapsed to a single hyphen, leading/trailing hyphens
 * trimmed. Returns `''` for an empty or punctuation-only input — callers pick
 * their own fallback (`post`, `final-cut`, …).
 */
export function kebabSlug(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
