# Capture — backend and project setup

The backend is the authored rule set `.bffless/proxy-rules/capture/`, published under
`/api/capture/…` in project `bffless/workflow` on each harness instance by `publish-workflow@v1`.
Nothing here is standalone; see `workflows/workflow-studio/bffless/README.md` for the shared
harness-project conventions (rule-set isolation, the `/w/<alias>/*` forwarder, no domain needed).

## Manual setup (per instance) — nothing new

`transcribe` runs WhisperX on Replicate. It needs, on project `bffless/workflow`:

| Needs | Used by | Already there because |
| --- | --- | --- |
| `HF_TOKEN` secret | `transcribe` (`victor-upmeet/whisperx`) | Studio's `transcribe` uses the same rule |
| Replicate provider token (Settings → AI) | `transcribe` | same |

Before the first live run on an instance, check both: MCP `list_secrets` for
`bffless/workflow` lists `HF_TOKEN`, and a Studio run has succeeded there. The ffmpeg ops use
the instance's default executor (Admin → Features → Executor) exactly as Studio's do.

Schemas `capture_jobs` and `capture_uploads` carry no `id:`; the first publish creates them.

## Rules

| Rule | Copied from workflow-studio | Change |
| --- | --- | --- |
| `job/get` | ✓ | schema id, wording |
| `video/extract-audio/post` | ✓ | schema id |
| `video/contact-sheet/post` | ✓ | schema id; `frames.height: 1080` (spec D5) |
| `transcribe/post` | ✓ | schema id; `diarize` still accepted, the workflow sends `false` |
