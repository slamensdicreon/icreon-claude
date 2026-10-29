# Build plan: Lead triage, rules, autonomy, facts, knowledge, scorecard

The detailed build plan for A2–A5 of [the agent intelligence plan](agent-intelligence-plan.md),
sized against what Ansco actually asked the Director. A1 (canary, card clustering, capability
gaps) is built.

## What Ansco tells us

Ansco raised **347 cards** (to 2026-10-28):

| | Cards | Note |
| --- | --- | --- |
| Media Migrator (source URLs, refused downloads) | 232 | One cause repeated per file. A1's canary and clustering now make this a handful |
| Tool problems (sandbox, 409s, Deploy API) | 30 | Capability gaps (A1) or tool fixes |
| "Lead rejected 3 times: retry or accept?" | 24 | Fewer with self-check (A3); the Lead can settle most (A2) |
| Who owns it / work missing | 20 | Ownership now in the prompts; facts (A3) end "which ID?" questions |
| Access and scope | 19 | Mostly permissions we then granted: rules (A2) |
| Real content or design choices | 18 | The cards that should reach the Director |
| Gates and budget | 6 | Always the Director |

- **The Director took the agent's recommended option 94% of the time** (320 of 340 answered).
- **92 cards were settled by their default** after their window ran out: nobody needed to look.
- Outside the media batch, the Director still took the recommendation 81% of the time (90 of 111).

So most questions already have a right answer the agent can see. Something with more context and
authority than the agent, the Lead or a rule, should give that answer and leave the Director the
choices that are really theirs. Estimate for a project like Ansco: **from ~350 cards to 30–60**
with A1 and A2 together. The scorecard (step 1) measures it, so we don't guess.

## Order

| Step | Build | Size | Why here |
| --- | --- | --- | --- |
| 1 | **A5 Scorecard**, computed from the event log, Ansco as the baseline | 1 session | Every later step claims fewer cards or rejections; this proves it |
| 2 | **No-repo mode**: start from the public website alone, no source repository | 1–1½ sessions | Some projects arrive with only the live site; today they can't start |
| 3 | **A2a Lead triage + autonomy settings** (+ the rules table) | 1½ sessions | Biggest cut left in cards |
| 4 | **A2b Rules from answers** ("Make this a rule", Settings → Rules, harvest Ansco's answers) | 1 session | Makes triage smarter every time the Director answers |
| 5 | **A3 Project facts** (+ self-check before submitting) | 2 sessions | Ends "which ID?" waits and many rejections |
| 6 | **A4 Knowledge store** (lessons, procedures, rules; retrospectives) | 2–3 sessions | Learning across projects; replaces the static pitfalls file |

The next site can start after step 4, with or without a repository: the scorecard then compares it with Ansco on A1 + A2, and its
cards feed A3 and A4. Each step ships with tests, is gated with `patched()` so running projects
upgrade in place, and deploys at a quiet moment (a deploy restarts the worker).

---

## Step 1 — Scorecard (A5)

**What it shows**, per project and per phase, and compared across projects of the same playbook:

| Measure | From |
| --- | --- |
| Director cards per task, by type | `escalation.raised` |
| Who settled them: Director, Lead, rule, default | `decision.recorded` (`decidedBy`) |
| Lead rejection rate | `review.recorded` (rejects ÷ reviews) |
| Repeat problems: the same card cluster again after a rule or lesson covers it | cluster key (A1) |
| Waits, send-backs and capability gaps per task | `task.state`, `capability.gap` |
| Cost and time per task | `budget.updated`, `step.recorded`, task start/end |

**Build:** a `scorecard` projection in `@lw/domain` (pure, from events, so Ansco's history gives
its baseline at once). `GET /projects/:id/scorecard` and `GET /playbooks/:id/scorecard`
(projects side by side). A tile on Mission Control (cards per task, % settled without the
Director); a Scorecard page under Reports.

## Step 2 — No-repo mode

Some projects start with only the public website: no source repository. Crawling, copy, media and
every audit already work from the live site (since Ansco, the live site is the reference anyway).
What doesn't:

- **Intake** requires a repository (`source.repo: required` in the SitecoreAI playbook).
- **`inventory-repo`** runs on GitHub tools, and the Blueprint expects its `repo-inventory`.
- **Building** the design system and components means porting source code: markup and CSS. From the
  live site the browser tool gives text, headings, images and screenshots, but not a section's
  markup or its styles, so builders would guess the design from pictures (Ansco's first visual
  pass shows how that goes).

**Build:**

- **Intake:** `source.repo: optional`. A repository, when given, sets the project feature
  `source-repo`; the wizard says what the agents will work from in each case.
- **Plan:** `inventory-repo` gets `when: source-repo`. Templates gain `unless:` (the opposite of
  `when`), and a new `inventory-live-ui` (`unless: source-repo`) takes its place: the components a
  visitor sees, found as sections repeated across pages, with their variants, and the design tokens
  (type scale, colours, spacing, breakpoints) from computed styles. It writes the same
  `repo-inventory` shape the Blueprint reads, marked `source: live-site`.
- **Browser tools:**
  - `page.markup`: the cleaned HTML of a section (by selector or by its place in the snapshot),
    with class names kept and scripts and tracking stripped, size-capped.
  - `page.styles`: the page's stylesheet URLs and text (same host), and computed styles for chosen
    selectors (fonts, sizes, weights, colours, spacing, borders, and the breakpoints that change
    them).
- **Prompts:** the Content Analyst, Solution Architect, Component Engineer (design system and port
  tasks) and Head Integrator each say what to do without a repository: rebuild each component from
  the live page's markup and styles, keep class names where they carry the design, and prove it
  with `parity.visual`. The `codeExtraction` brief question doesn't apply and is hidden.
- **Test:** a project created from just a URL runs phases 1–2 to an approved Blueprint in the
  simulator; a stack test drives `page.markup` and `page.styles` against a local fixture site.

## Step 3 — Lead triage and autonomy (A2a)

**Flow.** When an agent ends with `needs_decision` (and for "rejected 3 times: retry or accept?"
and "what it needs is missing" cards), the workflow first runs a **triage** activity instead of
raising a card:

```
triage({ task, question, options, recommended, summary, attempt })
  → { answer: optionId, category, reasoning, ruleIds[] }   // the task retries with it, no card
  | { forward: reason, category }                           // the card goes to the Director as today
```

- **Who answers:** the task's Lead (its model, low effort, structured output). It sees the question
  and options, the agent's summary, the task's Blueprint entry, the outcome charter, the role's
  tools and scopes, the task's earlier answers, and the rules that match (step 4).
- **When it may answer:** the category's autonomy setting allows it, and the answer follows from
  the Blueprint, the charter, a rule, or a playbook default. Otherwise it forwards, saying why.
- **Never triaged:** gates, releases, budget, scope changes (adding or dropping pages or
  components), and access that needs a credential the team doesn't hold.
- **No loops:** at most two Lead answers in a row on one task; the third question goes to the
  Director with the Lead's two answers attached.
- **Recorded:** `decision.recorded` with `decidedBy: 'lead'` (or `'rule'`), the reasoning and the
  rules cited. The Decision Log shows them; **Override** re-runs the task with the Director's
  answer (the existing re-run). Mission Control shows one line: "The Leads settled 14 questions
  today".

**Autonomy settings** (Settings → Autonomy, replacing the escalation policy table). One row per
decision category, three levels: **Agents decide** (the agent proceeds with its recommendation,
logged), **Lead decides** (triage), **Always ask**.

| Category | Example from Ansco | Proposed default |
| --- | --- | --- |
| Retries | "Rejected 3 times: retry with the Lead's feedback?" | Lead decides |
| Naming and structure | Variant names, where an item goes | Lead decides |
| Content within the Blueprint | Which variant matches a section | Lead decides |
| Tool workarounds | Stale sandbox, 409 on standard values | Lead decides; else a capability gap |
| Access and permissions | Widen a read scope | Always ask (a rule can settle known ones) |
| Scope | Drop a component, add a page | Always ask |
| Releases, gates, budget | Deploy, publish, budget limit | Always ask (locked) |

The playbook ships the defaults (`autonomy:` in `playbook.yaml`); a project can override them.

**Build:**
- Contracts: `decidedBy` gains `lead` and `rule`; a `DecisionCategory` enum; `autonomy` setting.
- Agent runtime: `triage()` beside `reviewTask()` (same client and structured-output pattern).
- Orchestrator: the triage activity before `raise()` in the `needs_decision`, rejected and
  unresolvable-wait paths (patched `lead-triage`); a counter per task for the two-answer limit.
- Domain and web: Decision Log filter by who decided, Override, the Autonomy panel.

## Step 4 — Rules from the Director's answers (A2b)

- **Make this a rule.** On an answered card: Cypher drafts a rule from the card and the answer
  (*when* "the source refuses a media download", *do* "skip it and log the gap"). The Director edits
  it and picks a scope: **this project**, **this playbook**, or **this platform**.
- **Stored** in Postgres (`lw_rules`, the first table of A4's knowledge store): condition, action,
  scope, category, the cards it came from, version, author, retired-at, and how often it was
  applied and overridden.
- **Applied by triage:** rules matching the scope, role and category (and words in the question)
  go to the Lead, who cites the rule it used. A rule that keeps being overridden is flagged.
- **Settings → Rules:** list, edit (new version), retire, see each application.
- **Harvest Ansco:** Cypher groups Ansco's 340 answered cards by cause and proposes rules (for
  example "a refused source download: skip and log the gap"; "a stale sandbox: clean it up and
  retry"). The Director approves each before it applies anywhere.

## Step 5 — Project facts (A3)

**Why:** agents re-discover IDs (rendering IDs, template IDs, media paths, page paths), ask each
other through waits, or guess. Ansco's ownership and "still missing" cards come from this.

- **Facts:** typed, with the task that owns them. `rendering:<component> → {id, path,
  componentName}`, `template:<key> → {id}`, `media:<key> → {path, id}`, `page:<route> → {path, id}`,
  `datasource-location:<component>`, `variant:<component>/<name> → {id}`.
- **Published automatically** by fact extractors the platform pack registers on tool results
  (Sitecore: `rendering.create`, `template.create`, `media.upload`, `item.create` under Home), and
  explicitly with `facts.publish`.
- **Read:** a task's brief lists the facts of its items and dependencies; `facts.read` answers by
  kind or key. A changed fact (a rendering re-created) flags the tasks that used it.
- **Self-check** (same block): `acceptance.check` lets an agent run its task's acceptance checks
  before submitting, so the Lead's review spends its effort on judgment.
- **Build:** `fact.published` event and projection, a `facts` tool server (in-process, like
  blackboard), extractors in `platforms/sitecoreai`, brief changes in the agent runtime.

## Step 6 — Knowledge store (A4)

- **One store, three kinds:** lessons ("insert options go on `__Standard Values`"), procedures (the
  steps that worked for creating a headless variant), rules (step 4). Scopes: global, platform,
  playbook, role, project. Each entry: what it applies to (roles, tool operations, templates, tags),
  its evidence, a version and status.
- **Retrieval, not dumping:** a task's brief gets the few most relevant entries for its role,
  granted operations, template and title, within a token budget. First version: Postgres full-text
  search plus those filters (no new vendor). Embeddings can come later if search misses.
- **Seeded** from `known-pitfalls.md` and the lessons in role prompts; the Markdown stays as an
  export.
- **Retrospective at each phase exit:** Cypher groups the phase's cards, rejections, send-backs,
  waits, failed checks and capability gaps by cause and proposes entries with their evidence (count,
  tasks, time lost) on a "Lessons learned" Workbench page. The Director approves, edits or rejects
  each. Proposals that need code or permissions become capability gaps instead.
- **Procedure capture:** a task that succeeded after two or more attempts, or a send-back, gets its
  working steps summarized into a proposed procedure for its role.
- **Effectiveness:** how often each entry was injected, and whether the problem it prevents came
  back (scorecard). Entries that don't help are flagged; superseded ones retire.

## Capability gap to schedule: Page builder automation

Every project has four tasks that need an agent to work in Page builder as an editor:
`prove-pilot-slice`, `smoke-test`, `editor-checklist` and, with personalization,
`prove-personalization`. No tool does that yet (`browser.page-builder.drive`, `browser.video.record`),
so on Ansco the Director did them by hand. Building it means signing in to SitecoreAI Pages in the
browser tool server with a service identity, then scripted actions: open a page, add a component,
edit inline, save, publish, record. Size: 2 sessions, plus deciding how the agent signs in. Until
then, these cards ask the Director to check by hand and mark the task done.

## Decided (2026-10-29)

1. **Order:** scorecard first, then no-repo mode, Lead triage and autonomy, rules, facts, knowledge.
2. **Autonomy defaults:** the table in step 3 (the Lead decides retries, naming, content within the
   Blueprint and tool workarounds; access and scope ask; releases, gates and budget are locked).
3. **Rule scope default:** this playbook.
4. **Next site:** after rules (step 4), with or without a repository.
5. **Knowledge search:** Postgres full-text first; embeddings only if it misses.
