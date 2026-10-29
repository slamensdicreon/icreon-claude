# Task plan: everything left in the agent intelligence build plan

The working task list for [the build plan](agent-intelligence-build-plan.md): every remaining step
broken into tasks with the files they touch, the tests that prove them, and what "done" means.
Written 2026-10-29, after P1–P3 (Dashboard, connections and remix, Cypher at the top) and no-repo
mode were built.

## How every task is done

A task is done when all of these hold. They are not repeated below.

1. **Tests first where the behaviour is new:** unit tests in the package, plus a workflow replay or
   simulator test when the orchestrator changes.
2. **Running projects upgrade in place:** every workflow change is behind a `patched('<name>')`
   gate, and the replay tests (`packages/orchestrator/test/replay`) pass on recorded histories.
3. **All suites green:** `turbo run typecheck`, `turbo run test`, `prettier --check`.
4. **Deployed at a quiet moment:** no task running on any live project (a deploy restarts the
   worker), then checked in production through the API and a Playwright screenshot of any UI at
   desktop and phone widths.
5. **Docs updated:** the build plan marks the step built with as-built notes; prompts and
   known-pitfalls change with the behaviour they describe.

Sizes are in working sessions. Each milestone ends with a deploy and a short report.

## Milestones at a glance

| # | Milestone | Size | Needs first | Ships |
| --- | --- | --- | --- | --- |
| M0 | Leftovers and Ansco close-out | ½ | — | No-repo polish; Ansco accepted |
| M1 | Scorecard (A5) | 1 | M0 | Ansco's baseline numbers; a Scorecard page |
| M2 | Lead triage and autonomy (A2a) | 2 | M1 | Leads answer most questions; Autonomy settings |
| M3 | Rules from answers (A2b) | 1½ | M2 | Rules table, "Make this a rule", Ansco's rules harvested |
| M4 | **Second site** (no-repo, remix of Ansco) | runs alongside | M3 | Real comparison against Ansco on the scorecard |
| M5 | Project facts and self-check (A3) | 2 | M2 | No more "which ID?"; fewer rejections |
| M6 | Knowledge store and retrospectives (A4) | 2½ | M3, M5 | Lessons that carry across projects |
| M7 | Page builder automation (capability gap) | 2 + a decision | — | Agents prove editing in Pages themselves |
| M8 | Cypher depth | 1 | M1, M6 | Cypher reads project history; handoff into a project |

Total: about 12½ sessions. M5 and M7 can run in parallel with M3/M4 if wanted; M6 needs the rules
table from M3 and the facts from M5.

---

## M0 — Leftovers and Ansco close-out (½ session)

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M0.1 | Hide the `codeExtraction` brief question when a project has no repository: brief questions take `when:`/`unless:` like templates | `playbook-sdk/src/schema.ts`, `contracts/src/playbooks.ts`, `NewProject.tsx`, `intake.ts` (`briefOf`) | Intake test: no repo → not asked, not required |
| M0.2 | Head Integrator prompt: a no-repo project's components came from the live site's markup; integration is unchanged | `prompts/head-integrator.md` | Review |
| M0.3 | Build plan table: mark step 0 (P1, P2) and P3 built | build plan doc | — |
| M0.4 | **Director:** accept Ansco (Gate 2); the handover pack runs; check it lands | Mission Control | Project status `completed`; handover pack artifact |

## M1 — Scorecard (A5) (1 session)

Measures everything after it, so it comes first. Pure, from events, so Ansco's whole history gives
its baseline at once.

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M1.1 | `Scorecard` contract: per project, per phase and per task type: cards raised (by category), settled by whom (Director, Chief of Staff, default, later Lead and rule), Lead rejection rate, repeat clusters, waits, send-backs, capability gaps, cost and time | `contracts/src/snapshots.ts` | Schema test |
| M1.2 | Card category: a pure `categoryOf(escalation)` from its kind, reason and cluster key (A1's `problemOf`), with the build plan's categories (retries, naming, content, tool workarounds, access, scope, gates/budget) | `domain/src/categories.ts` | Table test over Ansco's 347 cards: every card gets a category; counts match the build plan's table within a few |
| M1.3 | `scorecard(state)` projection | `domain/src/scorecard.ts`, projector fields it needs (review counts, decision `decidedBy`) | Unit tests; Ansco history fixture gives the published numbers (347 cards, 94% recommended taken) |
| M1.4 | `GET /projects/:id/scorecard`, `GET /playbooks/:id/scorecard` (projects of that playbook side by side) | `control-api/src/app.ts`, `vercel.json`, `vite.config.ts` | API tests |
| M1.5 | UI: a Mission Control tile (cards per task, % settled without the Director); a **Scorecard** page in the project nav; a comparison table on the Dashboard's Playbooks tab | `web/src/surfaces/Scorecard.tsx`, `Mission.tsx`, `Dashboard.tsx` | Screenshots |
| M1.6 | Record Ansco's baseline in the build plan | docs | — |

## M2 — Lead triage and autonomy (A2a) (2 sessions)

The biggest cut in cards. Ships in **shadow mode** first: the Lead decides and the decision is
recorded, but the card is still raised, so its answers can be compared with the Director's before
anything is trusted to it.

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M2.1 | Contracts: `decidedBy` gains `lead` and `rule`; `DecisionCategory` enum (shared with M1.2); `autonomy` setting per category: `agents`, `lead`, `shadow`, `ask`; escalations carry their category | `contracts/src/events.ts`, `commands.ts`, `snapshots.ts` | Schema and projector tests; old events still parse |
| M2.2 | Playbook `autonomy:` defaults (the build plan's table; gates, releases and budget locked to `ask`) | `playbook-sdk/src/schema.ts`, `playbooks/sitecoreai-migration/playbook.yaml` | Playbook test: locked rows can't be loosened |
| M2.3 | `triage()` in the agent runtime: the Lead's model, low effort, structured output (`answer` with option, category, reasoning and rules cited, or `forward` with a reason); its input is the question, options, recommendation, agent summary, Blueprint entry, charter, role tools and scopes, the task's earlier answers, and matching rules (empty until M3) | `agent-runtime/src/triage.ts` (beside `review.ts`) | Tests with a fake client: answers only from given options; forwards on scope or access |
| M2.4 | Orchestrator: triage before `raise()` on `needs_decision`, "rejected 3 times" and unresolvable waits; never for gates, releases, budget, scope or missing credentials; at most two Lead answers in a row per task, then the card goes to the Director with both attached; `patched('lead-triage')`; shadow raises the card and records the Lead's answer on it | `orchestrator/src/workflows/project.ts`, `activities.ts`, `stub-activities.ts` | Workflow tests per path; loop limit; replay of Ansco's history unchanged |
| M2.5 | Stack wiring: live projects use the Lead's model; stub projects forward | `stack/src/compose.ts` | Stack live test |
| M2.6 | UI: Settings → **Autonomy** (replaces Escalation policy); Decision Log filter by who decided, with **Override** (re-runs the task with the Director's answer); a card in shadow shows "Lead would answer: …"; Mission Control line "The Leads settled N questions today" | `Settings.tsx`, `Inbox.tsx`, `parts/Card.tsx`, `Mission.tsx` | Screenshots; override test |
| M2.7 | Simulator scenario: a project where the Lead settles retries and naming, forwards scope | `simulator` | Scenario test |
| M2.8 | Deploy in shadow for the next live project; after about 30 shadowed cards, compare agreement with the Director on the scorecard; switch categories to `lead` where agreement is high | Settings | Scorecard shows agreement % per category |

## M3 — Rules from the Director's answers (A2b) (1½ sessions)

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M3.1 | Migration `005_knowledge.sql`: `lw_rules` (condition, action, scope: project, playbook or platform, category, source cards, version, author, retired-at, applied and overridden counts) | `events/migrations`, `events/src/rules.ts` (Postgres + memory stores) | Store tests on PGlite |
| M3.2 | API: list, create, edit (new version), retire; applications per rule | `control-api/src/rules.ts`, `app.ts` | API tests |
| M3.3 | **Make this a rule** on an answered card: Cypher drafts condition and action from the card and the answer; the Director edits and picks the scope | `control-api` (model call like `cypher.ts`), `parts/Card.tsx` | Test with scripted model; nothing applies until saved |
| M3.4 | Triage uses rules: match by scope, role, category and words in the question; the Lead cites the rule; `decidedBy: 'rule'` when a rule settles it; counts applied and overridden; a rule overridden twice is flagged | `agent-runtime/src/triage.ts`, orchestrator | Tests: matching, citing, flagging |
| M3.5 | Settings → **Rules**: list, edit, retire, see each application | `web/src/surfaces/Settings.tsx` (or its own page) | Screenshots |
| M3.6 | **Harvest Ansco:** group Ansco's answered cards by cause (M1.2 categories, A1 clusters) and have Cypher propose a rule per group with its evidence; the Director approves each | a one-off script plus the Rules page's "Proposed" list | Proposals listed; none active until approved |
| M3.7 | Deploy; Director reviews the harvested rules | — | Rules active in production |

## M4 — Second site (alongside M3–M5)

The build plan's "next site after rules". A no-repo remix of Ansco on the Brands tenant.

| Task | What | Proof |
| --- | --- | --- |
| M4.1 | Ask Cypher for the remix; review and create in the wizard (connection reused, no repository) | Project in intake with 5 reused credentials |
| M4.2 | Start it; watch the live-site inventory (`inventory-live-ui`) and the Blueprint gate closely; fix prompt or tool problems as they show | Blueprint approved at Gate 1 |
| M4.3 | Run with triage in shadow (M2.8), rules active (M3) | Scorecard against Ansco after each phase |
| M4.4 | Feed what it teaches into M5 and M6 (facts it kept asking for, lessons) | Notes in the build plan |

## M5 — Project facts and self-check (A3) (2 sessions)

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M5.1 | `fact.published` event and a facts projection: typed facts (`rendering:<component>`, `template:<key>`, `media:<key>`, `page:<route>`, `datasource-location:<component>`, `variant:<component>/<name>`) with the task that owns each and their history | `contracts/src/events.ts`, `domain` | Projector tests |
| M5.2 | `facts` tool server, in-process like the blackboard: `facts.read` by kind or key, `facts.publish` | `stack/src/compose.ts`, a new `facts` server | Gateway authorization matrix covers it |
| M5.3 | Extractors the platform pack registers on tool results (Sitecore `rendering.create`, `template.create`, `media.upload`, `item.create` under Home) publish facts automatically | `platforms/sitecoreai`, the gateway's result hook | Tests on recorded tool results |
| M5.4 | Briefs list the facts of the task's items and dependencies; a changed fact (a rendering re-created) flags the tasks that used it | `agent-runtime/src/context.ts`, orchestrator | Tests; flagged tasks show on Mission Control |
| M5.5 | `acceptance.check`: an agent runs its task's acceptance checks before submitting | `stack/src/review.ts` exposed as a tool; role grants | Test: a failing check is seen and fixed before review |
| M5.6 | Prompts: read facts before asking; publish what you create; self-check before submitting | prompts, `known-pitfalls.md` | Review |
| M5.7 | Deploy; scorecard shows the change in rejections and "which ID?" waits | — | Scorecard |

## M6 — Knowledge store and retrospectives (A4) (2½ sessions)

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M6.1 | `lw_knowledge` (lessons, procedures, rules as one store; rules from M3 move in or are joined): scope (global, platform, playbook, role, project), applies-to (roles, operations, templates, tags), evidence, version, status; Postgres full-text index | migration `006`, `events/src/knowledge.ts` | Store and search tests on PGlite |
| M6.2 | Seed from `known-pitfalls.md` and the lessons in role prompts; the Markdown becomes an export | a seed script | Every pitfall row present once |
| M6.3 | Retrieval into briefs: the few most relevant entries for the role, granted operations, template and title, within a token budget | `agent-runtime/src/context.ts` | Tests: relevant entries in, budget respected |
| M6.4 | **Retrospective at phase exit:** Cypher groups the phase's cards, rejections, send-backs, waits, failed checks and gaps by cause and proposes entries with evidence on a "Lessons learned" Workbench page; the Director approves, edits or rejects; ones needing code become capability gaps | orchestrator phase exit, `control-api`, `Workbench.tsx` | Test with scripted model; nothing active until approved |
| M6.5 | Procedure capture: a task that succeeded after two or more attempts gets its working steps proposed as a procedure for its role | agent runtime, orchestrator | Test |
| M6.6 | Effectiveness: how often each entry was injected, and whether its problem came back (scorecard clusters); unhelpful entries flagged | `domain/src/scorecard.ts`, knowledge page | Tests |
| M6.7 | Knowledge page: browse, search, edit, retire | `web` | Screenshots |
| M6.8 | Deploy; run a retrospective on the second site's finished phases | — | Approved lessons in production |

## M7 — Page builder automation (2 sessions, plus a decision)

Four tasks per project need an agent working in SitecoreAI Pages as an editor (`prove-pilot-slice`,
`smoke-test`, `editor-checklist`, `prove-personalization`). Today the Director does them by hand.

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M7.0 | **Decision (Director):** how the agent signs in to Pages: a dedicated service user in the Sitecore organization (recommended), its credential kept in the vault like the others | — | Decision recorded |
| M7.1 | Signed-in browser sessions in the browser tool server: sign in once per project, reuse the session, never log the credential | `tool-servers/browser` | Test against a fixture login |
| M7.2 | Ops `page-builder.open`, `.add-component`, `.edit-field`, `.save`, `.publish`, and `video.record` | `tool-servers/browser` | Tests on a fixture editor; one run against the Brands tenant |
| M7.3 | Grant to the roles; `uses:` on the four templates; close their capability gaps so waiting tasks re-run | playbook, Settings → capability gaps | The four tasks run live on the second site |

## M8 — Cypher depth (1 session)

| Task | What | Where | Proof |
| --- | --- | --- | --- |
| M8.1 | `project_history` tool: the Decision Log, activity search and the scorecard for one project | `control-api/src/cypher.ts` | Scripted-model test |
| M8.2 | Handoff: a project created from a Cypher draft starts its own conversation with the brief and the reasoning from the Dashboard | `NewProject.tsx`, `intake.ts` | Test: first project message carries the brief |
| M8.3 | Cypher can propose rules and lessons from the Dashboard (uses M3 and M6) | `cypher.ts` | Test |

---

## Open decisions

| Decision | Recommendation | Needed by |
| --- | --- | --- |
| How the Pages agent signs in (M7.0) | A dedicated service user, vaulted | M7 |
| How long shadow mode runs before the Lead decides for real (M2.8) | About 30 shadowed cards per category, then switch where agreement is 90% or more | M2.8 |
| When the second site starts (M4) | After M3 deploys, as the build plan decided | M4 |
| Where the Scorecard lives (M1.5) | Its own page in the project nav, plus the Dashboard comparison | M1.5 |

## Risks and how the plan handles them

- **Workflow changes break running projects:** `patched()` gates and replay tests on recorded
  histories, every time (rule 2).
- **The Lead answers wrongly:** shadow mode first, agreement measured; Override always available;
  gates, releases, budget and scope are never triaged.
- **Rules or lessons go stale:** versions, applied and overridden counts, flags, retire.
- **Deploys restart the worker mid-task:** deploy only when no task is running (rule 4).
- **Model cost:** triage and Cypher use low or medium effort and small inputs; the scorecard shows
  the cost per task.
