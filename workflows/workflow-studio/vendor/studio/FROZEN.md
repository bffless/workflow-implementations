# Frozen from bffless/apps `apps/studio` @ 22abda1aedaac48f240535dcc0f50cbb0bbd50f8

M4 Decision 3 — Studio's pure libs, components and CSS are copied and frozen here at
the commit above; divergence from Studio is deliberate from this point on. Every
`.ts`/`.tsx`/`.css` file carries the same provenance line as its first line. Two
entries cannot carry a comment header and are frozen byte-identical instead:

- `package.json` — Studio's manifest (JSON forbids comments). Referenced by
  `islands/blog-editor/mermaid.test.ts` (the mermaid CDN pin is checked against
  `dependencies.mermaid` here). NOT a workspace package — `vendor/**` is excluded in
  `pnpm-workspace.yaml`.
- `.bffless/skills/**` — the three skills the rules serve, byte-identical to
  `../../.bffless/skills` (that mirror is what `src/skills-drift.test.ts` asserts,
  so a header would break the pin).
