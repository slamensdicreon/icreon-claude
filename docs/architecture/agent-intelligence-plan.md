# Smarter agents, gap content, and a stable orchestrator

_Status: proposed · 2026-10-28 · Grounded in the Ansco Associates run (SitecoreAI playbook)._

Three workstreams, each built in the method layer (`packages/`) so every playbook gets it, with
playbooks and platform packs supplying only their specifics:

- **A. Smarter, self-learning agents** that settle more among themselves and learn across projects.
- **B. Content creation agents** that fill gaps the source doesn't cover, clearly marked as generated.
- **C. A stable orchestrator** that doesn't freeze the Control API, without slowing the team.

C1 comes first: it removes the freezes the other two would otherwise hit while they're being built.

---

## What Ansco taught us

| Observation | Count | Root cause | Workstream |
| --- | --- | --- | --- |
| Identical cards in bulk (source URLs, "Access denied") | 73 + 75 | A tool gap hit every task in a batch before anyone noticed | A1 |
| Cards an agent could have answered from the Blueprint or a precedent | dozens | No answer tier between the agent and the Director | A2 |
| Agents unable to find IDs or copy another task produced | ~15 | Results live in Sitecore or in summaries, not as shared facts | A3 |
| Lead rejections for work that was right, or contradicted itself | ~10 | Reviews saw stale checks and no history | A3 (self-check), done in part |
| The same class of mistake across roles (fields read wrong, wrong item) | recurring | Nothing turns a run's mistakes into lasting knowledge | A4 |
| Placeholder copy, empty fields, Director asked to paste text | ~10 | No role may write copy the source lacks | B |
| "Control API hit an unexpected error" / "orchestrator stuck" | repeated | 18,515 history events replayed in a 10-second window after each restart | C |

---

## A. Smarter, self-learning agents

### A1. Stop mass failures early

- **Canary dispatch.** A `forEach` template's first item (configurable per template: `canary: 1`,
  `0` to turn off) runs before the rest are dispatched. If it ends in a **tool-class failure**
  (access refused, a tool error, a missing capability), the rest of the template is held and one
  card names the cause. Content-class outcomes (a real decision about this item) don't hold the batch.

  *As built:* the template's `canary` field (playbook schema, default 1, `forEach` only). Dispatch
  holds a sibling until each canary is done, cancelled, waiting on another task, or stopped on a
  `decision` card; an access, failure or rejection card holds the rest (gated by the
  `canary-dispatch` patch). The status line counts the held items. Test: `test/canary.test.ts`.
- **Card clustering.** Open cards are grouped by a signature (template, role, outcome kind and a
  normalized reason with paths, IDs and file names stripped). A group shows as one card listing its
  tasks; one answer resolves all of them. Cards keep their identity underneath for the audit trail.

  *As built:* `@lw/domain` `clusterQueue` / `cardGroups`. Open access, blocker and decision cards
  from tasks of one `forEach` template group when their options match and their title and context
  match once names, paths, URLs, IDs, numbers and quoted text are stripped. Mission Control and the
  queue show the oldest card with `group` (its siblings' tasks); answering it sends `all: true`, and
  the API answers each sibling the same way. Gates, budget, risk and deferred cards never group.
- **Capability gaps go to engineering.** A new agent outcome, `capability_gap` ("my tools can't do
  X"), records the gap in a backlog (Settings → Capability gaps, with the tasks it blocks) and parks
  the task as waiting on it. When a deploy adds the capability, the backlog item closes and its tasks
  re-queue. The Director sees one line in status, not a card per task.

  *As built:* `submit_result` status `capability_gap` with `gap.capability`. The task parks as
  waiting with no card, a `capability.gap` event fills the backlog (Settings → Capability gaps,
  keyed by the capability in lower case), and the status line counts the tasks waiting on it. A
  canary waiting on a capability holds its batch. "Added: run its tasks again" (`POST
  /projects/:id/capability-gaps/:key/close`) re-runs every waiting task, told what is now
  available; the gap closes when its last task leaves waiting. Closing on deploy, by matching a
  gap to a new tool operation, is still open.

### A2. Answer by policy before asking the Director

- **Lead triage.** `needs_decision` goes to the task's Lead first (a short, cheap model call), with
  the Blueprint entry, the charter, the role's permissions and matching precedents. The Lead answers
  when the question is settled by those, or by a default the playbook defines; otherwise it forwards
  the card unchanged. Lead answers are recorded in the Decision Log as `lead`, with the reasoning.
- **Precedents.** When the Director answers a card, the card offers "Make this a rule": a short
  condition ("source refuses a media download") and the action ("skip it and log the gap"), scoped
  to this project, the playbook or the platform. Rules are versioned, listed in Settings, and applied
  by Lead triage. Each application is recorded and can be undone.
- **Autonomy settings.** Per decision category (scope, content, naming, retries, releases), the
  Director chooses: agents decide, Lead decides, or always ask. Playbooks ship defaults. Releases and
  gates always come to the Director.

### A3. Work from shared facts, help each other, check before handing in

- **Project facts registry.** Typed facts with an owner task: `rendering:<key> → {id, componentName}`,
  `template:<key> → id`, `media:<key> → {path, ref}`, `page:<key> → path`, `datasource-location`.
  Facts are published (a) automatically from tool results by **fact extractors** the platform pack
  registers (Sitecore: `rendering.create`, `template.create`, `media.upload`, `item.create` under
  Home), and (b) explicitly with `facts.publish`. A task's brief includes the facts of the items it
  touches and of its dependencies. A changed fact (a rendering re-created) flags dependent tasks.
- **Ask a colleague.** `consult(role, question)` runs a bounded answer in the other role's context
  (its prompt, the project facts, its finished tasks' results) and returns text, recorded as a step.
  For questions like "which variant names did you register?". No writes, a token cap, and at most a
  few consults per task.
- **Self-check.** Agents may run their own acceptance checks (`acceptance.check`) before submitting,
  the same checks the Lead's review runs. Fewer rejections, and reviews spend effort on judgment.
  (Done already: reviews know checks are current, see their earlier verdicts and the role's permissions.)

### A4. Learn across projects: a knowledge service, not a reference file

A **knowledge store** in the database, versioned, with entries of three kinds:

| Kind | Example | Used by |
| --- | --- | --- |
| Lesson | Insert options go on `__Standard Values`, not the template item | Every role it applies to |
| Procedure | Creating a headless variant: the steps that worked, as a recipe | The role that does that work |
| Rule | Source refuses a download → skip and log the gap | Lead triage (A2) |

- **Scopes**: `global`, `platform:<id>`, `playbook:<id>`, `role:<playbook>/<role>`, `project:<id>`.
  A SitecoreAI lesson helps every SitecoreAI playbook; a method lesson helps every playbook.
- **Retrieval, not dumping.** Each entry carries applicability: roles, tool operations, templates
  and tags, plus a text embedding. A task's brief gets the few most relevant entries (by its role, the
  operations it's granted, its template, and similarity to its title and Blueprint entry), with a
  token budget. Today's Markdown knowledge files are imported as seed entries.
- **Where entries come from:**
  - **Retrospectives.** At each phase exit, Cypher reads the phase's cards, rejections, send-backs,
    waits, failed checks and capability gaps, groups them by cause, and proposes entries with their
    evidence (count, tasks, time lost) on a "Lessons learned" Workbench page. The Director approves,
    edits or rejects each. Proposals needing code or permissions are filed as capability gaps instead.
  - **Procedure capture.** A task that succeeded after struggling (two or more attempts, or a send-back)
    gets its working steps summarized into a proposed procedure for its role.
  - **Precedents** (A2) become rules.
- **Effectiveness.** For each entry: how often it was injected, and how often the problem it
  prevents recurred anyway. Entries that don't help are flagged for review; superseded ones retire.

### A5. Measure it

- **Scorecard** per project and phase: Director interventions per task, cards answered by Lead or
  rule, Lead rejection rate, recurrence of known problems, cost per task, time to done. On Mission
  Control, and compared across projects of the same playbook.
- **Replay scenarios.** Recorded runs (Ansco first) become regression scenarios: the simulator replays
  a run's tool results so a change that would bring back an old failure is caught in CI.

---

## B. Content creation agents

The migrator keeps one rule: **migrated copy is word for word, never invented.** Generation is a
separate, visible, approved step.

- **Gap register.** The content migrator records each field it leaves empty because no source has
  it (`content-gap` facts: item, field, page, why). The parity audit adds gaps it finds.
- **Content Writer role** (a method-level role definition playbooks include): phase 6, after a page is
  migrated, one task per page with gaps (`fill-gaps-{key}`). It writes only into gap fields, in the
  site's voice (learned from the source pages), within each field's length, and never invents facts:
  names, numbers, prices, addresses, dates, legal text, quotes, claims. Those stay empty and are
  listed for the Director.
- **Marking.** Every datasource item the writer creates or fills is **named with an `-ai` suffix**
  (`Hero-ai`), and its fields are listed in a **Generated content register** (a Workbench page: item,
  field, the text, the source pages it drew its tone from). The register is the source of truth for
  what is generated; the suffix makes it visible in the Content Editor and Page builder.
- **Approval.** Generated content needs the Director's approval before publishing: one card per
  phase, "Approve 23 generated fields", linking to the register, with per-item reject. The publish
  step skips unapproved `-ai` items. Approving renames nothing; a rejected item's fields are cleared
  and logged as gaps.
- **Images, later.** The same pattern with an image provider: generated media named with `-ai`,
  listed in the register, approved before use. Never logos, people or real places. Needs a provider
  and an account (a decision below).

---

## C. A stable orchestrator

**Why it freezes.** Every state change the project workflow records (a task move, a card, a decision)
is a separate activity call: about 6 history events each, so one re-run costs about 36. Ansco's
workflow holds 18,515 events. The Temporal worker runs inside the API container; each deploy, and each
wake from idle, restarts it, and the next step must replay the whole history within Temporal's
10-second workflow-task timeout. When it can't, every command fails until a retry fits.

1. **C1. Fewer, cheaper events (first).**
   - Record state changes with a **local activity** (one marker event, no extra round trip) instead of
     a full activity.
   - **One write per workflow step:** changes made during a step are buffered and written once.
   - Together: a re-run from ~36 events to ~4. Faster for the team too: fewer round trips per action.
   - *As built:* not shipped. With local activities, a Director command's completion and a task
     start that it releases can land in either order, and the replay test caught the resulting
     nondeterminism. C2 bounds the history instead; batching writes stays open.
2. **C2. Bounded history.** *Built.*
   - Past 4,000 events (`policy.continueAsNewAt`), or when Temporal suggests it, the project
     workflow starts no new agent sessions. It waits until nothing is in flight: no session running,
     no undo or directive window open, no card default or Director command mid-way. Then it
     **continues as new**.
   - It hands the next run a **snapshot** of its state: plan, Blueprint, task states, attempts,
     waits, re-run marks, gates, holds, spend and open cards. Cards carry what answering them does
     as data, so an open card keeps its deadline and its effect across runs. The event log is not
     re-read; it stays the Director's record.
   - Running projects switch over safely: a run started on earlier code replays unchanged, and from
     its next live step continues as new into the new code (gated by the `continue-as-new` patch).
   - Projects start, and new runs continue, with a **60-second** workflow-task timeout. A run that
     started before this keeps its 10 seconds until it hands over.
   - `test/replay` keeps histories recorded on the earlier code and replays them in CI, along with
     a project that switches code mid-run and hands over on the way (the start of C5).
3. **C3. A worker that stays up.**
   - Run the Temporal worker as its own always-on service, separate from the API, so API deploys and
     idle sleeps don't touch orchestration.
   - Deploy the worker only when orchestrator code changes.
   - On start, pre-warm active projects (replay them before anyone acts).
4. **C4. Commands that never fail for the Director.**
   - When the workflow is catching up, the API accepts a command into the existing Postgres command
     bus and answers "queued", and the worker applies it when ready.
   - The app shows "Orchestrator catching up" instead of an error.
   - Read paths already serve from projections and never wait on Temporal.
5. **C5. Safe deploys.**
   - CI replays recorded production histories against new workflow code (Temporal's replayer) and
     fails on nondeterminism.
   - Deploys are batched.
   - The diagnostics endpoint (built) becomes Settings → Orchestrator health, with an alert card if a
     workflow task keeps failing.

---

## Order of work

| # | Build | Why first | Size |
| --- | --- | --- | --- |
| 1 | C1 local activities and batched writes, C2 continue-as-new from the event log, 60 s timeout | Stops the freezes; everything else adds events | 2–3 sessions |
| 2 | A1 canary, clustering, capability gaps | Biggest cut in Director cards for the least work | 1–2 sessions |
| 3 | A2 Lead triage, precedents, autonomy settings | Second biggest cut in cards | 2 sessions |
| 4 | C3 separate worker, C4 queued commands, C5 replay in CI | Removes the remaining freeze paths | 2 sessions + hosting decision |
| 5 | A3 facts registry, consult, self-check | Fewer waits and rejections | 2–3 sessions |
| 6 | B gap register, Content Writer, `-ai` marking, approval | Fills gaps visibly | 2 sessions |
| 7 | A4 knowledge service, retrospectives, procedures; A5 scorecard and replays | Learning across projects | 3–4 sessions |

Each step ships with tests and is deployed once, at a time the Director picks, with running projects
upgraded in place.

## Scaling across playbooks

| Piece | Method layer (all playbooks) | Platform pack | Playbook |
| --- | --- | --- | --- |
| Canary, clustering, capability gaps | Orchestrator, Control Center | — | `canary` per template |
| Lead triage, precedents, autonomy | Orchestrator, agent runtime | — | Autonomy defaults, decision categories |
| Facts registry | Store, briefs, `facts.publish` | Fact extractors for its tools | Fact kinds its templates publish |
| Consult, self-check | Agent runtime, gateway | — | Which roles may consult which |
| Knowledge service | Store, retrieval, retrospectives | Seed lessons (SitecoreAI pitfalls) | Seed lessons, role procedures |
| Content Writer, `-ai`, register, approval | Role definition, approval, publish filter | How to name and find items | Where gaps arise, voice sources |
| Orchestrator stability | Orchestrator, worker, API | — | — |

## Decisions needed

1. **Worker hosting (C3).** Keep the worker in the API container (simplest, freezes on deploys and
   idle until C1/C2 land), or run it as an always-on service: a Vercel container with a minimum of
   one instance if available, or a small host elsewhere (Fly.io, Render, AWS).
2. **Autonomy defaults (A2).** What agents and Leads may decide without the Director, per category.
3. **The `-ai` marker (B).** An item-name suffix (`Hero-ai`) as proposed, or a display-name or field
   marker, which keeps item paths clean.
4. **Image generation (B).** Whether to add it, and which provider and account.
