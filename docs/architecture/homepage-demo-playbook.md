# Homepage first: the full audit, one page built

Status: **plan**, 2026-11-07. Replaces the first draft of this plan (branch
`claude/ecstatic-noether-cdioit`). Companion to [playbooks.md](playbooks.md) and the commercial
model (internal deck, slide 6: "One meeting. Their homepage. Signed.").

## What changed from the first draft

The first draft built a separate, cut-down playbook. It sampled the site instead of auditing it,
skipped Foundation and marked every page except the homepage `drop`. This version keeps the team's
method as it is:

- **Same playbook.** `sitecoreai-migration` gains one project setting, **Execution scope**: *Whole
  site* (today) or *Homepage first*. There's no copy, so roles, prompts and knowledge can't drift
  apart.
- **Full Discovery and the full audit.** Phases 0–2 run unchanged: every sitemap URL is crawled or
  excluded, the full component and page inventories are written, along with the asset manifest and
  risk list. The Solution Architect writes the whole Blueprint, and the Director approves it at
  Gate 1.
- **Only execution narrows.** From Foundation on, the plan builds only what the homepage needs.
  Everything else stays in the Blueprint as **held for the full build**, not dropped.
- **The same project continues.** When the client signs, the Director widens the scope. The held
  items become tasks in the same project, with no new project and no second crawl.

## Why this works for the team

- **One method.** Agents, Leads and Cypher do what they always do. The only extra knowledge is "this
  run builds the homepage slice". No one maintains a second playbook.
- **Accurate numbers.** Sizing comes from the real inventory and the approved Blueprint, not a
  30-page sample. The estimate of the remaining build is grounded in the same counts the team will
  build against, so the first draft's sampling, confidence label and calibration test aren't needed.
- **No throwaway work.** The homepage's components, template, header and footer are the first real
  deliverables of the migration. The Blueprint the client saw is the Blueprint the team builds.
- **The homepage is a better pilot slice.** Today's pilot is 2–4 "representative" components. The
  homepage exercises the header, footer, hero and the densest mix of components, end to end through
  publishing and Page builder.

## How a Homepage-first run goes

| # | Phase | Whole site (today) | Homepage first |
| --- | --- | --- | --- |
| 0 | Intake | Unchanged | Unchanged; the tenant is the client's or a demo slot (see *Where it's built*) |
| 1 | Discovery | Full crawl and inventories | **Unchanged** |
| 2 | Blueprint, Gate 1 | Whole Blueprint approved | **Unchanged.** The gate card also shows the slice: what gets built now and what's held |
| 3 | Foundation | Site, tokens, primitives, hosting | Unchanged (it's site-level and the homepage needs all of it) |
| 4 | Components | Every Blueprint component | The homepage's components, plus header and footer. They are the pilot slice, proven end to end |
| 5 | Templates | Every template | The homepage's template; header and footer partial designs |
| 6 | Migration | Every page and media item | The homepage's content and its media; parity audited on `/` |
| 7 | Experience | Site-wide SEO, redirects, sitemap, error pages | Homepage SEO fields and dictionary only; site-wide items held |
| 8 | Deployment | Three verified releases | The same releases; perf and a11y measured on the homepage |
| 9 | Review | Gate 2: UAT and acceptance, closes the project | **Homepage review**: the Director checks the homepage in Page builder. The project **does not close**; it waits on *Build the rest* |

### What's in the slice

The slice is derived from the approved Blueprint and doesn't need its own artifact:

- **Pages**: the page with `attrs.path: "/"`. The 404 page can be added too, but it's off by default.
- **Templates**: the homepage's `attrs.template`.
- **Components**: those with a variant whose `pages` include `/`, those with `datasource: "shared"`
  (header, footer, navigation), and whatever they're merged into.
- **Media**: the media the homepage's content references.

The Solution Architect doesn't choose the slice; the compiler derives it. The Architect's one new
duty is checking that the homepage's sections each map to a component (acceptance already checks
this per sampled page; it must always include `/`).

### Held, not dropped

`drop` means "won't move" and is a decision the client sees. The held items are different: they
will move, just not yet. So the slice is a **filter applied at compile time**, not a Blueprint
edit:

- The Blueprint stays exactly as approved at Gate 1, so the version the client saw is the version
  the team builds.
- The plan compiler expands `forEach` templates in phases 3–8 only over items in the slice. Held
  items appear on the Floor and in the plan as **Held for the full build**, the way placeholder
  tasks appear before Gate 1.
- Widening the scope recompiles against the same Blueprint. The added tasks go through the same
  path a Blueprint revision's added items already take (`diffBlueprints`, `project.ts:1691`).

## What Cypher says

Cypher is the one who explains the split, so the Director never has to work it out:

- **At Gate 1**, the card: *"Blueprint ready: 62 pages, 7 templates, 41 components, 380 media.
  Homepage first builds 1 page, 1 template, 11 components and 24 media. The other 61 pages are held
  for the full build."* The Workbench shows the whole Blueprint, with the slice highlighted.
- **During the build**, the Floor shows held work dimmed, so no one thinks it's stalled.
- **At Homepage review**: *"The homepage is on preview and in Page builder. Known gaps: 2. The full
  build is 34 components, 6 templates and 61 pages, about 6 hours. Build the rest?"* The estimate
  comes from the remaining task counts and this project's own measured times per task.
- **Build the rest** is a scope card (the `scope` category always asks the Director). Accepting it
  widens the scope; the project returns to phase 4 for the held items and runs on to Gate 2 as a
  normal project.

## Where it's built

| Situation | Tenant | After signature |
| --- | --- | --- |
| The client has given us access to their SitecoreAI environment | **Theirs** (best: nothing moves later) | *Build the rest* in place |
| A prospect without a tenant or access yet | A **demo slot** on our tenant: a pre-made site, build repo and Vercel project | The project moves to their tenant: new intake credentials verified, Foundation re-run there, the slice's items replayed by serialization (already part of phase 8), the repo transferred. Then *Build the rest* |

Agents can't create SitecoreAI sites (`tool-servers/sitecore/src/authoring.ts:510-525` only
verifies them), so demo slots are created by hand ahead of time. Start with three, and reset each
one after use (items removed, repo back to the starter tag). Unsigned prospect content is deleted
after 30 days.

## The clock, honestly

The full audit doesn't fit in a 45-minute meeting. Discovery on a 60-page site crawls every URL
sequentially (up to 30 s per navigation), and the Blueprint needs Gate 1. So the meeting no longer
watches the build start from a URL. Instead:

1. **The run starts when the meeting is booked** (or right after a first call). Discovery, the
   Blueprint and the homepage run over hours, not minutes. Cypher asks for Gate 1 like on any
   project, and the DID approves it ahead of the meeting.
2. **The meeting shows the finished work**: the audit, the whole-site Blueprint, the homepage in
   Page builder, a live headline edit published to preview, and the estimate for the rest.
3. **The close** is *Build the rest*, the same afternoon if the client is on their own tenant.

This is a stronger meeting than a race against the clock. The prospect sees a real audit of their
whole site and a real page, and none of it depends on a 45-minute run going perfectly.

### Speed settings (Homepage first only)

These don't affect *Whole site* runs:

- `canary: 0` on the slice's `forEach` templates. There's one page; a canary adds nothing.
- `deploy-code` and `publish-edge` count as `standing` approvals **only on a demo slot**, never on
  a client tenant.
- The pilot checkpoint is skipped, because the whole slice is the pilot.

Review counts, autonomy and escalation deadlines stay as they are. The team works the same way.

## Changes in the code

| Change | Where | Size |
| --- | --- | --- |
| `executionScope: site \| homepage` on the project, chosen in New project for playbooks that declare it | `packages/playbook-sdk/src/schema.ts`, `apps/control-api/src/intake.ts`, wizard | Small |
| A `slice` declaration in `plan.yaml`: which phases it applies to (3–8), how each collection is filtered (the rules above) | `playbooks/sitecoreai-migration/plan.yaml`, `schema.ts` | Small |
| The compiler filters `forEach` expansion by the slice and lists held items | `packages/plan/src/compile.ts:340-354`, `blueprint-view.ts` (a `held` status beside `dropped`) | Medium |
| **Gate roles**: `gateRole: blueprint \| acceptance \| review`. Today the last Director gate is treated as acceptance and closes the engagement; Homepage review must not | `packages/orchestrator/src/workflows/project.ts:120-122, 700-708, 1513`; both playbooks declare theirs | Medium |
| **Widening the scope**: recompile without the slice, add the held tasks, and move a finished phase back to in progress | `project.ts` replan path | Medium: the one real orchestrator risk |
| Architect: always check `/` in acceptance | `prompts/solution-architect.md`, the acceptance check | Small |
| Cypher's lines: slice summary at Gate 1, held work on the Floor, Homepage review card with the estimate | Chief of Staff prompts, Floor, Workbench | Small |
| Moving a demo-slot project to the client's tenant | Intake, phase 0 re-verify, serialization replay | Medium; can come last |

## Milestones

| | Work | Done when |
| --- | --- | --- |
| **M0 Measure** | Run today's playbook to Gate 1 on three sites (one with a repo, two URL-only), then build only the homepage by hand-holding the scope | A timing table: Discovery, Blueprint, homepage build |
| **M1 Gate roles** | `gateRole` in the schema and orchestrator; `sitecoreai-migration` and the portal playbook declare theirs | Existing tests green; a run can stop at a `review` gate without closing |
| **M2 The slice** | `executionScope`, the `slice` declaration, compiler filtering, held items in the plan and Floor, the Architect's `/` check | A Homepage-first run builds exactly the slice; *Whole site* plans are byte-identical to today's |
| **M3 Build the rest** | Widening the scope in a running project | A Homepage-first project widens and reaches Gate 2 with nothing rebuilt twice |
| **M4 Cypher** | Gate 1 slice summary, Homepage review card with the estimate, held work in Bliss and Everything | Design review on the demo project |
| **M5 Demo slots** | Three slots, claim and release, reset | A slot runs, resets and runs again with nothing left behind |
| **M6 The meeting** | DID script, presentation view (audit, Blueprint, homepage, estimate), five dry runs | Five varied sites: the homepage on preview before the meeting, every time |
| **M7 Tenant move** | Move a demo-slot project to the client's tenant | A signed prospect's project continues on their tenant without re-running Discovery |

M0 and M1 can start now. M2 needs M1. M3 needs M2. M5 is independent. M7 comes last.

## Risks

- **Widening a running project.** Phases 4–8 finished on the slice and then reopen. If the
  orchestrator can't do that cleanly, the fallback is a second project that imports the first's
  Discovery, Blueprint and Gate 1. That's more moving parts, so M3 tries the in-place route first.
- **URL-only parity.** Agents can't view screenshots, so visual parity is the weak spot without a
  repository. One page keeps the gap small; giving Visual QA image input is the real fix.
- **Prospect content on our tenant.** Preview isn't indexed, slots are reset, and unsigned content
  is deleted after 30 days. This needs a line in the meeting and in the terms.
- **Shared components look finished.** The header, footer and navigation are built for the homepage
  but serve every page. The full build's Lead review must still check them against the other
  templates, not treat them as done.

## Open questions for the Director

1. **Start the run when the meeting is booked:** is that how sales wants to work, or do we need an
   in-meeting moment that isn't the finished homepage?
2. **Client tenant or demo slot by default:** do we ask prospects for SitecoreAI access before
   signing?
3. **Is the 404 page part of the slice?** It's cheap and shows error handling, but it's a second
   page.
4. **Retention:** is 30 days right for an unsigned prospect's demo?
