# workflow-implementations

The one home for implementations of the [Workflow harness](https://github.com/bffless/apps/tree/main/apps/workflow) (`bffless/apps` → `apps/workflow`). Each package under `workflows/` is a workflow **implementation**: a bundle of workflow YAML, proxy rules, scripts and islands that publishes into the harness's BFFless project (`bffless/workflow`) under its own alias via [`bffless/publish-workflow@v1`](https://github.com/bffless/publish-workflow). The harness is the app; implementations are content published into its project — one harness : many implementations.

Implementations are **not** catalog apps. Per the ruling recorded on [bffless/apps#420](https://github.com/bffless/apps/issues/420) (Non-goals):

> Catalog (one-click) installs of implementations — considered and rejected 2026-08-29; implementations stay repos that publish into a harness project.

## Layout

```
pnpm-workspace.yaml     # packages: ['workflows/*'] (vendor/ trees excluded)
package.json            # private root; scripts: <impl>:lint/stage/build/test, rules:validate, rules:test
.github/workflows/
  ci.yml                # per-package lint/stage/build/test:run (--if-present) + rules:validate/test on PR
  deploy-<impl>.yml     # publish-workflow@v1 → alias <impl> on push to main
  preview-<impl>.yml    # <impl>-pr-<n> previews + teardown on PR close
workflows/
  <impl>/               # one directory per implementation (hello, workflow-studio, capture, …)
    .bffless/workflow.json  # identity: { "alias": "<impl>", "harness": "workflow" }
```

## CI / deploy configuration

The deploy and preview workflows read (already set on this repo — record here, never in YAML):

- **Actions secret `BFFLESS_API_KEY`** — contributor-role API key on the `bffless/workflow` project (same key material `bffless/apps` holds as `BFFLESS_WORKFLOW_API_KEY`).
- **Actions variable `BFFLESS_URL`** — the BFFless instance URL (`https://admin.j5s.dev`).

A merge to `main` is a live deploy: each implementation's alias + rule set republish via `publish-workflow`. PRs publish `<impl>-pr-<n>` preview aliases, torn down on PR close. Aliases, rule-set names and `/api/<impl>/…` / `/w/<impl>/…` prefixes never change here — they are the implementation's identity.

## Writing an implementation

See [`apps/workflow/docs/writing-an-implementation.md`](https://github.com/bffless/apps/blob/main/apps/workflow/docs/writing-an-implementation.md) in `bffless/apps`.
