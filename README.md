# icreon-claude

Home of **Launchworks**, Icreon's agentic implementation studio for SitecoreAI (working codename).

- [Backend, architecture & build plan](docs/architecture/backend-plan.md)
- [Running the Control Center against the mock backend](docs/mock-backend.md)

## Quick start

```bash
pnpm install
pnpm dev          # Control API on http://127.0.0.1:4000 with two simulated projects
pnpm test         # all packages
pnpm typecheck
```

Requires Node 22+ (24 in CI) and pnpm 10.

## Layout

| Path                             | What it is                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/control-api`               | Fastify API: snapshots, commands, SSE stream with replay                            |
| `packages/contracts`             | zod schemas for every event, snapshot and command (shared with the UI)              |
| `packages/domain`                | Pure logic: task state machine, health rule, escalation order, read-model projector |
| `packages/events`                | Event store interface (in-memory for now) and the projection registry               |
| `packages/playbook-sdk`          | Schema, loader and validator for playbooks                                          |
| `packages/simulator`             | Scripted engagements that stand in for the agent team until it exists               |
| `playbooks/sitecoreai-migration` | Playbook #1: 11 phases, 2 Director gates, 24 roles                                  |
