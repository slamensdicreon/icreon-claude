# Running the Control Center against the mock backend

The M0 backend runs the real API, event log and read models, with **simulated projects** standing in
for the agent team. Point the prototype at it to build every surface against the real data shapes:
live updates, reconnects, escalations, gates, pauses and the completed state.

## Start it

```bash
pnpm install
pnpm dev                       # http://127.0.0.1:4000, the demo project
SIM_SPEED=5 pnpm dev           # 5x faster
SIM_PROJECTS=2 pnpm dev        # plus two scripted engagements, both on SitecoreAI
SIM_PROJECTS=3 pnpm dev        # plus a third, on Optimizely CMS (SaaS)
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `4000` / `127.0.0.1` | There is no sign-in yet, so it binds to localhost only |
| `CORS_ORIGIN` | `*` | Set it to the prototype's origin to lock it down |
| `SIM_SPEED` | `1` | At 1, one engagement takes about 10 minutes plus the time you take to answer |
| `SIM_PROJECTS` | `0` | Scripted engagements beside the demo project, in this order. The first, **Acme corporate site**, waits for you at every gate and Blocker; the second, **Northwind marketing site**, runs on autopilot at 3x speed, so the project switcher shows two different states. Both build a SitecoreAI website. The third, **Globex website**, builds an Optimizely CMS (SaaS) website and waits for you like Acme |
| `LOCAL_ROLE` | `director` | `watcher` shows the app as a client stakeholder sees it: everything readable, nothing changeable, no amounts |

All state is in memory, so restarting the server resets everything.

Each scripted engagement is created on its own playbook and plays that playbook's scenario
(`apps/control-api/src/sim-projects.ts` lists them; the scenarios are in `packages/simulator`):
`sitecoreai-migration` for Acme and Northwind, `optimizely-saas-migration` for Globex. No CMS,
repository or host is called for any of them. A playbook without a scenario (the homepage demos,
the customer portal) has no simulated project yet; the demo project itself is a SitecoreAI build.

When the API is deployed with `DEMO_RUNNER=separate`, the demo runner
(`pnpm --filter @lw/control-api demo-runner`) plays the same engagements with the same
`SIM_PROJECTS` and `SIM_SPEED`, under fixed project ids, and starts them over each time it starts.

## Or run the real orchestrator

`pnpm dev:temporal` serves the same API on the same port, backed by the real Temporal
orchestrator with stub agents instead of the scripted simulator. The plan is compiled from the
playbook, Gate 1 expands it from the example Blueprint, and directives re-plan for real
(try "Skip the blog"). What's different:

- **Deadlines are real.** Defaults apply after the playbook's deadlines (Decisions after 2 hours),
  not after seconds.
- **State survives restarts.** The event log and the workflows persist in `.data/`; kill the
  process at any point and it resumes where it stopped. Delete `.data/` to start over.
- **One project to start.** Create more with `POST /projects {"name": "...", "client": "...", "sourceUrl": "https://..."}`.
- **Real agents, where their tools exist.** With `AGENTS=claude` and `ANTHROPIC_API_KEY` set, the
  roles whose tools are all connected run on Claude: today the Content Analyst (crawls
  `sourceUrl`, writes the page inventory), the Solution Architect (writes the Blueprint that
  Gate 1 expands the plan from), Visual QA (screenshots and pixel diffs), Performance and
  Accessibility QA (axe and Lighthouse) and the Handover Writer (reads the Decision Log, writes
  the handover pack). QA can only reach the source site's host until preview deployments exist. How each live role works (artifact ids, the Blueprint shape, QA thresholds) is in the playbook's own prompts: `playbooks/sitecoreai-migration/prompts/` for the sample project, `playbooks/optimizely-saas-migration/prompts/` for an Optimizely one. Every other role stays a stub until its tool servers land. The
  startup log names the live roles.

## Data shapes

Every request and response shape is a zod schema in [`packages/contracts`](../packages/contracts/src).
If the prototype is TypeScript, import the types directly (`@lw/contracts`). Otherwise read the
schemas as the spec.

## The loading pattern: snapshot, then stream

```ts
const snap = await fetch(`${API}/projects/${id}/mission-control`).then((r) => r.json());
render(snap);
const es = new EventSource(`${API}/projects/${id}/stream?after=${snap.seq}`);
es.addEventListener('lw', (msg) => apply(JSON.parse(msg.data))); // typed LwEvent
```

- Each event's SSE id is its `seq`. When the connection drops, `EventSource` reconnects with
  `Last-Event-ID`, and the server replays exactly what was missed. That covers the spec's "Reconnecting"
  and "Catching up" states.
- The simplest client re-fetches the snapshot when an event arrives (snapshots are cheap). A finer
  client applies events to local state. Either way, `seq` tells you whether you're current.

## Endpoints

| Surface | Request |
|---|---|
| Project switcher | `GET /projects` |
| Mission Control + status strip | `GET /projects/:id/mission-control` |
| Chief of Staff dock (conversation + escalation queue) | `GET /projects/:id/conversation` |
| Team | `GET /projects/:id/team` · inspector: `GET /projects/:id/agents/:agentId` (last 3 tool calls) |
| Plan | `GET /projects/:id/plan` · inspector: `GET /projects/:id/tasks/:taskId` |
| Activity | `GET /projects/:id/activity?limit=100&before=<seq>&severity=warning,failure&type=step.recorded&agent=<id>&phase=<n>` |
| Escalation card | `GET /projects/:id/escalations/:escalationId` |
| Decision Log | `GET /projects/:id/decisions` |
| Workbench (documents) | `GET /projects/:id/workbench` · one: `GET /projects/:id/artifacts/:artifactId` · content: `GET /projects/:id/artifacts/:artifactId/versions/:version/content` (`:version` may be `latest`; served as Markdown or JSON; `404 no_content` for versions that only have a record, which is every version in simulated projects) |
| Live updates | `GET /projects/:id/stream?after=<seq>` (SSE, event name `lw`) |

| Action | Request |
|---|---|
| New project (intake) | `POST /projects {"name": "...", "client": "...", "sourceUrl": "https://..."}` → `201 {"projectId"}`. `sourceUrl` is optional and must be http(s); it shows as `sourceUrl` on the project summary |
| Send a directive or ask for status | `POST /projects/:id/messages {"body": "status"}` (also `/pause`, `/resume`) |
| Choose an option | `POST /projects/:id/escalations/:escalationId/resolve {"optionId": "..."}` |
| Defer | `POST /projects/:id/escalations/:escalationId/defer {"until": "<ISO time>"}` |
| Approve a gate | `POST /projects/:id/gates/:escalationId/approve {}`. Gate 2 needs `{"confirmation": "<project name>"}` |
| Send a gate back | `POST /projects/:id/gates/:escalationId/send-back {"notes": "..."}` (notes required) |
| Stop a directive in its window | `POST /projects/:id/directives/:directiveId/stop` |
| Pause / resume / cancel | `POST /projects/:id/control {"verb": "pause" \| "resume" \| "cancel", "scope": {"kind": "project" \| "phase" \| "workstream" \| "agent" \| "task", "id": "..."}}`. Cancel takes a task (with its same-item dependents), a phase or the project. What is paused shows in `project.holds`. |
| Undo a choice | `POST /projects/:id/escalations/:escalationId/undo` while the card's `undoUntil` is set (10 s; orchestrator only) |

Commands return `{accepted: true, seq}`. Errors return `{error: {code, message}}`, and the message
names the system and the next step, per the design spec. For example, a Gate 2 approval without
confirmation returns 422 `confirmation_required`.

## What happens in a simulated project

The two scenarios share the method: phase briefs, tasks reviewed by their Lead, a Risk and a
Decision that expire to their defaults, Gate 1 on the Blueprint (send it back to get v2), a pilot
slice, a component rejected twice, one Blocker, Gate 2. They differ in what the platform sets: the
order of the work, the tool servers called and the words on every card.

### SitecoreAI (Acme, Northwind)

| Phase | What you'll see | Needs you? |
|---|---|---|
| 0–1 | Access checks; three analysts work in parallel; inventories and Platform Notes appear; a **Risk** card (expires to default after ~10 min) | No |
| 2 | **Decision**: "Source of truth for page content" (expires to its default after ~90 s); Blueprint v1; **Gate 1** | **Yes**: approve, or send back to get v2 and a new gate |
| 3 | Site skeleton and hosting | No |
| 4 ∥ 5 | Phases run in parallel. 16 components port and register; the `components_registered` counter climbs; **Hero** is rejected twice (health turns **Attention** on the second retry), then a **Decision** on granularity (expires to default after ~2 min); a "pilot slice ready" message | Optional |
| 6 | Pages and media counters climb; **Blocker: Media upload 403** (health turns **Blocked**; text migration continues meanwhile); `sitecore-authoring` briefly reports **degraded**; parity reaches 98.6% | **Yes**: choose an option |
| 7–8 | Proof variant and A/B test; production deploy; publish | No |
| 9 | QA metrics; Acceptance Report; **Gate 2** (requires typing the project name) | **Yes** |
| 10 | Handover pack; project `completed` | No |

### Optimizely CMS (SaaS) (Globex)

The plan is the playbook's own (`playbooks/optimizely-saas-migration/plan.yaml`), expanded over
its example Blueprint: 16 components, 5 page and experience types, 48 pages and 120 media items,
243 tasks with the ids, roles and titles a real project shows. Activity names the platform's tool
servers (`optimizely-cms` as "CMS REST API", `optimizely-graph`, the sandbox's
`exec.optimizely-cli`), Mission Control counts **Content types** and **Experiences**, and every
path is the application's own: `/content/Globex_Website/…`, `/shared/Globex_Website/…`,
`/media/Globex_Website/…`.

| Phase | What you'll see | Needs you? |
|---|---|---|
| 0 | A read-only probe of the instance (applications, locales, content types with the prefix `Globex`, Graph); beside it, a card **By hand: Give the API key content rights in the CMS**, because no read shows them | **Yes**: mark it done |
| 1 | Three analysts work in parallel; inventories and Platform Notes appear; a **Risk** card (expires to default after ~10 min) | No |
| 2 | **Decision**: "Source of truth for page content" (expires to its default after ~90 s); Blueprint v1; **Gate 1** | **Yes**: approve, or send back to get v2 and a new gate |
| 3 | Design tokens; the head deployed to Vercel. No application yet: it needs its start page's type | No |
| 4 ∥ 5 | Both phases open together. Content types first: each component is built on a branch (`push-dry-run`), then integrated and pushed (`push`), and the **Content types** counter climbs; **Hero** is rejected twice, then a **Decision** on its variants (expires to default after ~2 min). Once the page types are pushed, the application is created on its start page with its primary host, its preview host and live preview; the pilot experience is composed, published and read back from Optimizely Graph; a "pilot slice ready" message. Then the other 10 components, beside the shared header and footer (published as written) and the blueprints | Optional |
| 5 | **Blocker: Blueprint creation 403**, a right of its own that content rights don't give (health turns **Blocked**; components continue meanwhile) | **Yes**: choose an option |
| 6 | Each page is created, composed and published in its own task, in sessions of 8; media uploads in sessions of 20, one image refused as AVIF and fetched again; `optimizely-cms` briefly reports **degraded**; parity reaches 98.6% | No |
| 7 | Redirects, sitemap, robots and error pages in the head; SEO properties as drafts | No |
| 8 | The reviewed commit deployed; the content model exported and replayed (`manifest.export`, a clean dry run); the final versions published and every route read from Graph; a card **By hand: Smoke test Visual Builder on production** | **Yes**: mark it done |
| 9 | Handover pack; **Gate 2** (requires typing the project name); project `completed` | **Yes** |

A real Optimizely project also asks for an approval before each release (the head, the
application, the pilot's publish, the shell, each page, the final deploy and publish). A scripted
engagement doesn't model release approvals on either platform; the real orchestrator does.

To exercise the other states:
- **Paused:** `/pause` in the composer, or pause an agent or workstream from the Team inspector.
- **Directive with stop window:** send any other message.
- **Budget:** the demo budgets are small, so the burn bar moves.
- **Empty states:** start the server with `SIM_PROJECTS=1` and look at Acme in its first seconds.
