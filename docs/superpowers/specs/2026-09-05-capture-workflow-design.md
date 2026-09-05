# Capture — a recording becomes context for a Claude session

**Date:** 2026-09-05 · **Status:** approved design, not yet built · **Alias:** `capture`

## Purpose

A person records a screen share while talking — "I want a PowerPoint out of this, here are the
sites I'm walking through" — and later wants a Claude session to work from exactly what was said
and shown. Capture is a Workflow-harness implementation that turns one such recording into a
portable, machine-readable resource: the transcript with word timings, Studio-style contact
sheets with the clock burned into every cell, and the person's own direction text, packed into
one zip a later Claude session can fetch through the harness's MCP server.

It is a simplified Studio: Studio's first two jobs (audio → transcript, planned contact sheets),
none of its AI or editing stages, and a bundle at the end instead of a short.

## Decisions (from the brainstorm)

| # | Decision | Why |
| --- | --- | --- |
| D1 | Delivery is the harness MCP first: outputs are files, read via `workflow_runs` → `workflow_outputs`. | Zero extra infrastructure; the channel already exists and is connected in the user's Claude sessions. |
| D2 | A Handoff share link is a **staged follow-up**, not part of this spec. | Nothing inside a run can move bytes into Handoff today: a `script` Worker has no network but the harness file-serve, `http_request` sends JSON/string bodies only, and `file_upload_handler sourceUrl` writes into its own project. The path is an "import from URL" rule on the Handoff app plus a `publish` job here — see Follow-ups. Until then the README gives the one handoff-api command that uploads the zip. |
| D3 | `direction` is carried through verbatim; no AI step in the run. | The consumer is the later Claude session; spending tokens in the run would pre-judge what it wants. |
| D4 | Contact sheets only — Studio's plan, budget and burned labels. No per-frame images. | A 20-minute recording at one frame per second would be 1200 images; Studio's plan (5 s spacing until the 120-frame budget bites, then wider — a 20-minute recording is 120 stills at 10 s on 10 sheets of 3×4) is what Studio proved readable, and a sheet cell is a full still one can zoom into. |
| D5 | Cell height 1080 (CE `frames` op `height` knob), not the 720 default. | Screen-share text must stay legible when a cell is zoomed; a 3-column sheet becomes 5760 px wide. Revisit if sheets prove too heavy. |
| D6 | One recording per run. | Simplest shape; run it again for another recording. Studio's multi-source global timeline is not needed. |
| D7 | Alias `capture`, permanent. | Names `/api/capture/…`, `/w/capture/…`, the rule set and the deploy alias. |
| D8 | Deploy to both harnesses: j5s (`admin.j5s.dev`) first, then `workflow.bffless.dev`. | Same two-job shape as `deploy-workflow-studio.yml`; j5s stays the canary. |
| D9 | No spoken audio does **not** fail the run. | Unlike Studio (whose director needs a plan), a bundle with a transcript-less manifest and no sheets is still useful; the run warns instead. |

## Package layout

```
workflows/capture/
  .bffless/
    workflow.json                     { "alias": "capture", "harness": "workflow" }
    workflows/capture.workflow.yaml
    proxy-rules/capture/
      ruleset.yaml
      schemas/capture_jobs.schema.yaml
      rules/job/get/…                 ← copied from workflow-studio
      rules/video/extract-audio/post/…
      rules/video/contact-sheet/post/…
      rules/transcribe/post/…
  scripts/
    stage.mjs                         typecheck → scripts → `workflow index`
    sheet-plan.ts (+ .test.ts)        one-source plan → { times, labels }
    bundle.ts (+ .test.ts)            zip + manifest + transcript files
    build.test.ts                     each dist/scripts/*.js is one self-contained ES module
    lib/inputs.ts, lib/fakeCtx.ts     copied from workflow-studio/scripts/lib
    lib/contactSheet.ts (+ .test.ts)  copied from workflow-studio/vendor/studio/lib (pure)
  package.json, tsconfig.json, tsconfig.scripts.json, tsconfig.node.json
  vite.scripts.config.ts, vitest.config.ts, eslint.config.js
  README.md                           what it is, how to run it, how a Claude session reads a run
  bffless/README.md                   project setup (nothing new; what to verify)
```

No `islands/`, no `.bffless/skills/`, no `vendor/`. The rules are copied files with every
`workflow_studio_*` schema id rewritten to `capture_*` and the Studio wording in names and
descriptions replaced; a `grep -r 'workflow_studio\|workflow-studio' workflows/capture` must come
back empty, and CI's `check-identity` plus `rules validate` are the standing fence.

## The workflow

`.bffless/workflows/capture.workflow.yaml` — `name: Capture a recording for Claude`.

### Inputs

| Input | Type | Notes |
| --- | --- | --- |
| `recording` | `file`, `accept: video/*`, required, `maxSize: 5GB` | One video. |
| `direction` | `string`, multiline, optional | "What I want done with this." Carried into the bundle verbatim (D3). |
| `language` | `choice`, default `en` | Studio's WhisperX alignable list plus `auto`, same comment block explaining why it is pinned. |

### Jobs

**`extract`** — the source's audio and transcript.

| Step | Kind | What | Outputs |
| --- | --- | --- | --- |
| `audio` | pipeline `video/extract-audio` + poll on `job` | Studio's step verbatim (no `executor`, `FFMPEG_BUSY` retry ×3). | `wav` (file) |
| `transcribe` | pipeline `transcribe` + poll | `{ audio, diarize: false, language }`. | `words` (json, `render: transcript`), `text`, `timed`, `duration`, `language` |

Summary line and the `< 50 words` warning annotation are kept from Studio.
Job outputs: `wav`, `words`, `text`, `timed`, `duration`, `language`, `source` (`${{ inputs.recording }}`).

**`sheets`** — needs `extract`.

| Step | Kind | What | Outputs |
| --- | --- | --- | --- |
| `plan` | script `scripts/sheet-plan.js` | `{ duration }` → `planContactSheet(duration)` from `lib/contactSheet.ts`; `labels[i] = clockLabel(times[i])`. Zero duration → empty plan + warning annotation, no throw (D9). | `times` (json), `labels` (json) |
| `sheets` | pipeline `video/contact-sheet` + poll, `if: length(steps.plan.outputs.times) > 0` | `{ source, outPrefix, times, labels }`; the rule's `frames` op carries `height: 1080` (D5), `tile.perSheet: 12`, `tile.columns: 3`. | `sheets` (file list, `render: images`), `times` (json), `cols` (json) |

Job outputs: `sheets`, `times`, `cols` (each null when skipped; `bundle` tolerates null).

**`bundle`** — needs `[extract, sheets]`.

| Step | Kind | With | Outputs |
| --- | --- | --- | --- |
| `bundle` | script `scripts/bundle.js` | `source` (file ref), `direction`, `words`, `text`, `timed`, `duration`, `language`, `sheets` (file refs or null), `times`, `cols` | `zip` (file), `manifest` (json), `transcript` (markdown) |

### Run outputs

```yaml
outputs:
  bundle:     ${{ jobs.bundle.outputs.zip }}         # the one thing to fetch
  transcript: ${{ jobs.bundle.outputs.transcript }}  # markdown, timed
  words:      ${{ jobs.extract.outputs.words }}      # render: transcript
  sheets:     ${{ jobs.sheets.outputs.sheets }}      # render: images
  manifest:   ${{ jobs.bundle.outputs.manifest }}
```

Every step is `pipeline` or `script`, so the workflow is headless-safe with no `headless:`
declarations; `workflow_list` marks it so and an unattended `workflow_start` can complete it.

## The bundle

`bundle.zip`, named `<source-basename>.capture.zip`:

```
manifest.json
README.md
transcript.md
transcript.json
sheets/sheet-01.jpg … sheet-NN.jpg
```

**`manifest.json`**

```json
{
  "version": 1,
  "createdAt": "2026-09-05T18:22:10Z",
  "source": { "name": "walkthrough.mp4", "path": "<uploads-relative>", "duration": 1187.4, "language": "en" },
  "direction": "I want a PowerPoint out of this …",
  "transcript": { "words": "transcript.json", "timed": "transcript.md", "wordCount": 2410, "bucketSeconds": 8 },
  "sheets": [
    { "file": "sheets/sheet-01.jpg", "cols": 3, "times": [4.9, 14.8, 24.7, 34.6, 44.5, 54.4, 64.3, 74.2, 84.1, 94.0, 103.9, 113.8] },
    …
  ],
  "plan": { "intervalSeconds": 9.9, "frames": 120, "cellHeight": 1080 }
}
```

`sheets[].times` is the same per-sheet chunking the `contact-sheet` rule returns (`result.times`,
parallel to `paths`), so a reader can map "cell 5 on sheet 3" to a second without re-deriving the
plan. An empty `sheets: []` plus `"warnings": ["no spoken audio …"]` is the D9 shape.

**`transcript.md`** — a heading with the source name and duration, the direction as a block
quote (omitted when empty), then Studio's `timed` text: one `[m:ss] …` line per 8-second bucket.

**`transcript.json`** — WhisperX's `words` array as the `transcribe` rule flattened it:
`[{ word, start, end }]`.

**`README.md`** — five lines: what the run was, what each file is, how to read a sheet (3 columns,
row-major, clock burned bottom-left of each cell), and where the run lives
(`workflow_runs {impl: "capture"}`).

The script fetches each sheet's bytes with `ctx.files.fetch(ref)` (the only network a Worker has),
packs with `fflate`'s `zipSync` (JPEGs stored, text deflated), and returns the archive as a `Blob`
for the `zip` output plus the manifest object and the markdown string. Follows
`workflow-studio/scripts/blog-bundle.ts` for the Blob-output and fetch patterns.

## Backend (rule set `capture`)

Four rules, copied from `workflow-studio`'s set and renamed; behaviour unchanged except where
noted:

| Rule | Change |
| --- | --- |
| `job/get` | schema id → `capture_jobs`; description reworded. |
| `video/extract-audio/post` | schema id only. |
| `video/contact-sheet/post` | schema id; `frames` op gains `height: 1080` (D5). |
| `transcribe/post` | schema id only. `diarize` stays supported by the rule, unused by the workflow. |

`ruleset.yaml` describes the set as Capture's backend. Both `.fn.test.yaml` suites travel with the
rules and must pass under `bffless rules test`. Schema `capture_jobs` carries no `id:` so the
publish creates it fresh in whichever project the set lands in.

**Project setup (both instances):** nothing new. `transcribe` needs the `HF_TOKEN` secret and the
Replicate provider token on `bffless/workflow`, which Studio already put there on j5s and on
bffless.dev. `bffless/README.md` records this and the two checks to run before the first live run:
`list_secrets` shows `HF_TOKEN`; a Studio run has succeeded on that instance.

## Build, CI, deploy

- `scripts/stage.mjs`: Studio's stager minus islands and skills — type-check the three tsconfigs,
  build each script with `vite.scripts.config.ts`, run `workflow index` with `--impl capture`
  (overridable for previews). `DESCRIPTION` mirrored by hand into the deploy YAML, as Studio's is.
- Root `package.json`: `capture:lint`, `capture:stage`, `capture:build`, `capture:test`.
- `.github/workflows/deploy-capture.yml`: `publish` (j5s, `BFFLESS_URL`/`BFFLESS_API_KEY`) then
  `publish-bffless-dev` (`BFFLESS_DEV_URL`/`BFFLESS_DEV_API_KEY`), each with the "published
  bundle impl matches alias" assertion, path-filtered to `workflows/capture/**`.
- `.github/workflows/preview-capture.yml`: `capture-pr-<n>` on j5s, torn down on close.
- `ci.yml` needs no change; the per-package loop and `check-identity` cover a new directory.

## Reading a run from a Claude session

Documented in `workflows/capture/README.md`:

1. `workflow_runs { impl: "capture", status: "succeeded" }` → pick the run.
2. `workflow_outputs { runId }` → the `bundle` file ref's `url`.
3. Fetch and unzip; read `manifest.json` first, then `transcript.md`; open `sheets/*.jpg` as images.
4. Optional share link: upload the zip to Handoff with the handoff-api skill (`prepare → PUT →
   register` into a folder of the user's choosing).

## Testing

| Layer | How |
| --- | --- |
| `lib/contactSheet.ts` | Studio's own unit tests, copied. |
| `sheet-plan.ts` | 0 s → empty plan + warning; 60 s → 12 frames, 9 per sheet; 1200 s → the full 120 frames at 10 s, 12 per sheet; labels parallel to times. |
| `bundle.ts` | fake ctx with two sheet refs → `unzipSync` the Blob and assert the five entries, manifest fields, transcript header/quote, null-sheets branch. |
| `build.test.ts` | each built script is one self-contained ES module. |
| Rules | `bffless rules validate` + `bffless rules test` (the copied `.fn.test.yaml`). |
| Workflow | `pnpm capture:stage` (lint via `workflow index`, `rule-missing` against the rule dir). |
| Live | open the PR → `capture-pr-N` on j5s → one run with a short (~2 min) recording → `workflow_outputs` from a Claude session, fetch the zip, check the sheets are readable at 1080. Then merge → both harnesses → repeat on workflow.bffless.dev. |

## Follow-ups (filed as issues, not built here)

1. **Handoff import-from-URL** (`bffless/apps`, Handoff): `POST /api/import { url, parentId, filename }` → `file_upload_handler sourceUrl` + node register. Then here: a `publish` job that signs the bundle and calls it through an `http_request` rule with a `HANDOFF_API_KEY` secret, giving every run a share link (D2).
2. **Retention**: harness `keep: 30d` per workflow (spec 05 names it as a v1 follow-up); Capture runs are large.
3. **Cell height as an input** if 1080 proves wrong for some recordings.
