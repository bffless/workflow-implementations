# Capture

A Workflow-harness implementation (`bffless/apps` → `apps/workflow`) that turns **one screen
recording** into context a later Claude session can work from: the transcript with word
timings, Studio-style contact sheets with the clock burned into every still, and the
direction you typed at kickoff — packed into one `<recording>.capture.zip`.

It is a simplified Studio: Studio's first two jobs (audio → transcript, planned contact
sheets), none of its AI or editing stages, a bundle at the end instead of a short. Design:
[`docs/superpowers/specs/2026-09-05-capture-workflow-design.md`](../../docs/superpowers/specs/2026-09-05-capture-workflow-design.md).

## What a run produces

| Output | Type | What |
| --- | --- | --- |
| `bundle` | file | `manifest.json`, `README.md`, `transcript.md`, `transcript.json`, `sheets/sheet-NN.jpg` |
| `transcript` | markdown | 8-second `[m:ss]` lines, led by your direction as a quote |
| `words` | json | WhisperX word timings `[{ word, start, end }]` |
| `sheets` | file list | the contact sheets (3 columns, 1080-row cells, clock bottom-left) |
| `manifest` | json | source, duration, language, direction, per-sheet timestamps |

A recording with no spoken audio still produces a bundle — with no sheets and a warning.

## Reading a run from a Claude session

The harness's MCP server exposes runs to any connected Claude session:

1. `workflow_runs { impl: "capture", status: "succeeded" }` — pick the run.
2. `workflow_outputs { runId }` — the `bundle` File ref carries a fetchable `url`.
3. Fetch and unzip it; read `manifest.json` first, then `transcript.md`; open `sheets/*.jpg`
   as images. `manifest.sheets[].times` maps each cell (row-major) to a second.

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

- `.bffless/workflows/capture.workflow.yaml` — the contract: three jobs, `extract` → `sheets` → `bundle`.
- `.bffless/proxy-rules/capture/` — four rules copied from `workflow-studio` and renamed
  (`job/get`, `video/extract-audio`, `video/contact-sheet` at `height: 1080`, `transcribe`)
  over schemas `capture_jobs` / `capture_uploads`.
- `scripts/` — the two `script` steps (Worker, opaque origin, `ctx.files.fetch` only) and
  `scripts/lib/` (Studio's pure `contactSheet.ts` planner, input guards, a test-only fake ctx).
- `bffless/README.md` — the per-project setup the rule set does not carry.

## Deploy

A merge to `main` that touches `workflows/capture/**` runs `.github/workflows/deploy-capture.yml`:
publish to the j5s harness, then to `workflow.bffless.dev`. PRs get `capture-pr-<n>` on j5s
(`preview-capture.yml`), torn down on close.
