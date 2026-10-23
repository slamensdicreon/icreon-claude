# Playbooks and platform packs

A project runs one playbook, chosen in the New Project wizard and pinned (id and version) when the
project is created. The system has three layers.

| Layer | What it holds | Where |
| --- | --- | --- |
| The method | How every team works: Director, Chief of Staff, Leads and specialists; gates and decision cards; budgets and escalation; evidence, read-back and risk tiers | The orchestrator, tool gateway and Control Center (`packages/`) |
| Platform packs | What is true of a platform whatever the job: intake fields, credential types and how each is checked, which credential each tool server carries, scope bindings (what a project may write), the agents' target context, platform knowledge | `platforms/<id>/` |
| Playbooks | The job to be done: the charter (mission and outcomes), what intake collects, phases and gates, roles, prompts, the task plan, the Definition of Done | `playbooks/<id>/` |

"Build an Optimizely site" is a build playbook on an Optimizely pack. "Operate and optimize a
SitecoreAI site" is a new playbook on the existing SitecoreAI pack.

## A playbook

`playbook.yaml` declares:

- **`platform`**: the pack it runs on.
- **`charter`**: the mission, and the outcomes the team owes the client, each with how it's
  measured. Every agent gets the charter in its role prompt, and acceptance is judged against
  the outcomes.
- **`intake`**: whether there is a source repository and live site (`required`, `optional` or
  `none`), then steps of fields and credentials, by the pack's ids. The wizard draws itself from
  this, and the API checks every submission against it.
- **`phases`** and **`defaults`**, as before.

Roles (`roles/*.yaml`), prompts (`prompts/*.md`), the plan (`plan.yaml`) and playbook knowledge
(`knowledge/*.md`) sit beside it. A role's `knowledge` list is looked up in the playbook's folder
first, then the pack's.

## A platform pack

`platforms/<id>/pack.ts` exports a `PlatformPack` (see `platforms/src/index.ts`) and registers it
in `createPlatforms`. Its declarative parts (field and credential specs) are served to the wizard
through `GET /playbooks`; its behaviour (checks, token minting, bindings, context) runs only on
the server and in the worker.

## Running

- The API and the worker load every folder under `playbooks/` (`PLAYBOOKS_DIR`).
- The worker composes one stack per playbook and serves each on its own Temporal task queue
  (`taskQueueFor`). The first playbook, `sitecoreai-migration`, keeps the original queue name so
  projects started before the catalog keep running.
- A project keeps the playbook version it was created with. A new version applies to new
  projects, or to an existing one after a reset.

## Not built yet

- **Continuous engagements.** An operate or optimize playbook runs in cycles (a backlog,
  recurring reviews, service levels) rather than phases to a handover. The orchestrator runs
  phases only today.
- **Handover from build to operate.** Carrying a build's repository, tenant facts and component
  catalog into a new operate project for the same client.
