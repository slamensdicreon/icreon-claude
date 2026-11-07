# The homepage demo playbook

Status: **plan**, 2026-11-07. Companion to the commercial model (the internal deck, slide 6: "One
meeting. Their homepage. Signed.") and to [playbooks.md](playbooks.md).

## What it is

A variant of the SitecoreAI website playbook (`playbooks/sitecoreai-migration`) that runs inside
one sales meeting. The Deployed Implementation Director (DID) types the prospect's live URL into
New project. Within 30 to 60 minutes, the prospect has seen two things:

1. **The whole site, sized.** Pages, templates, components, languages, forms, media and the sites
   that would sit under the entity, counted across the entire site. From that, the license is
   scoped in the room: the entity, extra sites, the playbooks that fit, and the three Director
   months.
2. **Their homepage, built on SitecoreAI.** Executed end to end on our demo tenant: components
   ported and registered, the page composed, a preview deploy, and the page open in Page builder
   where the DID edits a headline live.

**The demo is the close.** There are no milestones and no payment gates: a full migration takes
hours, so the prospect buys a license (per entity and per playbook) in the meeting, with a DID
required for the first three months. The next day the DID starts the full migration on the
customer's own tenant on `sitecoreai-migration`, starting from the demo's inventory and Blueprint.

## What the code gives us today

The research behind this plan read the playbook SDK, the plan compiler, the orchestrator and the
run records.

| Need | Today | Where |
| --- | --- | --- |
| A playbook that only executes one page | **No switch.** A page can be kept out of the build by marking it `status: drop` in the Blueprint; dropped items stay visible, so the sizing survives | `packages/plan/src/compile.ts:345-354` |
| Whole-site sizing | **Nothing produces a size or a license scope.** The inputs exist: `page-inventory` (pages, words, images, languages, templates, forms, redirects) and the repo or live-UI inventory (components with `usedOn`) | `prompts/content-analyst.md:11-91`, `prompts/repo-analyst.md:15-60` |
| The homepage's components | `usedOn: ["/"]` on inventory components is the natural selector | `prompts/repo-analyst.md` |
| URL-only source | Supported since 0.5.0 (`inventory-live-ui`, `page.markup`, `page.styles`), but visual parity loops are the weak spot: agents can't view screenshots | `docs/architecture/agent-intelligence-build-plan.md:136-160` |
| Our own tenant, repo and hosting | Already how it works: build repos in our GitHub org from the starter, our Vercel team, shared tenant by saved connection | `apps/control-api/src/intake.ts:486-531`, `platforms/sitecoreai/pack.ts:153-163` |
| Creating the SitecoreAI site | **Not automated.** Only `site.verify` exists; sites are created by hand in SitecoreAI Sites | `tool-servers/sitecore/src/authoring.ts:510-525` |
| Pilot slice | Optional in `plan.yaml`; it's 2–4 representative components, not the homepage | `packages/playbook-sdk/src/schema.ts:257-268` |
| Canary | Per template, `canary: 0` turns it off | `schema.ts:214-219` |
| Gates | The Blueprint is adopted only when a Director approves a gate. **Trap:** if that is the playbook's only Director gate, it is treated as the final gate ("Accept …", typed-name confirmation, closes the engagement) | `packages/orchestrator/src/workflows/project.ts:120-122, 700-708, 1513` |
| Release approvals | `standing: true` releases pass on their own; `deploy-code` and `publish-edge` are not standing today | `project.ts:2541-2556` |
| Deadlines | `defaults.escalationDeadlines` accepts minutes (`5m`) | `playbook.yaml:129-135` |
| Inheritance between playbooks | **None.** The portal and Optimizely playbooks are copies with edits | `packages/playbook-sdk/src/load.ts` |

### The clock

The target is the homepage in 30 to 60 minutes. The run records so far are for whole sites, and
they agree with "a migration takes hours":

- **Ervin Cable** (no repo, about 16 pages) took about 8 hours across phases 4–6. Most of that was
  page-migration loops waiting on component send-backs.
- **Ansco** took 62.5 hours.
- **The fixed waits:**
  - A Vercel deploy waits up to 8 minutes.
  - A publish waits up to 8 minutes.
  - npm install allows 15 minutes.
  - Serialization allows 30 minutes.
  - The crawl is sequential, at up to 30 seconds per navigation.
- **No task template sets an `estimate`.**

One homepage is a small job: the header, the footer and six to ten components. The fixed waits
decide whether it fits in the hour, so the first milestone times a homepage-only run before we tune
anything.

## The design

### Scope

| | Whole site | Homepage only |
| --- | --- | --- |
| Crawl / sample | Yes, sized from the sitemap plus a sample | Fully inventoried |
| Components identified | Yes, deduplicated across templates | Ported, registered, built |
| Content and media | Counted | Migrated for the homepage |
| Blueprint | Every page and component listed | Everything not on `/` marked `drop: outside demo scope` |
| Deploy | — | Preview deploy, open in Page builder |
| QA | — | One visual diff at desktop, one structural check |

### Phases

| # | Phase | Runs | Target |
| --- | --- | --- | --- |
| 0 | Slot | Claims a pre-provisioned demo slot (site, repo, editing host, Vercel project); no intake form beyond the URL | 1 min |
| 1 | Size | Sitemap read, stratified sample crawl, live-UI inventory of the sample and the homepage, **site-sizing** document with the license scope | 10–15 min |
| 2 | Scope | Solution Architect writes the Blueprint: every page and component listed, all but the homepage and its components dropped. **The DID approves it in the meeting** (one click; it's the moment the prospect sees the scope) | 3–5 min |
| 3 | Build | Components ported in parallel, renderings registered, header and footer datasources, homepage composed, homepage content and media migrated | 20–25 min |
| 4 | Show | One code deploy, homepage published to preview, visual diff at desktop, Page builder link and preview link posted by Cypher | 8–10 min |

The playbook keeps Foundation out of the meeting: the demo slot already is the foundation.

### Sizing, the commercial half: scoping the license

A new Discovery task, `size-site`, writes a `site-sizing` document:

- **Pages**: from `sitemap.xml` (and `robots.txt` sitemap entries). If there's no sitemap, the
  crawl count is marked as a floor, never a total.
- **Templates**: URL patterns clustered and confirmed against the sample's layouts.
- **Components**: distinct live-UI components across a stratified sample (every template at least
  twice, about 30 pages), with header and footer counted once.
- **Languages, forms, media**: from the sample and the crawl's `languages`, `forms`, `mediaHosts`.
- **Sites under care**: the domains, brands and language sites found (hreflang, subdomains,
  country paths), because the entity license includes five and charges per extra site.
- **Which playbooks fit**: a website for every site; a customer portal where login and account
  pages are found; consolidation where several sites share a component library.
- **Migration hours**: an estimate for the full migration, from the component and page counts.
  It's what the DID says when asked "how long?".
- **The license**: from a price list in the playbook (`pricing.yaml`: entity, included sites, extra
  sites, playbooks, Director months, founding discount). The commercial numbers live in one place
  and are versioned with the playbook.
- **Confidence**: high, medium or low, with the reason ("no sitemap", "sample hit 2 of 3
  templates"). A low-confidence site count is quoted as a range, never a single number.

Cypher posts it as a brief: "62 pages, 7 templates, 41 components, 2 languages, 4 sites. Entity
$60K and the website playbook $60K a year; the Director $45K for three months. Year 1: $165K.
The full migration: about 6 hours. Confidence high." The Workbench shows the full document.

**Calibration** is a test, not a hope. We have five real projects (Ansco, Ervin Cable, Lambert's
Cable, Star LLC, icreon). For each one with a written Blueprint, `size-site` runs against the live
site, and its component and page counts must land within 20% of that Blueprint's, missing on no
more than one.

### The demo pool

Sites can't be created by an agent, so the demo runs on a pool of pre-built slots on our tenant.
Each slot has:

- a SitecoreAI site (`demo-01` … `demo-10`) in its own collection;
- a build repo from the starter, with the editing host deployed;
- a Vercel project, already built once so caches are warm.

A **reset** task returns a slot to clean after a demo: items under the site removed, the repo
reset to the starter tag, the preview redeployed. Slots are claimed and released by the playbook,
so two demos never share one. Ten slots cover the forecast's peak of about 20 demos a month with
room to spare.

### Speed settings in the demo playbook

- `concurrency` raised for this playbook (10 sessions; one homepage won't hit tool limits).
- `canary: 0` on every `forEach` template.
- No `pilot` block.
- `deploy-code` and `publish-edge` marked `standing: true`. This is safe because the target is a
  demo slot, never a client environment.
- `escalationDeadlines` in minutes (`decision: 5m`). The DID answers live; anything unanswered
  takes Cypher's pick.
- One Lead review per component, not three. Rework that a homepage can live without becomes a
  "known gap" line in the summary, not a loop.
- A media rule: a hero video over the size limit is replaced by its poster image, and the summary
  says so.

### Orchestrator change: gates that say what they are

The one-gate trap has to be fixed in the core, not worked around:

- Add `gateRole: blueprint | acceptance` to `PhaseSpec`.
- The orchestrator stops inferring "final gate" from the last Director gate.
- `sitecoreai-migration` sets it explicitly (Gate 1 `blueprint`, Gate 2 `acceptance`), so nothing
  changes there.
- The demo playbook has one `blueprint` gate and no acceptance.

### What the DID does in the meeting

| Minute | DID | Prospect sees |
| --- | --- | --- |
| 0 | Opens New project, picks "Homepage demo", pastes their URL | Their site, read in real time on the Floor |
| 12 | Opens Cypher's sizing brief | Pages, templates, components, sites, and the license with its Year 1 total |
| 15 | Approves the scope | Their whole site in the Blueprint, everything but the homepage marked for the real build |
| 15–50 | Talks through Activity and Team | Specialists porting their components, live |
| 45 | Opens the Page builder link | Their homepage on SitecoreAI |
| 50 | Edits the hero headline, publishes to preview | A marketer's change, live, without a developer |
| 55 | Opens the license from the sizing brief | Entity, playbooks, three Director months. Signed in the room; the migration starts tomorrow |

## Milestones

| | Work | Done when |
| --- | --- | --- |
| **M0 Measure** | Run today's `sitecoreai-migration` homepage-only (the Architect drops every other page) on three sites, one with a repo, two URL-only. Record wall-clock time per phase and per wait | A timing table and the critical path named |
| **M1 Sizing** | `size-site` task and prompt, `site-sizing` document type in the Workbench, sitemap read in the browser server, `pricing.yaml`, the sizing brief with the license and Year 1 total | Calibration test passes: counts within 20% on all but one past project |
| **M2 Gate roles** | `gateRole` in the schema, orchestrator uses it, `sitecoreai-migration` and the portal playbook declare theirs | Existing tests green; a one-gate playbook adopts the Blueprint without closing the engagement |
| **M3 The playbook** | `playbooks/sitecoreai-homepage-demo/`, copied from the website playbook and cut to the phases above; Architect prompt for homepage scope; speed settings; a drift test that flags differences from the shared role and knowledge files in `sitecoreai-migration` | Loads and validates; `playbook-sdk` and `stack` coverage tests list it; it shows in New project as ready |
| **M4 Demo pool** | Ten slots provisioned, claim and release in the playbook, the reset task | A slot runs, resets and runs again with nothing left behind |
| **M5 Speed** | Tune from M0's numbers: concurrency, waits, build caching, review rules | The homepage done in 45 minutes or less on three test sites |
| **M6 The meeting** | Presentation mode for the demo (Floor, sizing card, Page builder link, the license), the DID script, a fallback for a run that overruns | Ten dry runs on varied sites: 8 of 10 inside 60 minutes, site counts right on all ten |
| **M7 Hand-off to the real build** | After signature, a new `sitecoreai-migration` project on the customer's tenant starts from the demo's inventory and Blueprint instead of crawling again | The DID starts the full migration the day after the meeting with Discovery already done |

M1 and M2 don't depend on M0 and can start now. M3 needs M2. M5 needs M0, M3 and M4.

## Risks

- **The clock.** The close depends on the homepage landing inside the meeting. If M0 shows a
  homepage takes longer than an hour, the fallback is to start the run when the meeting is booked
  and show it finishing live. M5 exists to make that unnecessary.
- **URL-only parity.** Agents can't see screenshots, so visual parity is the weakest part of a
  URL-only build. Showing one homepage keeps the gap small. Giving Visual QA image input is the real
  fix and helps every playbook.
- **Their content in our tenant.** A prospect's homepage copy and media sit on our demo slot.
  Preview is not indexed, slots are reset after each demo, and anything unsigned after 30 days is
  deleted. This needs a sentence in the meeting and in the terms.
- **Sizing credibility.** A wrong site count in the room means a wrong license. The confidence
  label and the calibration test exist for that reason; low confidence is quoted as a range, and
  the license can add sites later at the list price.
- **Playbook drift.** Without inheritance, the demo playbook copies roles and knowledge from the
  website playbook. The drift test catches divergence until the SDK gets a real `extends`.

## Open questions for the Director

1. **When does the license start:** the day it's signed, or the day the first migration starts?
2. **Pool size:** ten slots, or start with three until M6?
3. **Retention:** is 30 days right for an unsigned prospect's demo?
4. **A prospect who wants their own tenant:** do we offer it, or only after signature?
