# Capture

A Workflow-harness implementation (`bffless/apps` → `apps/workflow`) that turns **one screen
recording** into context a later Claude session can work from: the transcript with word
timings, contact sheets at the density you pick (one still every N seconds) with the clock
burned into every still, and the direction you typed at kickoff — packed into one
`<recording>.capture.zip`.

It is a simplified Studio: Studio's first two jobs (audio → transcript, planned contact
sheets), none of its AI or editing stages, a bundle at the end instead of a short. Design:
[`docs/superpowers/specs/2026-09-05-capture-workflow-design.md`](../../docs/superpowers/specs/2026-09-05-capture-workflow-design.md).

## What a run produces

| Output | Type | What |
| --- | --- | --- |
| `bundle` | file | `manifest.json`, `README.md`, `transcript.md`, `transcript.json`, `sheets/sheet-NN.jpg` (when embedded, ≤150 MB) |
| `transcript` | markdown | 8-second `[m:ss]` lines, led by your direction as a quote |
| `words` | json | WhisperX word timings `[{ text, start, end, speaker }]` |
| `manifest` | json | source, duration, language, direction, `embedded`, per-sheet `path`/`cols`/`times`, `plan.intervalSeconds`/`stills` |

A recording with no spoken audio still produces a bundle — with no sheets and a warning.

## Density

`interval` — **seconds between stills** — is a kickoff input (default `5`). One still every
`interval` seconds of *speech* (the last spoken word's timestamp, not the file's length),
12 stills per sheet, roughly 2.4 MB per sheet: a 20-minute recording is 1200 stills on 100
sheets at `1`, and 40 stills on 4 sheets at `30`.

The stills are grabbed in batches of at most 200 — CE's `frames` op caps a single request, not
a recording — so the `sheets` job fans out over one matrix leg per batch (two at a time) and
`bundle` stitches the legs back together in order.

Past **150 MB** of sheets the zip lists them instead of embedding them: `manifest.embedded` is
`false`, `sheets/` is absent, and every sheet's `manifest.sheets[].path` is exchanged for a
short-lived link with `workflow_sign { runId, path }`. The sheets themselves stay on the
`sheets` job's step cards either way.

## Running and reading a capture from a Claude session

Any Claude session connected to the harness MCP can run a capture **from a URL** and read the
result — the `capture-recording` skill in [`bffless/apps`](https://github.com/bffless/apps/tree/main/plugins/bffless-apps/skills/capture-recording) (`npx skills add bffless/apps --skill capture-recording`)
is the written-down version of this loop:

1. `workflow_start { impl: "capture", workflow: "capture", inputs: { recording: "<https:// URL>", direction: "…" } }`
   — over the MCP endpoint a `file` input takes an `https://` URL; the dispatched driver
   downloads it into the project's bucket and registers it (`@bffless/workflow-headless` ≥ 1.4).
   Keep the `runId` it answers.
2. `workflow_status { runId }` until `succeeded` (the row appears after the Actions cold start,
   ~1–2 minutes).
3. `workflow_outputs { runId }` — the `bundle` File ref's `url` is host-relative
   (`/api/uploads/…`) and private to the project, so exchange its `path` for a short-lived
   presigned link with `workflow_sign { runId, path }` and fetch that.
4. Unzip; read `manifest.json` first, then `transcript.md`; open `sheets/*.jpg` as images (or,
   past the cap, sign each `manifest.sheets[].path`). `manifest.sheets[].times` maps each cell
   (row-major) to a second.

Want a share link? Upload the zip to a Handoff deployment with the `handoff-api` skill
(`prepare → PUT → register` into a folder of your choosing). Publishing it from inside the run is
a planned follow-up (spec → Follow-ups).

## Development

- `pnpm --filter ./workflows/capture run typecheck` — `tsc -p tsconfig.scripts.json && tsc -p tsconfig.node.json`
- `pnpm --filter ./workflows/capture run lint` — ESLint
- `pnpm --filter ./workflows/capture run stage` — type-check, build `scripts/{sheet-plan,bundle}.ts`
  into `dist/scripts/`, then `workflow index` into `dist/` (also lints the workflow against the
  rule set). `build` is the same command.
- `pnpm --filter ./workflows/capture run test:run` — Vitest. Run **after** `stage`:
  `scripts/build.test.ts` inspects the built scripts and skips itself when `dist/` is absent.
- `pnpm --filter ./workflows/capture run rules:validate` / `rules:test` — the rule set's
  validation and `*.fn.test.yaml` fixtures.

## Layout

- `.bffless/workflows/capture.workflow.yaml` — the contract: four jobs, `extract` → `plan` → `sheets` (a matrix leg per batch) → `bundle`.
- `.bffless/proxy-rules/capture/` — four rules copied from `workflow-studio` and renamed
  (`job/get`, `video/extract-audio`, `video/contact-sheet` at `height: 1080`, `transcribe`)
  over the `capture_jobs` schema.
- `scripts/` — the two `script` steps (Worker, opaque origin, `ctx.files.fetch` only) and
  `scripts/lib/` (the pure clock helpers kept from Studio, input guards, a test-only fake ctx).
- `bffless/README.md` — the per-project setup the rule set does not carry.

## Deploy

A merge to `main` that touches `workflows/capture/**` runs `.github/workflows/deploy-capture.yml`:
publish to the j5s harness, then to `workflow.bffless.dev`. PRs get `capture-pr-<n>` on j5s
(`preview-capture.yml`), torn down on close.
