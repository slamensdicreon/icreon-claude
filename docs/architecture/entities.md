# Entities, playbooks and shared services

Launchworks was built on SitecoreAI and works. This document says how the same system runs
other platforms, Optimizely CMS (SaaS) first, without a second copy of the method: the catalog
becomes **Entities → playbooks**, the platform-specific parts become one **entity** each, and
everything that isn't about a platform stays one shared service.

It also records what the first Optimizely playbook (`playbooks/optimizely-saas-migration`) and
entity (`platforms/optimizely`) ship with today, and what remains to build before a project can
run on it.

## The idea

An **Entity** is a platform a client can be on: SitecoreAI, Optimizely CMS (SaaS), later
Salesforce, Contentful, Adobe. An entity owns everything that is true of that platform whatever
the job: how to reach it, what a project may change on it, how its model is shaped, what goes
wrong on it. A **playbook** is a job on an entity: build a site, migrate a live URL, operate a
site, optimize one. The **method** (Director, Chief of Staff, Leads and specialists, gates and
cards, budgets, evidence, read-back, autonomy, rules, the scorecard) is the same for every
playbook on every entity. **Shared services** are the tool servers and checks that don't care
which platform is behind them: a browser, GitHub, Vercel, a sandbox, the visual judge.

Most of this exists. `platforms/<id>/pack.ts` is the entity's declarative half; the method lives
in `packages/`; the browser, GitHub, hosting, research, sandbox and workspace tool servers are
already shared. What is missing is the grouping (the catalog is a flat list of playbooks), a
dozen places where shared code still assumes Sitecore, and a way for playbooks to share roles
and prompts instead of copying them.

## Four layers

| Layer               | What it holds                                                                                                                                                                                                                                                                                | Where                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Method**          | Orchestrator, tool gateway (scopes, idempotency, timeouts, release gating), Control Center, cards and autonomy, rules, scorecard, Decision Log, retrospectives                                                                                                                                | `packages/*`, `apps/*`                                                                                                     |
| **Shared services** | Tool servers every entity uses: `browser`, `github` and `build-repo`, `hosting` (Vercel), `research`, `sandbox` (working copies, builds, integration branch), `validators` (axe, Lighthouse, visual diff), `artifacts`, `blackboard`, `decision-log`; the screenshot judge (`compareScreens`) | `tool-servers/{browser,github,hosting,research,sandbox,validators,workspace}`, `packages/agent-runtime/src/visual.ts` |
| **Entity**          | The platform pack (intake fields, credentials and their live checks, scope bindings, target context, head and build environment), the platform's tool servers, its acceptance checks, its knowledge, its starter template and build recipe                                                   | `platforms/<id>/`, `tool-servers/<id>/`                                                                                    |
| **Playbook**        | The job: charter, intake composition, phases and gates, roles, prompts, plan, Definition of Done, fixtures                                                                                                                                                                                   | `playbooks/<id>/` with `platform: <entity>`                                                                                |

A playbook names its entity; the catalog groups playbooks by it. A saved connection belongs to
an entity (an instance's shared facts and secrets) and is offered to every playbook on it.

## What is shared and what is entity, concretely

**Tool servers**

| Server                                           | Layer                                                | Notes                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `browser`, `research`, `validators`, `workspace` | Shared                                               | Already platform-free                                                                                                      |
| `github`, `build-repo`, `hosting`                | Shared                                               | Vercel is the one host today; Optimizely DXP hosting could be a second `hosting` provider later                            |
| `sandbox`                                        | Shared, with entity hooks                            | Working copies, `git.integrate`, `git.commit` are shared; the build recipe, read-only file list and the CLI op are entity |
| `sitecore-authoring`, `sitecore-deploy`, `sitecore-cli` | SitecoreAI entity                             | In `tool-servers/sitecore` and the sandbox                                                                                 |
| `optimizely-cms`, `optimizely-graph`, `exec.optimizely-cli` | Optimizely entity                         | To build (below)                                                                                                           |

**Acceptance checks**

| Check                                                                                          | Layer      |
| ---------------------------------------------------------------------------------------------- | ---------- |
| `build.green`, `deploy.commit-matches`, `editing-host.deployed`, `editing-host.responds`, `credentials.verified`, `inventory.complete`, `notes.cited`, `blueprint.coverage`, `head.sections` | Shared (`packages/stack/src/review.ts`) |
| `parity.render`, `parity.visual`, `parity.page` (the judge and the word-coverage logic)       | Shared logic, entity read |
| `component-map.registered`, `serialization.replays`, `head.editing-scripts`, `rendering-host.set`, `structural.*`, `edge.published`, `routes.resolve`, `media.alt-text` | SitecoreAI entity (the first four still sit in the shared file: see the coupling map) |
| `types.defined`, `types.pushed`, `structural.application`, `structural.content-types`, `structural.templates`, `structural.experiences`, `hostname.registered`, `head.preview-route`, `editor.element-enabled`, `editor.new-experience`, `graph.published`, `manifest.replays`, `experience.redirects-resolve` | Optimizely entity, to build |

**Roles and prompts.** Thirteen of the SitecoreAI playbook's twenty-four roles are
platform-free (the Chief of Staff, the four Leads, Solution Architect, Repo Analyst, Content
Analyst, Research Agent, Visual QA, Performance and Accessibility QA, Parity Auditor, Handover
Writer); six prompts are too. The Optimizely playbook copies them with the platform words
changed. That duplication is the cost of shipping now; the fix is below under "Shared playbook
fragments".

## Coupling map: where shared code still assumes SitecoreAI

Each row is one change; none blocks the Optimizely playbook from loading, two block it from
running (marked **run**).

| Where                                                                                     | Assumption                                                                                              | Change                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/connectors/src/github-app.ts` `STARTER`                                        | Every build repository is created from `Sitecore/xmcloud-starter-js`, app at `examples/basic-nextjs`   | **run** `pack.starter: { owner, repo, appPath }`; the build-repo creation reads the project's pack. Optimizely: an `icreon-launchworks/optimizely-nextjs-starter` template made from the SDK's `samples/nextjs-template` |
| `tool-servers/sandbox/src/server.ts` `exec.build`                                        | Staged Sitecore scripts (`sitecore-tools:*`, `next:build`), `type-check` assumed to exist               | **run** `pack.buildRecipe` (scripts to run in order, which may be absent); the sandbox falls back to `build` when a script is missing                               |
| `tool-servers/sandbox/src/server.ts` `exec.content-sdk-cli`, `READ_ONLY`, `fs.write` text | The Content SDK CLI and Sitecore's config files                                                         | Entity CLI op from the pack (`exec.optimizely-cli`: `config push [--dryRun] [--only]`, `config pull`); read-only list from the pack                                 |
| `apps/worker/src/main.ts`                                                                 | Hand-wired Sitecore servers with `platform !== 'sitecoreai'` guards                                      | `pack.toolServers(deps)` returns the entity's servers; the worker concatenates shared + every pack's                                                                |
| `packages/stack/src/review.ts` `CHECKS`                                                   | `serialization.replays`, `head.editing-scripts`, `rendering-host.set`, `component-map.registered` are Sitecore | Move them into `platforms/sitecoreai/checks.ts`; `CHECKS` keeps only platform-free ones                                                                             |
| `packages/contracts/src/events.ts` `ProjectTarget`                                        | `collection` and `site` documented as Sitecore's                                                        | Keep the fields, document them as "what the sites share" and "this project's unit"; packs already fill them (Optimizely: instance host and application)            |
| `apps/web` (Mission, Preview, Workbench, Settings, App, Dashboard)                         | "SitecoreAI" in copy, `-sitecoreai` repository suffix                                                   | Read the project's `platform.name` from the playbook summary; suffix from the entity id                                                                              |
| `packages/contracts/src/snapshots.ts` `RuleScope.kind: 'platform'`                        | Naming only                                                                                             | Call it "entity" in the UI; the value can stay                                                                                                                      |
| `apps/control-api/src/intake.ts` `playbooks()` and `apps/web/src/overlays/NewProject.tsx` | Flat playbook list                                                                                      | `GET /entities` (id, name, vendor, description, playbooks, connections) or group the summaries by `platform.id`; the wizard picks the entity, then the playbook      |
| `packages/simulator`, `apps/control-api/src/demo-runner.ts`                               | The demo is a SitecoreAI project                                                                        | Fine as is; add an Optimizely demo scenario when the first pilot has run                                                                                            |

The pack gained one hook in this change: `buildEnv`, for a platform whose CLI needs more than
the head does (Optimizely's `config push` signs in with the REST API key, which the head must
never hold). The worker uses it for the sandbox and falls back to `headEnv`.

## An entity's definition

```
platforms/<id>/
  pack.ts              # PlatformPack: fields, credentials + live checks, bindings, context, headEnv, buildEnv, checks, (starter, buildRecipe, toolServers)
  checks.ts            # acceptance checks only this platform can run
  knowledge/*.md       # what every agent on this platform should know (known pitfalls)
tool-servers/<id>/     # the platform's tool servers, behind the shared gateway
playbooks/<job>/       # playbooks with `platform: <id>`
```

To add: `platforms/<id>/entity.yaml` with the catalog metadata the UI shows (name, vendor,
category, one-line description, documentation links, capabilities such as `visualBuilder`,
`headlessDelivery`, `experimentation`), so the Dashboard and the wizard can draw an entity card
without importing its code.

## Shared playbook fragments

Two playbooks now carry near-identical copies of thirteen roles and six prompts. Proposed:
`playbooks/_shared/{roles,prompts,knowledge}/` looked up after the playbook's own folder, the
way `knowledgeDirs` already works for knowledge, declared in the manifest:

```yaml
shared:
  roles: [chief-of-staff, discovery-lead, engineering-lead, content-lead, quality-lead, solution-architect, repo-analyst, content-analyst, research-agent, visual-qa, perf-a11y-qa, parity-auditor, handover-writer]
```

A playbook's own `roles/<id>.yaml` wins over the shared one. Prompts follow the same rule, and a
shared prompt may read `{{platform.name}}` so "Compares source and SitecoreAI pages" needs no
copy. This is a loader change (`packages/playbook-sdk/src/load.ts`) with no runtime effect; it
can come after the first Optimizely pilot.

## The Optimizely entity: shipped now

- **Connector** (`packages/connectors/src/optimizely.ts`): token minting against
  `https://api.cms.optimizely.com/oauth/token` (client credentials), a live check that reads
  the instance's content types through REST API v1, a live check of the Graph single key with a
  one-item query, and a shape check for the Graph app key and secret.
- **Pack** (`platforms/optimizely/pack.ts`): intake fields `cmsUrl`, `application`,
  `typePrefix`, `languages`, `hostingProject`; credentials `cms-api-client`, `graph-single-key`,
  `graph-hmac`; a connection shares the instance URL, locales and all three credentials;
  bindings `{application}`, `{typePrefix}`, `{contentRoot}`; owned scopes are the
  application's content tree, the prefixed types and templates, the application's media folder
  and the application itself; `headEnv` (CMS URL, Graph gateway and keys, default locale) and
  `buildEnv` (plus the REST API key for the CLI); target context that says what is shared on
  the instance and that preview3 is gone.
- **Knowledge** (`platforms/optimizely/knowledge/known-pitfalls.md`): eighteen rows from the
  platform's documentation and 2026 release notes, flagged as unproven until a site has run.
- **Playbook** (`playbooks/optimizely-saas-migration`): the same ten phases and two gates as
  the SitecoreAI playbook, with Optimizely's model: components become content types with
  display templates, defined in code and pushed by the CLI; page templates become page or
  experience types with blueprints; the editing host is a hostname of the application with live
  preview on `/preview`; delivery is Optimizely Graph; the content model's "serialization" is a
  manifest export plus a clean dry-run push. Twenty-four roles (two new: Content Type Modeler
  replaces the Rendering Registrar; the Layout Engineer now owns the shell, page types and
  blueprints), nineteen prompts, a Definition of Done, fixtures.

Both the API and the worker load it; `platforms/test/platforms.test.ts` checks its intake,
bindings, credential checks and environments. Its entity-specific roles are not live until the
tool servers below exist: the worker lists them as not connected and their tasks block
honestly, as the method requires.

## The Optimizely entity: to build

Sizes are relative to the SitecoreAI equivalents already in the repository.

| #  | Work                                                                                                                                                                                                                                                                                                                                                                                                     | Size |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| O1 | `tool-servers/optimizely`, server `optimizely-cms` on REST API v1: `application.{list,read,create}`, `hostname.{add,remove}`, `preview.configure`, `locale.{list,add}`, `contenttype.{list,read}`, `displaytemplate.{list,read}`, `content.{read,create,update,publish}`, `composition.write`, `blueprint.create`, `media.upload`, `manifest.export`, `webhook.{list,create}`. Virtual paths for the gateway's scopes: `/content/<application>/…` from a key's container chain, `/contenttypes/<key>`, `/displaytemplates/<key>`, `/media/<application>/…`, `/applications/<name>`. Read-before-write, prefix guard on every type and template, publish only as a release op, no type deletion | L (like `sitecore-authoring`) |
| O2 | Server `optimizely-graph`: `graph.query` (read-only GraphQL with the single key), `graph.routes` (every routable item of the application with `_metadata.url.default` and status), `graph.item` (one item, drafts through a signed request when the app key and secret exist)                                                                                                                       | M    |
| O3 | Sandbox hooks: `exec.optimizely-cli` (`config push --dryRun`, `config push --only`, `config pull`), `pack.buildRecipe` and `pack.starter`; the starter template repository in `icreon-launchworks` made from the SDK's Next.js sample with the shared `ui/Section`, registries and `/preview` route in place                                                                                           | M    |
| O4 | `platforms/optimizely/checks.ts`: the checks the plan names (table above); `types.defined`, `types.pushed`, `head.preview-route`, `hostname.registered` and `manifest.replays` are step-based like `component-map.registered` today; the rest read the CMS and Graph                                                                                                                                | M    |
| O5 | Browser `visual-builder.drive` and `video.record`: the same capability gap as `page-builder.drive`; M7's driver should cover both editors                                                                                                                                                                                                                                                             | L (shared with M7) |
| O6 | Catalog grouping and UI: `entity.yaml`, `GET /entities`, the wizard's entity step, platform names in copy                                                                                                                                                                                                                                                                                              | S    |
| O7 | First pilot: a live URL, phases 0 to 4 through the pilot slice with the Director; harvest the pitfalls that prove true or false into `known-pitfalls.md`                                                                                                                                                                                                                                              | –    |

O1 to O4 make the entity-specific roles live; O5 is needed for the two Visual Builder tasks only
(as `page-builder.drive` is on SitecoreAI today).

## Decisions for the Director

1. **Content model in code.** The playbook defines content types and display templates in the
   build repository and pushes them with Optimizely's CLI, restricted to the project's keys,
   never with `--force`. The alternative, creating types through the REST API from the Blueprint,
   keeps them out of the repository. Code-first is what the SDK is built for and what makes
   `manifest.replays` meaningful; recommended.
2. **Experiences by default.** Every page template is an experience (composed in Visual
   Builder) unless the Blueprint marks it a fixed page. This gives marketers the most freedom and
   matches the "connected visual builder" outcome; detail pages with a fixed form can stay pages.
3. **Hosting on our Vercel team**, as for SitecoreAI, with the editing host as a hostname of the
   application. Optimizely's own frontend hosting (`optimizely-cms-cli deploy`) is possible later
   as a second hosting provider.
4. **The starter**: our own template repository made from the SDK's Next.js sample, so every
   project starts with the shared section wrapper, registries and preview route. Needed before
   O3 can finish.
5. **Catalog grouping now or after the pilot** (O6): small either way; the wizard works today
   because the two playbooks show their entity names.

## Sources

- Optimizely, "Define content types" and "Develop content", CMS (SaaS) docs
  (https://docs.optimizely.com/cms-saas/docs/content-types-saas,
  https://docs.optimizely.com/cms-saas/docs/content-saas)
- Optimizely, "Create content and a page using the REST API"
  (https://docs.optimizely.com/cms-saas/docs/create-content-and-a-page-using-the-api)
- Optimizely, "Enable live preview" and "Configure Visual Builder"
  (https://docs.optimizely.com/cms-saas/docs/enable-live-preview-saas,
  https://docs.optimizely.com/cms-saas/docs/configure-visual-builder)
- Optimizely, "Work with styles" (display templates REST endpoints)
  (https://docs.optimizely.com/cms-saas/docs/work-with-styles)
- Optimizely, "Import and export data" (manifest and packages)
  (https://docs.optimizely.com/cms-saas/docs/import-and-export-data)
- Optimizely, 2026 CMS (SaaS) release notes (REST API v1, preview3 retirement, SDK 3.0)
  (https://docs.optimizely.com/cms-saas/release-notes/2026-cms-saas-release-notes)
- Optimizely, Graph single-key authentication
  (https://docs.developers.optimizely.com/platform-optimizely/docs/api-single-key-auth)
- episerver/content-js-sdk documentation: CLI reference, `config()`, content types, experiences,
  display templates, authentication, React components, live preview
  (https://github.com/episerver/content-js-sdk/tree/main/docs)
