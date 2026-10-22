# Running the Control Center against the mock backend

The M0 backend runs the real API, event log and read models, with **simulated projects** standing in
for the agent team. Point the prototype at it to build every surface against the real data shapes:
live updates, reconnects, escalations, gates, pauses and the completed state.

## Start it

```bash
pnpm install
pnpm dev                       # http://127.0.0.1:4000, two simulated projects
SIM_SPEED=5 pnpm dev           # 5x faster
SIM_PROJECTS=1 pnpm dev        # one project only
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `4000` / `127.0.0.1` | There is no sign-in yet, so it binds to localhost only |
| `CORS_ORIGIN` | `*` | Set it to the prototype's origin to lock it down |
| `SIM_SPEED` | `1` | At 1, one engagement takes about 10 minutes plus the time you take to answer |
| `SIM_PROJECTS` | `2` | **Acme corporate site** waits for you at every gate and Blocker. **Northwind marketing site** runs on autopilot at 3x speed, so the project switcher always shows two different states |

Start another project at any time with `POST /dev/simulations` and a body like
`{"name": "Demo", "autopilot": false}`. All state is in memory, so restarting the server resets everything.

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
  `sourceUrl`, writes the page inventory) and the Solution Architect (writes the Blueprint that
  Gate 1 expands the plan from). Every other role stays a stub until its tool servers land. The
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

To exercise the other states:
- **Paused:** `/pause` in the composer, or pause an agent or workstream from the Team inspector.
- **Directive with stop window:** send any other message.
- **Budget:** the demo budgets are small, so the burn bar moves.
- **Empty states:** call `POST /dev/simulations` and look at the new project in its first seconds.
