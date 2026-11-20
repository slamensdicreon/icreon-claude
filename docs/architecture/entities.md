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
| `optimizely-cms`, `optimizely-graph`, `exec.optimizely-cli` | Optimizely entity                         | `tool-servers/optimizely`, and the sandbox for the CLI                                                                     |

**Acceptance checks**

| Check                                                                                          | Layer      |
| ---------------------------------------------------------------------------------------------- | ---------- |
| `build.green`, `deploy.commit-matches`, `editing-host.deployed`, `editing-host.responds`, `credentials.verified`, `inventory.complete`, `notes.cited`, `blueprint.coverage`, `head.sections` | Shared (`packages/stack/src/review.ts`) |
| `parity.render`, `parity.visual`, `parity.page` (the judge and the word-coverage logic)       | Shared logic, entity read |
| `component-map.registered`, `serialization.replays`, `head.editing-scripts`, `rendering-host.set`, `structural.*`, `edge.published`, `routes.resolve`, `media.alt-text` | SitecoreAI entity (the first four still sit in the shared file: see the coupling map) |
| `types.defined`, `types.pushed`, `structural.application`, `structural.content-types`, `structural.templates`, `structural.experiences`, `hostname.registered`, `head.preview-route`, `editor.element-enabled`, `editor.new-experience`, `graph.published`, `manifest.replays`, `experience.redirects-resolve` | Optimizely entity: `platforms/optimizely/checks.ts` (the last one still to build) |

**Roles and prompts.** Thirteen of the SitecoreAI playbook's twenty-four roles are
platform-free (the Chief of Staff, the four Leads, Solution Architect, Repo Analyst, Content
Analyst, Research Agent, Visual QA, Performance and Accessibility QA, Parity Auditor, Handover
Writer); six prompts are too. The Optimizely playbook copies them with the platform words
changed. That duplication is the cost of shipping now; the fix is below under "Shared playbook
fragments".

## Coupling map: where shared code still assumes SitecoreAI

Updated 2026-10-31, after the decoupling pass (finish-partials plan, section 6).

| Where | Was | Now |
| --- | --- | --- |
| `connectors/src/github-app.ts` `STARTER` | Every build repository from Sitecore's starter | `createBuildRepo` takes the pack's `starter`; intake refuses a build repository for a pack without one (Optimizely until its template repository exists, O3), and names it `<source>-<pack id>` |
| `tool-servers/sandbox` `exec.build`, `READ_ONLY` | Staged Sitecore scripts; `sitecore.json` read-only for everyone | The pack's `buildRecipe` (generate scripts, build script, read-only files) through the workspace facts; SitecoreAI's recipe is the default and unchanged |
| `tool-servers/sandbox` `exec.content-sdk-cli` | The Content SDK CLI | Unchanged: it is SitecoreAI's own server operation, granted only to SitecoreAI roles. Optimizely's CLI comes with O3 |
| `apps/worker/src/main.ts` | `platform !== 'sitecoreai'` guards | The guards use the pack's id. Server construction stays in the worker: the servers don't depend on the packs and the packs shouldn't on the servers; a role whose platform has no server blocks as not connected |
| `stack/src/review.ts` `CHECKS` | Platform checks mixed with shared ones | Platform checks live in the pack (`pack.checks`); `uncheckedValidators` lists every check a playbook names that nothing implements, logged at worker start and pinned in a test (SitecoreAI: none; Optimizely: 3 for the website playbook, O4) |
| `contracts` `ProjectTarget`, `RuleScope` | Documented as Sitecore's | Documented as pack-defined |
| `apps/web` copy | "SitecoreAI" in nine places, `-sitecoreai` suffix | `ProjectSummary.platform` (named by the pack in the API); the web reads it, with a neutral fallback |
| `control-api` `playbooks()`, the New Project page | Flat playbook list | Grouped by entity (done earlier) |
| `simulator`, `demo-runner.ts` | The demo is a SitecoreAI project | Unchanged on purpose: it is one example project, and it names its platform through its playbook |

The pack gained three hooks in all: `buildEnv` (a CLI that needs more than the head), `starter`
and `buildRecipe`.

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

## The team changes with the entity

The method roles (Chief of Staff, four Leads) and the discovery and core quality roles are the
same team on every entity, with the same role ids, so scorecards, rules and Cypher's triage
compare across playbooks. The specialists follow the platform's model. Optimizely's model differs
from SitecoreAI's in two ways that reshape the engineering and content workstreams: the content
model is code (types, display templates and page types are TypeScript next to the component, and
"registering" is `config push`), and the platform has no site-settings layer (redirects, sitemap,
robots and error pages are head code, not items).

| SitecoreAI role                        | Optimizely                                                                                                                                         | Why                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Rendering Registrar                    | Gone. The Head Integrator pushes a branch's types with `--only` in the integration task that deploys its code (`integrate-{key}`)                  | Visual Builder needs the type in the CMS and the code on the host together; one task lands both             |
| Layout Engineer                        | Gone. Page types are code tasks for the Component Engineer (`define-type-{key}`), pushed by an integration; blueprints and the shell are content tasks for the Experience Builder | A content role with a sandbox and a CLI mixed two jobs                                                      |
| Tenant Provisioner                     | Folded into the Deployment Engineer (phases 0 and 3)                                                                                               | Application, locales and media folder are three calls; hostnames and live preview already sit with deployment |
| Content Migrator                       | Named **Experience Builder** (id `content-migrator`), active in phases 5 to 7: shell, blueprints, pages, SEO properties                            | Composing an experience from a blueprint is the central act, and the same person should make the blueprints |
| Experience Enabler                     | Gone. Routing, sitemap, robots, error pages and webhooks go to the Head Integrator (`routing-and-seo`); SEO properties to the Experience Builder; the proof experiment to Visual Builder QA, only with the feature | Most of the work is code on this platform                                                                   |
| Editor Experience QA                   | Named **Visual Builder QA** (id `editor-experience-qa`)                                                                                            | Same job, different editor                                                                                  |
| Structural Validator                   | Named **Model Validator** (id `structural-validator`)                                                                                              | Structure is validated by the dry-run push and read-back; the role checks the model against the Blueprint   |

Twenty roles instead of twenty-four, and a shorter loop per component: build, integrate (push
plus deploy), compose, prove. Until a pilot has run, the entity-specific builders should run at
higher effort and the `tool` autonomy category should stay in shadow, because pushes touch a
shared instance.

### SitecoreAI team: optimizations applied (version 0.7.0)

Applied 2026-10-31, once the Director decided Lambert's Cable and Star LLC will not run again
(a running project kept the playbook it started with, but its agents used the catalog's roles,
so those two could not resume on 0.7.0; since version pinning, 0.5.1 and 0.6.3 are kept and
they would run with their own teams). The team goes from 24 roles to 21.

| Change | Evidence |
| --- | --- |
| The Rendering Registrar and the Layout Engineer are one **Sitecore Modeler** (the registrar's id, phases 4, 5 and 8, the union of both scopes) | Same skill (SXA item modelling), overlapping scopes, and two access denials on Star (placeholder settings, Headless Variants) that each cost a card and a handoff |
| Visual QA is folded into the Parity Auditor: its `visual-sample` task is gone | The Parity Auditor's `audit-parity` already runs `parity.visual` on every page with a model judge; the 0.5% pixel diff flagged every rebuilt page |
| The Performance and Accessibility QA has a task: `perf-a11y-audit` in phase 8 | It had `activePhases: []` and no template, yet the Definition of Done needs its evidence. The live stack test now runs a real axe audit through it |
| The Tenant Provisioner is folded into the Deployment Engineer (phases 0, 3, 4, 8) | A phase 0 probe and phase 3 folders; the shared-tenant scope rules live in the pack and the gateway, not in a role |
| The personalization proof moved to the Editor Experience QA; the Experience Enabler works in Sitecore items only | Both needed `page-builder.drive`; one role owns Page builder work |
| `prove-pilot-slice`, `smoke-test` and `prove-personalization` are **by-hand steps** (`manual:` in the plan) until M7 | Without a Page builder driver they always ended in a "not connected" card (Lambert's smoke test). The workflow (`patched('manual-steps')`) now raises a "By hand" card with the checklist and runs no agent; the task is done when the Director marks it done |

## The Optimizely entity: shipped now

- **Connector** (`packages/connectors/src/optimizely.ts`): token minting against
  `https://api.cms.optimizely.com/oauth/token` (client credentials), a live check that reads
  the instance's content types through REST API v1, a live check of the Graph single key with a
  one-item query, a shape check for the Graph app key and secret, and `applicationKey` (the
  key the API accepts for an application's name).
- **Pack** (`platforms/optimizely/pack.ts`): intake fields `cmsUrl`, `application`,
  `typePrefix`, `languages`, `hostingProject`; credentials `cms-api-client`, `graph-single-key`,
  `graph-hmac`; a connection shares the instance URL, locales and all three credentials;
  bindings `{application}` (the application's key), `{typePrefix}`, `{contentRoot}`,
  `{sharedRoot}`, `{mediaRoot}`; owned scopes are the application's pages, shared blocks and
  media, the prefixed types and templates and the application itself; `headEnv`, `buildEnv`,
  target context, and `checks`.
- **Tool servers** (`tool-servers/optimizely`):
  - `optimizely-cms` on REST API v1: `application.{list,read,create}`, `hostname.{add,remove}`,
    `preview.configure`, `locale.list`, `contenttype.{list,read}`, `displaytemplate.{list,read}`,
    `manifest.export`, `content.{read,create,update,publish}`, `composition.write`,
    `content.previews`, `blueprint.{list,create}`, `media.upload`. The team's items have paths
    (`/content/<application>/…`, `/shared/<application>/…`, `/media/<application>/…`) and an
    item's key is derived from its path, so a repeated create updates instead of duplicating.
    It writes only inside the project's application and only content of types carrying the
    project's prefix; publishing and host changes are release operations; nothing deletes. The
    content model itself is never written here: it is code.
  - `optimizely-graph`, read only: `graph.query`, `graph.routes` (narrowed to the application's
    hosts: one index holds every application), `graph.item`. Drafts are read with a signed
    request when the app key and secret were given; the keys never leave the server.
- **Sandbox** (`tool-servers/sandbox`): `exec.optimizely-cli` with `push-dry-run` and `push`.
  A push is always preceded by a dry run, refuses any key outside the project's prefix and any
  property group, and is sent with `--only` those keys, never `--force`.
- **Checks**: `platforms/optimizely/checks.ts` reads the CMS, Graph and the head
  (`structural.application`, `structural.content-types`, `structural.templates`,
  `structural.experiences`, `types.pushed`, `editor.element-enabled`, `editor.new-experience`,
  `hostname.registered`, `graph.published`, `routes.resolve`, `head.preview-route`,
  `head.pages-render`, `head.header-footer`, `parity.render`, `parity.visual`); the step-based
  `types.defined` and `manifest.replays` are in `packages/stack/src/review.ts`.
- **Knowledge** (`platforms/optimizely/knowledge/known-pitfalls.md`): eighteen rows proven on
  a live instance, then the rows from the documentation that no build has met yet.
- **Playbooks**, both in the order the platform sets (content types first; then the application,
  whose start page is of a pushed experience type, with its host and live preview; then shared
  blocks and pages, published as they are written, because the head and the checks read
  published content): `playbooks/optimizely-saas-migration` (the whole site) and
  `playbooks/optimizely-homepage-demo` (the audit, then the homepage, header, footer and
  navigation; see [homepage-demo-playbook.md](homepage-demo-playbook.md)).
- **First build**: Microsoft's homepage, the same one the SitecoreAI demo built, in
  `icreon-launchworks/microsoft-sitecoreai` under `examples/optimizely-nextjs`, live at
  https://microsoft-optimizely.vercel.app: 19 content types and 11 display templates (prefix
  `Msft`), the application `microsoft_demo` with its own assets, 37 media items, shared
  header, navigation and footer blocks, and the homepage as an experience of 12 sections,
  published and served by Optimizely Graph. Run against it, the pack's checks pass 13 of 15:
  `editor.new-experience` fails (no blueprint: the API key may not create one) and
  `parity.visual` needs a connected model.

`platforms/test/platforms.test.ts`, `platforms/test/optimizely-checks.test.ts`,
`tool-servers/optimizely/test` and `tool-servers/sandbox/test` cover them; the read operations
the content writes (media, shared blocks, pages, compositions, publishing) and every check were also run against the live instance.

## The Optimizely entity: to build

| #  | Work | Size |
| -- | ---- | ---- |
| O3 | The starter template repository. The official starter is `npx @optimizely/cms-create-app <name> --template nextjs-starter`; a build repository is generated from a template repository, so it needs a copy in `icreon-launchworks` marked as a template, then `pack.starter` and `pack.buildRecipe`. Until then intake refuses a build repository for this pack | S |
| O4 | The checks nothing implements yet: `parity.page` (content parity by words needs the source inventory's pages mapped to routes), `media.alt-text` (needs a media listing), `experience.redirects-resolve` | S |
| O9 | Shared pieces that still read another platform's contract, so the Optimizely plans leave them out: `blueprint.coverage` (`attrs.fields`, `attrs.rendering`, `attrs.queryBudget`), `editing-host.responds` (`/api/editing/config`), and the `validators` server's `structural.run` scopes (`site`, `templates`, `renderings`) and `parity.run` (offered only when the pack has `parity.page`). Until they are portable the Blueprint is judged by the Discovery Lead and Gate 1, and the validator roles work through `acceptance.check` and reads | M |
| O5 | Browser `visual-builder.drive` and `video.record`: the same capability gap as `page-builder.drive`; M7's driver should cover both editors | L (shared with M7) |
| O6 | Catalog grouping and UI: `entity.yaml`, `GET /entities`, the wizard's entity step, platform names in copy | S |
| O7 | Run both playbooks end to end with the Director on a live project (the first build was made by hand through the same REST calls and tool servers, to prove them) | – |
| O8 | Webhooks from Graph to the head for on-demand revalidation (`webhook.{list,create}`: a Graph API, not the REST API's); the head revalidates on a timer until then. `locale.add`: locales are instance-wide, so enabling one stays a Director step | S |

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
4. **The starter**: Optimizely's own, unchanged, as with Sitecore's. The Microsoft build started
   from `npx @optimizely/cms-create-app --template nextjs-starter` and the team added the design
   system, the registry and the model files as project work, the way the SitecoreAI team does on
   Sitecore's starter. What remains is a template repository holding that starter (O3): GitHub
   generates a build repository only from a repository marked as a template.
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
