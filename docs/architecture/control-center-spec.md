# Cypher Control Center: from prototype to system

The interactive prototype ("Cypher Control Center", artifact `MTMcAyYAJXnp8siunR8a1L`) is the
specification for the operator experience. This document maps every surface, interaction and data
shape in it to what the system has to provide: contracts, events, endpoints, orchestrator behaviour
and the web app. Where the prototype hard-codes something, this says where the real value comes
from. Nothing in the prototype is cut to fit what the backend already did.

Status key: **have** (built), **extend** (built, needs more), **new**.

## 0. Product decisions the prototype makes

| Decision | Consequence |
|---|---|
| The product is **Cypher**; the Chief of Staff's persona is also Cypher | Role id stays `chief-of-staff`; display name and persona come from the playbook (`persona: Cypher`) |
| Every agent has a **person name** (Emily Chen, Component Engineer) | `persona` on each playbook role; shown everywhere a role name was; `whoize` (role names in prose become first names with a hover title) is a client formatter over the roster |
| Projects are **repository sources** as often as live sites (Vite SPA, Next.js 16 app) | Intake takes a repository and/or a live URL; `site` becomes `source {repo, url, framework}`; Sitecore target `{collection, site}`; hosting project |
| Times are shown in the **project's time zone** (ET) with working days | Project `timezone`; the scheduler works in working hours (08:00–18:00, Mon–Fri) |
| The plan is a **schedule** (Today Gantt, Engagement weeks, list), not just a DAG | Template `estimate` hours, a forecast scheduler, actual windows from task events |
| Artifacts are **rich documents** (tables, scores, screenshots, check lists, PR file lists) | A typed `ArtifactDocument` block schema agents write and the Workbench renders |
| The Blueprint is a **mapping table** (source file → rendering, fields, parameters, placeholders, variants, status, changed in v2) | Blueprint item `attrs` carry the mapping; status is derived from task progress; "changed" is a diff against the approved version |
| Site preview compares **source and target** per page at three breakpoints with parity and visual scores | Per-page preview state from screenshots and parity/visual checks |

## 1. Shell

| Element | Prototype behaviour | System | Status |
|---|---|---|---|
| Sidebar | Brand lockup, project switcher (initials, name, subtitle), nav with waiting count on Mission Control, user chip (name, role), light/dark, collapse | `GET /auth/me` (name, role), `GET /projects` (initials, subtitle, phase, health, waiting) | extend |
| Status strip | Phase n: name + bar + %, health dot + word, "Waiting on you: n" (opens queue), clock in project TZ, elapsed ("Day 4, 5h in"), "$286 of $1,200" coloured at 80/100%, connection note, search, presentation, dock toggle | `ProjectSummary` gains `timezone`, `startedAt`, budgets; client clock | extend |
| Project switcher | Menu of projects with phase, subtitle, health dot, waiting badge; switching keeps per-project UI state | `ProjectListItem` gains `initials`, `subtitle`, `currentPhase`, `health`, `waitingCount` | extend |
| Command palette (⌘K) | Go to surfaces, inspect any agent, pause/resume project, approve waiting review, presentation, theme, switch project, open artifacts | client, over the roster/workbench/project list | new (web) |
| Presentation mode | Hides operator chrome, large title, site preview tile | client | new (web) |
| Keyboard | ⌘K, ⌘/ (composer), G then M/T/P/W/S/A, 1–4 choose on open card, D defer, A approve, Esc, ? | client | new (web) |
| Mobile | Bottom nav (Mission, Team, Plan, Cypher, More sheet), dock as sheet, phone plan agenda | client | new (web) |
| Away line | "Since you were away (41 min): 2 escalations raised, 1 resolved. Components moved to 60%. $14 consumed." | `GET /projects/:id/since?seq=` summary; client remembers last-seen seq | new |
| Connection | "Reconnecting", "Catching up: 3 events" | SSE with Last-Event-ID replay (have) + client state | extend (web) |

## 2. Mission Control

| Element | System | Status |
|---|---|---|
| Waiting on you (compact cards, sorted Blocker, Access, Decision, Review, Budget, Risk, then newest) | `waitingOnYou`; order changes to put Access second and gates fourth | extend |
| Stat cards (configurable per project: Renderings, Content items, Media, QA pass; value / total, bar, note) | Playbook `stats` (metric key, label, icon, note template); metrics carry per-project notes | extend |
| Phase progress: stepper with gates, current, next gate, tasks running/queued, parity | have (`phases`, `nextGate`, metric `parity`) | have |
| Team now: one row per Lead (person, role, counts or state line) | `teamNow` with persona and state line | extend |
| Latest from the team (4, links into Activity) | `latest` 4 instead of 3, display agent and short op | extend |
| Subtitle ("Phase 4, Components, runs with phase 5 in parallel. Next gate: Acceptance.") | computed from phases | new |

## 3. Team

| Element | System | Status |
|---|---|---|
| Leadership (Cypher, Handover Writer), then a section per workstream with "n of m specialists working" | `TeamSnapshot` with `persona`, `description`, `projectNote`, `workstream`, `reportsTo` | extend |
| Agent card: initials, person, role, state chip, role description, **Now** with step progress bar ("step 3 of 5"), **Next** (task and when) | `agent.state` gains `step {n, of}`; `next` from the forecast scheduler | new |
| Filter: All / Working now / Not working | client | new (web) |
| Inspector: role, "On this project", model class, reports to, phases, tokens this project, now/task, next, last 3 tool calls (failures red), Pause / Resume this agent, Open in Activity | `AgentDetail` gains `tokensProject`, `modelClass`, `next`, persona; control scope `agent` (have) | extend |

## 4. Plan

| View | System | Status |
|---|---|---|
| **Today**: day in project TZ, 8 AM–8 PM ticks, now line; lanes grouped by workstream; one row per agent ("n of m done"); task bars by window and state; legend; "Up next and what each waits for" | `GET /projects/:id/schedule?view=today` from the forecast scheduler: per-task `{start, end, actual|forecast}`, deps, agent | new |
| **Engagement**: working days across the engagement, week separators, today marker; per phase a span row plus one row per activity with owner; gate diamonds | `schedule?view=engagement`: phases → activities (task groups), spans, gate times | new |
| **Activity list**: phase, activity, owner, start, finish, status; filters All/Open/Running/Waiting/Done with counts | same data, flat | new |
| Phone: agenda (Running now, Waiting, Up next, Done today), engagement as collapsible phases | client | new (web) |
| Task inspector: agent, window, depends on, inputs, outputs, acceptance, attempts "1 of 3", rollback recipe; **Re-run with instructions**; **Roll back** (confirm) | `TaskDetail` (template inputs/outputs/acceptance/rollback from the playbook, attempts, max attempts); `POST tasks/:id/rerun {instructions}`, `POST tasks/:id/rollback` | new |

## 5. Workbench

| Element | System | Status |
|---|---|---|
| Tabs per artifact (Blueprint, Components, Content, Media, Platform Notes, Pilot report, Conformance, Decision Log, PR 12, PR 11) with short names | `ArtifactView.shortTitle`, ordering by kind | extend |
| Blueprint: intro (version, approved when, updated by D-xx), filters (All, Registered, In progress, Planned, Changed in vN, Dropped) with counts, expandable rows (target, source, fields, status, changed tag; parameters, placeholders, variants, version-1 text), footer counts | `GET artifacts/blueprint/view`: rows from Blueprint `attrs`, status from tasks, `changed`/`was` from diff with the Gate 1 version | new |
| Reports and inventories: tables, score tiles, side-by-side screenshots, deviations list, check tables with pass/warning chips | `ArtifactDocument` JSON blocks; images by blob ref (`GET …/blobs/*`) | new |
| Decision Log as an artifact (ID, question, answer, decided by, when; D-xx chips link here from chat) | decisions gain a display id `D-01`… | extend |
| Pull requests (number, title, branch → base, files changed with +/−, state, Open in GitHub) | artifact kind `pull_request` with a `PullRequestDoc` | new |
| Versions (v1 approved at Gate 1, v2 current) | have versions; label approved versions from gate resolutions | extend |

## 6. Site preview

| Element | System | Status |
|---|---|---|
| Page (or section) list with path and parity %; Desktop/Tablet/Phone; status line (parity, visual, pilot); Open in Page builder / Open on preview; Source pane and Target pane | `GET /projects/:id/preview`: pages from the Blueprint `pages` collection (or sections), per-page `migrated`, `parity`, `visual`, `pilot`, screenshot refs per side and breakpoint, `pageBuilderUrl`, `previewUrl`; event `page.checked` | new |
| Source/target labels ("Vite build of ansell-main", "SitecoreAI, preview deploy 6") | project source description and latest preview deployment | new |

## 7. Activity

| Element | System | Status |
|---|---|---|
| Columns: time, agent (person + role), tool (display name: Authoring API, Sandbox, GitHub, Vercel, Validators, Review, Planner, Decision Log, Control, Gate), operation, result (free text: 200, green, pass, 1 warning, reject), duration, tokens; notes under warnings | `step.recorded` gains `outcome` text and `note`; tool display names from the playbook; Lead reviews (`review.recorded`), Cypher planner actions (`plan.changed`), Director controls appear as rows | extend |
| Filters: All / Warnings and failures / Failures; agent select; Live tail toggle with "n new events" pill | have (query params) + client | extend |

## 8. Settings

| Section | System | Status |
|---|---|---|
| Credentials (references only): system, scope, verified time or "Not provided", expiry; Re-verify, Rotate | credential registry: `credential.registered`, `credential.verified`; `POST settings/credentials/:id/verify` runs the system's verifier; rotate starts the vault flow | new |
| Budgets: cost, tokens, time with % bars; 80% soft warning, 100% hard stop | have budgets/spend | have |
| Gates: Gate 1 status, Gate 2 phase, optional **review after the pilot slice**, optional **review before publishing to production** (toggles) | `settings.changed`; orchestrator reads the toggles (pilot checkpoint have; publish review new) | extend |
| Escalation policy table (type, default action after, notifies) | playbook defaults + project overrides; notification channels (Slack, email, digest) | new |
| Conventions (head, naming, grid, languages, source of truth, redirects, hosting), locked after Gate 1 | `conventions` artifact written at Blueprint time; lock from Gate 1 | new |
| Danger zone: pause project; **roll back phase n** (typed "ROLL BACK"; says what it deletes); **archive** (typed project name) | have pause; `POST phases/:n/rollback`, `POST archive` | new |

## 9. Escalation cards

| Element | System | Status |
|---|---|---|
| Type label (Decision, Blocker, Access, Budget, Risk, Review, or "Gate 1"), age, title, context, impact (role names become people), options A/B/C with Recommended, deadline "Proceeds with A at 2:24 PM ET unless you choose" + countdown, evidence chips, Ask a question, Defer 30 min | have most; add `typeLabel`, option `key`, typed evidence targets (artifact, agent, activity filter, preview page, settings, external URL) | extend |
| Gates: Approve, Send back with notes (inline textarea), Ask a question; "Waits for you. No default action." / `waitNote` | have; add `waitNote` | extend |
| Resolved line with Undo for 10 s; Deferred line with Resume now | have (undo, defer); add `POST …/resume` | extend |
| Compact (Mission Control) and queue (dock, expandable) modes | client | new (web) |

## 10. Cypher dock

| Element | System | Status |
|---|---|---|
| Header: Cypher, Chief of Staff, presence (Listening / Thinking), badge, collapse | have presence | have |
| "Needs you" queue (open, deferred, undo-able), hide/show | have queue | have |
| Messages grouped by day ("Today, Thursday, October 22") | client, project TZ | new (web) |
| Message kinds: plain text with jump links and D-xx chips; **brief** embeds (kind, title, labelled rows Produces/Activates/Exit, bullets, note, actions); **status** embed (phase, %, blockers, needs you, renderings, QA, next gate, cost, elapsed, actions); **needs** embed (items with Open); **next** embed (next 5 activities with time, owner, state); **directive** embed (applying in 30 s with bar and Stop, then Applied with a check) | `cos.message` gains `links`, `note`, `status`, `needs`, `upNext`; kinds `brief`, `status`, `needs`, `next`, `directive_ack`, `digest`, `text` | extend |
| Quick prompts (Status, What needs me?, What is next?) and slash commands (/status /pause /resume /approve) | `postMessage` intent routing: status, needs, next, pause/resume an agent by name or the project, approve the waiting review, scope changes ("skip/drop/remove …") with impact, anything else as a logged directive; free text answered by Claude when configured | extend |
| "Ask a question" from a card prefills "About <title>: " | `director.message.about` (escalation id) | extend |
| Briefs: discovery summary, phase entry brief (Produces, Activates, Exit, note), pilot done, daily digest | orchestrator posts briefs on phase entry and checkpoints; digest at end of day in project TZ | extend |

## 11. Intake (new form; implied by multiple projects)

Name, client, initials; source (repository, live URL, framework hint); Sitecore target (site collection, site, languages); hosting (Vercel project); budgets (cost, tokens, hours); time zone; playbook. Credentials are registered by reference after intake and verified in phase 0.

## 12. Build order

1. Contracts and projector (this document's "extend" rows), personas and display names in the playbook.
2. Forecast scheduler and the schedule endpoints.
3. Simulator rebuilt as the prototype's two projects, so every surface has real data through the real API.
4. `apps/web`: the Control Center, using the prototype's design tokens, Carbon icons and Hero New.
5. Orchestrator and API: settings and credentials, re-run and rollback, archive, preview capture, briefs and digest, away summary, notifications, Cypher answers.
