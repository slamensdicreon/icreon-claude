# icreon-claude

Home of **Launchworks**, Icreon's agentic implementation studio for SitecoreAI (working codename).

- [Backend, architecture & build plan](docs/architecture/backend-plan.md)
- [Running the Control Center against the mock backend](docs/mock-backend.md)

## Quick start

```bash
pnpm install
pnpm dev            # Control API on http://127.0.0.1:4000 with two simulated projects
pnpm dev:temporal   # the real orchestrator (stub agents), local Temporal + Postgres, data in .data/
AGENTS=claude ANTHROPIC_API_KEY=... pnpm dev:temporal   # roles with connected tools run on Claude
pnpm test           # all packages
pnpm typecheck
```

Requires Node 22+ (24 in CI) and pnpm 10. `pnpm dev:temporal` downloads the Temporal dev server on
first run; delete `.data/` to start from scratch.

## Sign-in

Locally the API is open and listens on localhost only. Anywhere else it requires GitHub sign-in and
refuses to start without it:

```bash
AUTH=github
GITHUB_CLIENT_ID=...            # a GitHub OAuth app; callback: $PUBLIC_URL/auth/callback
GITHUB_CLIENT_SECRET=...
OPERATORS=login1,login2         # the only accounts allowed in
GITHUB_ORG=icreon               # optional: also require active org membership (2FA lives there)
SESSION_SECRET=...              # 32+ random characters
PUBLIC_URL=https://api.example  # this API
APP_URL=https://app.example     # the Control Center (CORS and post-sign-in redirect)
```

The Control Center calls `GET /auth/me` to know who is signed in, sends people to
`/auth/login?returnTo=...` when it gets a 401, and uses `POST /auth/logout`. Fetches and
`EventSource` need credentials included (`credentials: 'include'`, `withCredentials: true`).

## Layout

| Path                             | What it is                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/control-api`               | Fastify API: snapshots, commands, SSE stream with replay; simulator or Temporal mode    |
| `apps/worker`                    | Orchestration worker as its own process (Temporal + shared Postgres event log)          |
| `packages/contracts`             | zod schemas for every event, snapshot and command (shared with the UI)                  |
| `packages/domain`                | Pure logic: task state machine, health rule, escalation order, read-model projector     |
| `packages/events`                | Event store: in-memory and Postgres (atomic seqs, LISTEN/NOTIFY live tail), projections |
| `packages/plan`                  | Plan compiler: playbook + Blueprint → task graph; re-plan diff and impact preview       |
| `packages/orchestrator`          | Temporal workflows (project, task), Director commands, stub agent activities            |
| `packages/tool-gateway`          | Policy enforcement point for every agent tool call: grants, scopes, credentials, audit  |
| `packages/agent-runtime`         | Agent loop on the Claude Messages API: tools via the gateway, caching, budgets          |
| `packages/stack`                 | Composition root: tool servers behind the gateway, live agents where tools exist        |
| `tool-servers/browser`           | Crawl, snapshots, screenshots at 3 breakpoints, asset fetch; egress proxy blocks SSRF   |
| `tool-servers/validators`        | axe-core, Lighthouse and screenshot pixel diff for the QA roles                         |
| `tool-servers/workspace`         | Versioned project documents (artifacts), the Blueprint blackboard, the Decision Log     |
| `packages/playbook-sdk`          | Schema, loader and validator for playbooks                                              |
| `packages/simulator`             | Scripted engagements for UI work and demos                                              |
| `playbooks/sitecoreai-migration` | Playbook #1: 11 phases, 2 Director gates, 24 roles, task templates, demo fixtures       |
