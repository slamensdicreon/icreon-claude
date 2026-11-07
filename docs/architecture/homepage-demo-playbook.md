# The homepage demo playbook

Status: **plan**, 2026-11-07, with the Director's decisions (see *Decisions*). Replaces the first
draft of this plan (branch `claude/ecstatic-noether-cdioit`). Companion to
[playbooks.md](playbooks.md) and the commercial model (internal deck, slide 6: "One meeting. Their
homepage. Signed.").

## What it is

A sales demo that runs the team's real method on a prospect's site. The team does the full
Discovery and audit and writes the whole-site Blueprint, then builds only the **homepage, header,
footer and navigation** on SitecoreAI. The build goes through parity and deploy. The prospect then
sees their own homepage in Page builder, where a marketer drags components in, edits them and
publishes without a developer.

**The demo stands alone.** It runs on our tenant and closes when the homepage is reviewed. If the
prospect signs, their build starts from scratch as a new project on `sitecoreai-migration`, on their
own tenant. Nothing is transferred from the demo.

## The outcome

The playbook's charter, which every agent gets in its role prompt and acceptance is judged against:

> **Mission:** Show a prospect their own homepage on SitecoreAI, built the way we would build their
> whole site, so a marketer can assemble and edit it in Page builder without a developer.

| Outcome | Measured by |
| --- | --- |
| **Marketer drag and drop** on the homepage | Every homepage component is in the Page builder toolbox and can be dragged into the homepage's placeholders. It edits inline, and a new instance creates its own datasource with starter content. Existing validators: `editor.component-enabled`, `editor.new-datasource`, `structural.renderings` |
| **Header, footer and navigation are the marketer's** | They live in partial designs on shared datasources. A marketer edits a menu link, a footer column and the logo once, and the change shows on every page using the design (`head.header-footer`) |
| **Homepage parity** | The homepage and 404 match the live site: render, visual parity at three breakpoints, content parity (`parity.render`, `parity.visual`, `parity.page`) |
| **Deployed** | The reviewed commit runs on the editing and delivery hosts, the homepage is published to Experience Edge and it resolves on the preview URL (`deploy.commit-matches`, `editing-host.responds`, `edge.published`, `routes.resolve`) |
| **The audit is real** | Full Discovery and a whole-site Blueprint approved at Gate 1, with every page, template and component listed |

Out of the charter, because the demo doesn't owe them: whole-site content parity, client ownership
and handover, site-wide SEO, redirects and sitemap, personalization, the perf and accessibility
audit, and serialization.

## Why it stays close to the website playbook

The team works the way it always does. That keeps the demo honest (the prospect sees our real
method), and keeps the work light (no second method to learn or maintain):

- **Same phases 0–3.** Intake, full Discovery (every sitemap URL crawled or excluded), the whole
  Blueprint with Gate 1, and Foundation, all as today.
- **Same roles, prompts, tools and validators.** The only playbook-specific text is the charter and
  a paragraph telling the Architect and the Leads what the demo builds.
- **Same quality bar on what it builds.** Lead reviews, autonomy and escalation work as today. The
  slice is small, not sloppy.

`playbooks/sitecoreai-homepage-demo/` is a copy of `sitecoreai-migration` with its own charter,
intake and plan. Roles, prompts and knowledge are copied too, and a **drift test** fails when they
differ from the website playbook's, except where the demo playbook says so on purpose. When the SDK
gets a real `extends`, the copy goes.

## Scope

| | Audited (phases 1–2) | Built (phases 3–8) |
| --- | --- | --- |
| Pages | Every page, crawled and in the Blueprint | The homepage and the 404 page |
| Templates | Every template | The homepage's template; the 404's if different |
| Components | Every component, with its model contract | The homepage's components, the header, the footer and the navigation |
| Media | Every media item in the manifest | Media the homepage and the header, footer and navigation use |
| Site-wide | Redirects, forms, languages, integrations listed | Header and footer partial designs, the page design, error page setting |

### The slice

The Architect writes the whole Blueprint, then keeps the slice and holds the rest:

- **Pages**: `attrs.path: "/"`, and `attrs.errorPage: 404`.
- **Templates**: those pages' `attrs.template`.
- **Components**: those with a variant whose `pages` include `/` or the 404, those with
  `datasource: "shared"` (header, footer, navigation), and whatever they're merged into.
- **Media**: items whose `attrs.pages` include those pages, or `attrs.shared: true`.

Everything else is `status: "drop"` with `attrs.held: true`. The Workbench shows these as
**audited, not built**, not as dropped. Dropped (without `held`) still means "won't move", with a
reason.

**Nobody has to trust the Architect on this.** `blueprint.demo-slice` runs at Gate 1 with the other
Blueprint checks. It derives the slice from the Blueprint and fails on any mismatch: a page kept
outside the slice, a homepage component held, the navigation merged, a template or media item kept
that nothing in the slice uses, a held component without its model contract, a drop with neither
`held` nor a reason. Because held items are `drop` to everything else, the plan compiler, the
acceptance checks and the agents' context all work unchanged and build only the slice.

**Navigation is its own component.** The Architect often merges navigation into the header. In
this playbook it stays a component of its own with a shared datasource (menu items as child items
with a `max`), so a marketer can visibly edit the menu. The demo's Architect prompt says so.

## Phases

| # | Phase | Runs | Exit |
| --- | --- | --- | --- |
| 0 | Intake | Today's intake on our tenant; the site is created by hand first (see *Where it's built*) | Credentials verified, the paths the project owns fixed |
| 1 | Discovery | **Unchanged** | Full inventories, asset manifest, risk list; every sitemap URL crawled or excluded |
| 2 | Blueprint, **Gate 1** | **Unchanged**, plus: navigation kept as its own component; acceptance always checks `/` | Whole Blueprint approved; the gate card shows the slice |
| 3 | Foundation | **Unchanged** | Site, tokens, primitives, hosting; an empty page renders on the editing host |
| 4 | Components | Slice components ported, registered, integrated and enabled in Page builder. The slice is the pilot, so there's no separate pilot checkpoint | Every slice component passes `structural.renderings`, `editor.component-enabled`, `editor.new-datasource` |
| 5 | Templates | The homepage's template with insert options and placeholder settings that allow every slice component; header and footer partial designs; the page design | `head.header-footer`; the page design assigned |
| 6 | Migration | Homepage and 404 content and media; header, footer and navigation datasources filled from the live site; **parity audited on both pages** | `parity.render`, `parity.visual`, `parity.page` on `/` and the 404 |
| 7 | Experience | Homepage components datasource-driven; homepage SEO fields; the site's 404 setting | `seo.titles` on the homepage |
| 8 | Deployment | Code deploy to the editing and delivery hosts; publish to Experience Edge | `deploy.commit-matches`, `editing-host.responds`, `edge.published`, `routes.resolve` |
| 9 | Review, **Gate 2** | A demo summary; the Director runs the drag-and-drop check in Page builder | The Director accepts; the project closes |

The demo has two Director gates, like the website playbook, so the final gate closes it as
designed. No orchestrator change is needed.

**The drag-and-drop check** (the demo's UAT, since agents have no Page builder sign-in): open the
homepage in Page builder, drag a component from the toolbox into a placeholder, edit it inline, edit
a navigation link in the header partial design, publish and see both changes on the preview URL.
That's also the script for the meeting.

**The demo summary** replaces the handover pack: the audit in numbers (pages, templates,
components, languages, forms, sites), what was built, known gaps, and the size of the full build
from the Blueprint's counts. It's what you leave with the prospect.

## What Cypher says

- **At Gate 1**: *"62 pages, 7 templates, 41 components, 380 media. The demo builds the homepage and
  404, the header, footer and navigation: 11 components, 1 template, 24 media; the rest is
  audited, not built."* The Architect's prompt makes this the opening of its summary, and
  `blueprint.demo-slice` reports the same counts. The Workbench shows the whole Blueprint, with
  held items marked audited, not built. The gate card itself is the standard one.
- **During the build**, held items have no tasks, so the plan and the Floor show only the slice.
- **At Gate 2**: the demo summary carries the parity results, the known gaps and the
  drag-and-drop checklist; the manual card points at it.

## Where it's built

Demos run on **the SitecoreAI tenant we've been using**, through its saved connection
(`platforms/sitecoreai/pack.ts:153-163`):

- **Each demo gets its own site**, so prospects never share items and our other sites are left
  alone. Agents can't create SitecoreAI sites (`tool-servers/sitecore/src/authoring.ts:510-525`
  only verifies them), so the site is created by hand in SitecoreAI Sites before the run. That
  takes a few minutes.
- **A build repo and Vercel project per demo**, made by intake as today.
- **Cleanup after 30 days**: the site's items, the repo and the Vercel project. Whether or not the
  prospect signs, the demo is deleted; a signed client's build starts fresh on their tenant.

## The clock

The full audit doesn't fit in a 45-minute meeting, so the run starts when the meeting is booked:

1. **Start the run** with the prospect's URL. Discovery and the Blueprint run; you approve Gate 1
   from Cypher's card.
2. **The build runs** through deploy, over hours, not minutes.
3. **Run the drag-and-drop check** and accept Gate 2 before the meeting.
4. **In the meeting**: the audit, the whole-site Blueprint, then their homepage in Page builder.
   You drag in a component, edit the menu and publish, live.

M0 tells us the real time from URL to Gate 2, which is the lead time to book against.

## Speed settings

- `canary: 0` on the slice's `forEach` templates.
- No pilot block: the slice is the pilot.
- `deploy-code` and `publish-edge` are `standing` approvals. This is safe because the target is
  always our demo tenant, never a client's.
- Budgets sized for one page (to set from M0; a starting point of 8 hours and $300).

## Changes in the code

Built (M1). `sitecoreai-migration` doesn't change.

| Change | Where |
| --- | --- |
| The playbook: charter, intake on our tenant, phases 0–9, the plan over the slice (canary 0, standing deploy and publish, the drag-and-drop check), the demo's Definition of Done, fixtures | `playbooks/sitecoreai-homepage-demo/` |
| Prompts: the Architect's slice rules and Gate 1 summary; the Content Analyst re-crawls only the homepage and 404; the Experience Enabler skips redirects, sitemap and robots; the Handover Writer writes the demo summary and the drag-and-drop checklist | The demo's `prompts/`, `roles/handover-writer.yaml` |
| `blueprint.demo-slice` | `packages/stack/src/review.ts` |
| A `held` status ("audited, not built") in the Blueprint view and the Workbench | `packages/contracts/src/snapshots.ts`, `packages/plan/src/blueprint-view.ts`, `apps/web/src/surfaces/workbench/` |
| Tests: the playbook loads; the plan of the example Blueprint is exactly the slice; the slice check; the drift test against the website playbook; check coverage; a whole demo project through the orchestrator with stub agents, from intake to Gate 2 | `packages/stack/test/homepage-demo.test.ts`, `packages/stack/test/coverage.test.ts`, `packages/orchestrator/test/homepage-demo.test.ts` |

Still to do: the 30-day cleanup (M4).

## Milestones

| | Work | Done when |
| --- | --- | --- |
| **M0 Measure** | Run `sitecoreai-migration` to Gate 1 on three sites (one with a repo, two URL-only), then have the Architect drop everything outside the slice and run through deploy | A timing table from URL to deploy, and the critical path named |
| **M1 The playbook** ✅ | The playbook folder, charter and plan; `blueprint.demo-slice`; the `held` status; the drift test | Done: it loads and validates, the example Blueprint's plan is exactly the slice, and a whole demo project runs to Gate 2 with stub agents |
| **M2 Drag and drop** | A first real run on our tenant with live agents; fix what the drag-and-drop check finds (placeholder settings, insert options, the navigation's datasource) | On one site, the check passes in Page builder |
| **M3 Cypher and the summary** | The demo summary and Gate 1 summary as written by live agents; audited-only items on the Floor | Design review on one finished demo |
| **M4 Our tenant** | The by-hand site checklist; the 30-day cleanup | Two demos side by side with nothing crossing between them; cleanup leaves nothing behind |
| **M5 Dry runs** | Five varied sites, end to end, plus the meeting script | All five reach Gate 2 with homepage parity and the drag-and-drop check passing |

M0, M2 and M4 can start now. M5 needs everything.

## Risks

- **The lead time.** If M0 shows URL to deploy takes more than a working day, meetings have to be
  booked further out. M0 comes first for that reason.
- **URL-only parity.** Agents can't view screenshots, so visual parity is the weak spot without a
  repository. One page keeps the gap small; giving Visual QA image input is the real fix and helps
  every playbook.
- **Drift.** The copy can fall behind the website playbook's fixes. The drift test catches it until
  the SDK supports `extends`.
- **Prospect content on our tenant.** Preview isn't indexed, each demo has its own site, and
  everything is deleted after 30 days. This needs a line in the meeting.

## Decisions

Made by the Director on 2026-11-07:

1. **Who runs it:** Steve, as the first salesperson and DID, on the SitecoreAI tenant we've been
   using.
2. **No transfer.** The demo closes at Gate 2. A signed client starts from scratch on
   `sitecoreai-migration`, on their own tenant.
3. **The outcome:** marketer-friendly drag and drop in Page builder on the homepage, header, footer
   and navigation, with parity on the homepage, through deploy.
4. **The 404 page** is part of the slice.
5. **Retention:** 30 days, then the demo is deleted.
