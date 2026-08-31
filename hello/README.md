# workflow-hello

The `hello` implementation for the [BFFless Workflow harness](https://github.com/bffless/workflow):
two workflows (`hello`, `interactive`) exercising every harness feature — inputs,
matrix jobs, poll, retry, forms, an interactive island round-trip, a `script`
step and every renderer — plus the backend pipelines they call. This repo is
the reference for **writing an implementation**: see
[`apps/workflow/docs/writing-an-implementation.md`](https://github.com/bffless/apps/blob/main/apps/workflow/docs/writing-an-implementation.md)
in the harness's own monorepo for the full spec.

## Layout

```
.bffless/
  workflows/                 authored workflow YAML — what `workflow index` lints and publishes
    hello.workflow.yaml
    interactive.workflow.yaml
  proxy-rules/hello/         this implementation's backend, as code (bffless CLI)
    ruleset.yaml
    schemas/hello_jobs.schema.yaml
    rules/<segment>/<method>/rule.yaml + *.fn.js
islands/                     one directory per island; each builds to one self-contained HTML file
  pick-line/{index.html,main.ts}
  line-viewer/{index.html,main.ts}
scripts/
  poster-card.js              a `script` step module — copied into the bundle verbatim
  build.mjs                   builds the bundle: islands (Vite), scripts (copy), then `workflow index`
vite.islands.config.ts        single-file island build, one run per island (WORKFLOW_ISLAND env)
tsconfig.json                 type-checks islands/ + scripts/ (excludes build.mjs, which is plain Node)
```

`pnpm build` writes `dist/`: `.bffless/workflows/*.yaml` + a generated
`index.json` (what the harness reads), `islands/<name>.html`, `scripts/*.js`,
and a one-line `index.html` landing page so the alias is never a bare 404.

`line-viewer` also proves `workflow.sign` (M3 Phase 3a, Task 10): the
`card` job's `poster_view` output feeds it the same poster File ref as
`review`'s form, and when the value looks like an image (`contentType`
starting `image/`) the island exchanges its `path` for a presigned URL over
the host bridge — a sandboxed frame has no cookie, so an `<img>` can't hit the
deployment directly — and renders it. On a harness older than Phase 3a (no
`workflow.sign` tool), the call comes back as a tool error and the island
shows it in `island-sign-error` instead of the image.

## The relative-path convention

A pipeline step names its endpoint relative to the implementation:
`with: { path: echo }` in a workflow calls `POST /api/hello/echo`. The rule
that serves it lives at `rules/echo/post/rule.yaml` — no `api/hello/` in the
directory path. At publish time `bffless rules push --path-prefix /api/hello`
(driven by `bffless/publish-workflow`, below) prepends the prefix to every
derived route, so the rule set is authored prefix-free and only gains the
prefix once, at sync time. `workflow index --path-prefix /api/hello`
(inside `scripts/build.mjs`) checks the same way, so a bad `path:` fails the
local build instead of a live 404.

## CI and deploy

- **`ci.yml`** (every PR): `pnpm check` (type-check) → `pnpm test` (vitest,
  including a real build) → `pnpm build` → `bffless rules validate` on the
  rule set — nothing is published.
- **`deploy.yml`** (push to `main`, or manual dispatch): builds, then
  `bffless/publish-workflow@v1` lints + syncs the rule set, uploads the
  bundle to the `hello` alias, and attaches the rule set to the harness's own
  alias (`workflow`) so `/api/hello/*` resolves through it.
- **`preview.yml`** (pull requests): publishes a per-PR alias
  (`hello-pr-<N>`) on open/sync/reopen and tears it down — the alias, its
  rule set, and its attachment to the harness — when the PR closes.

## Manual, per-install

These are one-time steps for a *new* deployment of this implementation
(a fork, or standing this up against a different BFFless project) — CI
handles everything else:

1. **Two response-header rules** on the harness project set
   `Cache-Control: no-transform` for `hello`'s bundle and island responses
   (ce#700) — without them an edge proxy that injects markup into `text/html`
   (e.g. Cloudflare Bot Fight Mode) breaks an island's `srcdoc`.
2. **An alias + domain for the harness itself** (`workflow`), with `/w/hello/*`
   forwarding to the `hello` alias (`bffless/publish-workflow` generates the
   forwarder rule; the alias/domain pointing at the harness build is separate).
3. **A domain for the `hello` alias (`hello.j5s.dev`) is optional — cosmetic,
   not required.** `bffless/publish-workflow` >= v1.2.0 makes `target-url`
   optional: the generated `/w/hello/*` forwarder then targets the CE
   backend's alias route in-process instead of a public domain, so the
   harness reaches the bundle with no domain for `hello` at all. Previews
   need no domain either — browse a preview directly through the harness at
   `https://workflow.<domain>/w/hello-pr-<N>/…`. If you *do* add a domain for
   `hello` (or a preview alias) anyway, its path still needs to be set to
   `/dist`, not `/` — `bffless/upload-artifact` keeps the uploaded directory
   name as the bundle's root, so a domain path of `/` (or empty) 400s (double
   slash) or 404s. With the path set to `/dist`, the domain serves `dist/`'s
   contents at its own root: `/islands/pick-line.html` on the domain
   resolves to `dist/islands/pick-line.html` in the deployment.
4. Repo variable **`BFFLESS_URL`** (the BFFless instance base URL, e.g.
   `https://admin.j5s.dev`) and secret **`BFFLESS_WORKFLOW_API_KEY`** (an API
   key scoped to the harness project).
5. The CI identity (e.g. a `workflow-ci` member) needs **contributor role**
   on the harness project — publishing syncs proxy rules and uploads a
   deployment, both of which need write access.

## Local development

```bash
pnpm install
pnpm check    # tsc + a discarded build (does-it-build gate)
pnpm test     # vitest — runs a real build once and asserts on its output
pnpm build    # writes dist/
npx --yes bffless@0.3.3 rules validate .bffless/proxy-rules/hello
```
