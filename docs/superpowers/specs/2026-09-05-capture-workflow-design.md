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
| D4 | Contact sheets only, at a **person-chosen density**: a kickoff `interval` (seconds between stills, default 5, min 0.5, no upper bound) replaces Studio's fixed 120-still / 10-sheet budget (amended 2026-09-05). Tiling stays 12 per sheet, 3 columns, burned `m:ss` labels. | The reader is a Claude session, not a director with an image budget: a 20-minute recording at 1 s is 1200 stills on about 100 sheets when that is what the person wants, or 12 stills at 100 s. Per-frame images stay out; a sheet cell is a full still one can zoom into. |
| D5 | Cell height 1080 (CE `frames` op `height` knob), not the 720 default. | Screen-share text must stay legible when a cell is zoomed; a 3-column sheet becomes 5760 px wide. Revisit if sheets prove too heavy. |
| D6 | One recording per run. | Simplest shape; run it again for another recording. Studio's multi-source global timeline is not needed. |
| D7 | Alias `capture`, permanent. | Names `/api/capture/…`, `/w/capture/…`, the rule set and the deploy alias. |
| D8 | Deploy to both harnesses: j5s (`admin.j5s.dev`) first, then `workflow.bffless.dev`. | Same two-job shape as `deploy-workflow-studio.yml`; j5s stays the canary. |
| D9 | No spoken audio does **not** fail the run. | Unlike Studio (whose director needs a plan), a bundle with a transcript-less manifest and no sheets is still useful; the run warns instead. |
| D10 | The zip **embeds the sheets only while their total size is ≤ 150 MB** (`EMBED_CAP_BYTES`, a constant). Above it the zip carries manifest, README and transcripts; the manifest lists every sheet's `path`, `embedded: false`, and a warning says to fetch them with `workflow_sign`. | The zip is built inside the browser Worker's memory (a `script` step has no other way to make a file); 100 sheets ≈ 240 MB plus the zip copy would crash the tab. Every sheet stays on its `sheets` leg's step card and its `path` is in `manifest.sheets[].path` regardless. |
| D11 | Density warnings: the `plan` step raises a `warning` annotation whenever the plan exceeds 120 stills, naming stills, sheets and the estimated bytes (≈2.4 MB per full sheet), and the `interval` field's description carries the arithmetic. A live pre-Start warning needs a harness feature (bffless/apps issue filed). | The person only learns the cost after Start today; both channels available now are used. |

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
    sheet-plan.ts (+ .test.ts)        interval plan → { batches, stills, sheets }
    bundle.ts (+ .test.ts)            zip + manifest + transcript files
    build.test.ts                     each dist/scripts/*.js is one self-contained ES module
    lib/inputs.ts, lib/fakeCtx.ts     copied from workflow-studio/scripts/lib
    lib/clock.ts (+ .test.ts)         clockLabel (from Studio's contactSheet.ts) + chunk
  package.json, tsconfig.json, tsconfig.scripts.json, tsconfig.node.json
  vite.scripts.config.ts, vitest.config.ts, eslint.config.js
  README.md                           what it is, how to run it, how a Claude session reads a run
  bffless/README.md                   project setup (nothing new; what to verify)
```

No `islands/`, no `.bffless/skills/`, no `vendor/`. The rules are copied files with every
`workflow_studio_*` schema id rewritten to `capture_*` and the Studio wording in names and
descriptions replaced; no `workflow_studio_*` identifier or `workflow-studio` alias may be
*referenced* under `workflows/capture/` (provenance comments naming the copy source are fine), and
CI's `check-identity` plus `rules validate` are the standing fence.

## The workflow

`.bffless/workflows/capture.workflow.yaml` — `name: Capture a recording for Claude`.

### Inputs

| Input | Type | Notes |
| --- | --- | --- |
| `recording` | `file`, `accept: video/*`, required, `maxSize: 5GB` | One video. |
| `direction` | `string`, multiline, optional | "What I want done with this." Carried into the bundle verbatim (D3). |
| `language` | `choice`, default `en` | Studio's WhisperX alignable list plus `auto`, same comment block explaining why it is pinned. |
| `interval` | `number`, default `5`, `min: 0.5`, `step: 0.5`, label "Seconds between stills" | D4/D11. Description: "One still every N seconds of speech, 12 stills per sheet, about 2.4 MB per sheet. A 20-minute recording at 1 s is 1200 stills on about 100 sheets; at 30 s it is 40 stills on 4 sheets. Past 150 MB of sheets the zip lists them instead of containing them." |

### Jobs

**`extract`** — the source's audio and transcript.

| Step | Kind | What | Outputs |
| --- | --- | --- | --- |
| `audio` | pipeline `video/extract-audio` + poll on `job` | Studio's step verbatim (no `executor`, `FFMPEG_BUSY` retry ×3). | `wav` (file) |
| `transcribe` | pipeline `transcribe` + poll | `{ audio, diarize: false, language }`. | `words` (json, `render: transcript`), `text`, `timed`, `duration`, `language` |

Summary line and the `< 50 words` warning annotation are kept from Studio.
Job outputs: `wav`, `words`, `text`, `timed`, `duration`, `language`, `source` (`${{ inputs.recording }}`).

**`plan`** — needs `extract`.

| Step | Kind | What | Outputs |
| --- | --- | --- | --- |
| `plan` | script `scripts/sheet-plan.js` | `{ duration, interval }` → stills centred every `interval` seconds (`interval/2, 3·interval/2, …` while `< duration − 0.05`; a recording shorter than one interval gets one still at its midpoint); `labels[i] = clockLabel(times[i])`; the list is split into **batches of ≤ 200** (CE's `MAX_STILLS_PER_JOB` — a per-request ceiling, not a per-recording one). Always at least one batch, so the matrix has a leg; zero duration → one empty batch + warning, no throw (D9). > 120 stills → warning annotation with stills / sheets / estimated MB (D11). | `batches` (json: `[{ times, labels }]`), `stills` (number), `sheets` (number, `ceil(stills/12)`) |

Job outputs: `batches`, `stills`, `sheets`.

**`sheets`** — needs `plan`; `strategy: { matrix: { batch: "${{ needs.plan.outputs.batches }}" }, max-parallel: 2 }`.

| Step | Kind | What | Outputs |
| --- | --- | --- | --- |
| `sheets` | pipeline `video/contact-sheet` + poll, `if: length(matrix.batch.times) > 0` | `{ source, outPrefix, times: matrix.batch.times, labels: matrix.batch.labels }`; the rule's `frames` op carries `height: 1080` (D5), `tile.perSheet: 12`, `tile.columns: 3`. | `sheets` (file list, `render: images`), `times` (json), `cols` (json) |

Job outputs collect per leg (spec 01: a matrix job's outputs are lists in matrix order, a list-typed output becomes a list of lists): `sheets: FileRef[][]`, `times: number[][][]`, `cols: (number|null)[][]`; when every leg is skipped (D9) the job itself resolves to `skipped` and `needs.sheets.outputs` is `null` outright — `bundle` tolerates both `null` and a `null` leg, and its job-level `if:` admits a skipped (not failed) `sheets`.

**`bundle`** — needs `[extract, sheets]`.

| Step | Kind | With | Outputs |
| --- | --- | --- | --- |
| `bundle` | script `scripts/bundle.js` | `source` (file ref), `direction`, `words`, `text`, `timed`, `duration`, `language`, `sheets` / `times` / `cols` (the per-leg lists above, flattened in order, null legs dropped), `interval` (`inputs.interval`) | `zip` (file), `manifest` (json), `transcript` (markdown) |

### Run outputs

```yaml
outputs:
  bundle:     ${{ jobs.bundle.outputs.zip }}         # the one thing to fetch
  transcript: ${{ jobs.bundle.outputs.transcript }}  # markdown, timed
  words:      ${{ jobs.extract.outputs.words }}      # render: transcript
  manifest:   ${{ jobs.bundle.outputs.manifest }}
```

The per-leg `sheets` lists are not a run output (a list of lists does not render as images);
the manifest carries every sheet's `path`.

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
  "source": { "name": "walkthrough.mp4", "path": "<uploads-relative>", "spokenDuration": 1187.4, "language": "en" },
  "direction": "I want a PowerPoint out of this …",
  "transcript": { "words": "transcript.json", "timed": "transcript.md", "wordCount": 2410, "bucketSeconds": 8 },
  "embedded": true,
  "sheets": [
    { "file": "sheets/sheet-01.jpg", "path": "workflows/capture/capture/runs/<run>/sheets/0/sheets/sheets/sheet-01.jpg", "cols": 3, "times": [2.5, 7.5, 12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5, 52.5, 57.5] },
    …
  ],
  "plan": { "intervalSeconds": 5, "stills": 238, "sheets": 20, "cellHeight": 1080 },
  "warnings": []
}
```

`embedded` is D10: `true` when every sheet is inside the zip under `sheets[].file`; `false` when their
total exceeded 150 MB, in which case `sheets[].file` is `null`, `sheets[].path` is the way to them
(`workflow_sign { runId, path }`), and `warnings` says so. `plan.intervalSeconds` is the kickoff
input; `plan.stills` the stills the delivered sheets actually carry (equal to the plan when the run completes).

`spokenDuration` is the last spoken word's end second (what `transcribe` reports as `duration`),
not the file's length.

`sheets[].times` is the same per-sheet chunking the `contact-sheet` rule returns (`result.times`,
parallel to `paths`), so a reader can map "cell 5 on sheet 3" to a second without re-deriving the
plan. An empty `sheets: []` plus `"warnings": ["no spoken audio …"]` is the D9 shape.

**`transcript.md`** — a heading with the source name and the spoken duration, the direction as a
block quote (omitted when empty), then Studio's `timed` text: one `[m:ss] …` line per 8-second
bucket.

**`transcript.json`** — WhisperX's `words` array as the `transcribe` rule flattened it:
`[{ text, start, end, speaker }]`.

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
| `lib/clock.ts` | `clockLabel` m:ss / h:mm:ss; `chunk` splits by size, never empty for non-empty input. |
| `sheet-plan.ts` | 0 s → one empty batch + warning; 60 s @ 5 → 12 stills in one batch, labels parallel; 1200 s @ 1 → 1200 stills in 6 batches of 200, `sheets` 102 (17 per batch), >120 warning names stills/sheets/MB; 2 s @ 5 → one still at 1.0; 1200 s @ 100 → 12 stills. |
| `bundle.ts` | fake ctx with two sheet refs → `unzipSync` the Blob and assert the five entries, manifest fields, transcript header/quote, null-sheets branch. |
| `build.test.ts` | each built script is one self-contained ES module. |
| Rules | `bffless rules validate` + `bffless rules test` (the copied `.fn.test.yaml`). |
| Workflow | `pnpm capture:stage` (lint via `workflow index`, `rule-missing` against the rule dir). |
| Live | open the PR → `capture-pr-N` on j5s → one run with a short (~2 min) recording → `workflow_outputs` from a Claude session, fetch the zip, check the sheets are readable at 1080. Then merge → both harnesses → repeat on workflow.bffless.dev. |

## Follow-ups (filed as issues, not built here)

1. **Handoff import-from-URL** (`bffless/apps`, Handoff): `POST /api/import { url, parentId, filename }` → `file_upload_handler sourceUrl` + node register. Then here: a `publish` job that signs the bundle and calls it through an `http_request` rule with a `HANDOFF_API_KEY` secret, giving every run a share link (D2).
2. **Retention**: harness `keep: 30d` per workflow (spec 05 names it as a v1 follow-up); Capture runs are large.
3. **Cell height as an input** if 1080 proves wrong for some recordings.
