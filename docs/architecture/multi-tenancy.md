# Organizations, roles and licensing

Launchworks runs today for one team: a list of GitHub logins (`OPERATORS`) all have full access,
and one GitHub org, one Vercel team, one Anthropic key and one settings store serve every project.
This plan turns it into a product that many client organizations license and run themselves,
with Icreon hosting everything.

The playbooks are already close to ready for this. A project's platform credentials are sealed per
project at intake and minted per tool call, and the entity/playbook split
([entities.md](entities.md)) is the right shape. What assumes a single team is the layer around
them: sign-in, ownership of projects, the global integrations, and the catalog.

## Decisions

| Topic               | Decision                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product             | A SaaS product. Client organizations run their own projects; their own people can be Directors.                                                               |
| Kickoff             | Every customer starts with an Icreon Director, a member of the organization the customer can't remove for the first 3 months, and who stays after that unless the customer asks otherwise. |
| Hosting             | Icreon hosts everything: build repositories in Icreon's GitHub org, sites in Icreon's Vercel team, agents on Icreon's Anthropic account.                       |
| Leaving             | A customer can export their code and repository during the license and for 90 days after it ends.                                                           |
| Sign-in             | Auth0. Email and social sign-in now; SSO per organization later, without changes on our side. GitHub stays one way in.                                         |
| Playbooks           | Icreon's product. Customers run them and never edit them.                                                                                                     |
| Lessons             | Reach the shared playbooks only through Icreon's knowledge review, with client names removed, and ship to every licensee in the next version.                  |
| Seats               | Unlimited.                                                                                                                                                     |
| `/admin`            | Icreon only. Customers never reach it, whatever their role.                                                                                                     |
| Watchers            | Client stakeholders. They see everything about a project's progress and change nothing.                                                                       |
| License end         | Projects pause and become read-only.                                                                                                                           |

## Licensing

An organization holds one license, renewed yearly. A large organization's license can cover
several entities. The license says:

- **Entities** (SitecoreAI, Optimizely, …). Every playbook and connection the organization uses is
  on one of them.
- **Playbooks.** Which playbooks on those entities the organization can run, for the full year.
  Customers don't swap them; adding one is an upgrade Icreon makes in `/admin`.
- **Projects.** How many projects can exist at once. The starting license includes 1; each further
  project is bought (for example, 1 entity, 1 playbook, 10 projects).
- **Term.** One year from the start date.

```
License
  organizationId
  entities            ['sitecoreai']
  playbooks           ['sitecoreai-migration']
  projectsIncluded    10
  startsAt, endsAt
```

### Rules the server enforces

Every rule is checked by the Control API. Hiding something in the Control Center is never the
only guard.

- **Creating a project** needs a license in its term that includes the project's entity and
  playbook, and fewer existing projects than `projectsIncluded`.
- **Deleting a project frees its place** in the project count as soon as the deletion is
  requested. Restoring it during the deletion grace period (`DELETE_GRACE_DAYS`) needs a free
  place. An archived project keeps its place.
- **The catalog** shows licensed playbooks as available, other playbooks on licensed entities as
  "upgrade", and nothing from unlicensed entities.
- **Only Icreon changes a license**, in `/admin`: adding playbooks, projects or entities, and
  replacing an entity when the customer changes platforms. Projects on the entity that was
  replaced are paused and become read-only, with the same export window as an ended license.
- **When the term ends**, a scheduled check (the existing cron path pattern) pauses every running
  workflow and marks the organization's projects read-only. Everyone can still sign in and read;
  no command is accepted. Export stays available for 90 days. Renewal resumes the paused projects
  where they stopped.
- **Every change to a license** (granted, playbooks or projects added, entity added or replaced,
  renewed, ended) is an event, so there is an audit trail for billing disputes.

### Usage to meter

Licensing counts projects, not usage, but Icreon pays for the usage. Record it per organization
and per project from the start, even before any limit uses it: Claude tokens (the agent runtime
already tracks budgets), Vercel builds and bandwidth, and sandbox time. This tells us what a
project costs us, and is how we will find out if one license is unprofitable.

## Organizations and isolation

Built (step 2):

- **A project's owner scopes everything of the project.** Events, documents, blobs and sealed
  credentials are all keyed by project, so instead of an `organizationId` on every event, one row
  per project records its organization (`lw_project_organizations`). It is written before the
  project's first event and never changes, so no reader sees a project without its owner.
- **Tables:** `lw_organizations`, `lw_memberships` (person, organization, role) and
  `lw_project_organizations` (migration `008_organizations.sql`). The migration creates
  organization #1, Icreon (`org-icreon`), and gives it every project already in the log. A project
  a process writes without an owner (a demo, a seed) is Icreon's as well.
- **Every request acts in one organization** (`apps/control-api/src/organizations.ts`). The
  caller's memberships decide which; the `x-lw-organization` header picks one when they belong to
  several. Someone who belongs nowhere gets `403 no_organization`. Today's operators
  (`OPERATORS` and their API keys) are added as Icreon Directors at startup, and a local run's
  operator is one too.
- **One check for every project route.** Any `/projects/:id/...` route answers `404` for a project
  of another organization, as if it didn't exist. Lists (projects, the Dashboard, Team, Workbench,
  Activity, Scorecard, playbook scorecards, deleted projects) hold only the organization's projects.
- **Saved connections belong to an organization:** they can't be listed, rotated or used to start
  a project from another. Connections saved before organizations are Icreon's.
- **Cypher runs per organization:** it reads, drafts and answers for that organization's projects
  only, and keeps its conversations apart.
- **System calls stay system-wide:** the scheduled watchdog and purge (Vercel Cron) act across
  organizations; an operator running the purge by hand purges their own organization's.

Not yet:

- **Postgres row-level security.** Every service shares one connection pool as the table owner, so
  policies keyed on a per-request setting need a connection (and transaction) per request. Until
  that change, isolation rests on the single checks above, which tests cover.
- **Team-wide content is still Icreon's alone:** rules, knowledge and the proposals review, the
  GitHub App setup and the worker's diagnostics are shared. That is right while Icreon is the
  only organization; step 3 limits them to super admins, and decides which rules a customer's
  Director may make (today a rule can be scoped to a whole playbook or platform).
- Organizations are created and people added through the store, not yet through `/admin`.

- The tool gateway already limits every agent call to its own project. Keep it that way, and add
  the organization to the audit record.
- Settings that are global today (`preferences: integrations`) split into system settings and
  per-organization settings.
- One `CREDENTIALS_KEY` still encrypts everything. A key per organization (envelope encryption)
  is a later improvement, not a blocker.

## People and roles

A person (an Auth0 user) can belong to several organizations; Icreon Directors belong to every
customer they start. The Control Center gets an organization switcher.

Customers never reach `/admin`. It is a separate area for Icreon super admins: every organization,
its licenses and usage, changing playbooks or entities, and diagnostics. Whatever role someone
holds inside an organization, it never opens `/admin`.

| Role                   | Who                                    | Can                                                                                                                                       |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Super admin**        | Icreon staff                           | `/admin`: every organization, licenses, entities, playbooks, usage, diagnostics. Not inside projects, except through a logged, time-limited support grant. |
| **Director**           | Icreon's kickoff Director; client DIDs | Everything inside the organization: intake, commands, cards and gates, connections, invites, export, delete.                              |
| **Watcher**            | Client stakeholders                    | See everything about progress (plans, status, the agent view, cards, documents, the scorecard). Change nothing.                          |

Roles are stored in our database as permission sets, not in Auth0, so we can add a role (a client
approver who answers only some cards is the likely next one) or grant a role on a single project
without a rewrite. Auth0 holds identity, organization membership and invitations.

### The Icreon kickoff Director

For the first 3 months the customer can't remove the kickoff Director or lower their role; the API
refuses it. After that nothing changes on its own: Icreon keeps providing service and support, and
the Director stays until the customer asks for them to be removed.

### Enforcing Watcher

The Control API has over a hundred routes. Watcher access is an **allowlist of read routes**,
deny by default, so a route added later is closed to Watchers until someone opens it. Closed:
commands, intake, connections and credentials, purge and delete, knowledge review, settings and
preferences, API keys, voice and project chat that can act, and the CSV exports unless we decide
otherwise.

What Watchers must not see even on routes they can read:

- cost, budgets and Icreon's margin;
- credential names and environment hostnames;
- prompt text. Playbooks are the product, so transcripts and "why did the agent do this" views
  show what an agent did, not the instructions it was given. This applies to client Directors too.

## Sign-in

- Auth0 with Organizations: one Auth0 organization per Launchworks organization; email or magic
  link, Google and Microsoft; MFA; invitations by email.
- The API keeps its session cookie and checks membership and role on every request, as it checks
  `OPERATORS` today.
- No public sign-up. Icreon creates an organization in `/admin` when a license is sold, invites
  the kickoff Director, and that Director invites the customer.
- API keys (`OPERATOR_API_KEYS`) become per organization, each with a role. The cron secret stays
  system level.

## Hosting

Everything is created in Icreon's accounts, so a customer never sees GitHub or Vercel.

- **Names:** build repositories and Vercel projects take an organization prefix
  (`<org-slug>-<project-slug>`), so two customers' projects can't collide.
- **Limits:** check the GitHub org and Vercel team limits on project count and concurrent builds
  before the customer count reaches them.
- **Secrets:** a client's Sitecore secrets sit in the environment variables of a Vercel project in
  Icreon's team, where Icreon staff with team access can read them. The terms must say so.
- **A client's existing repository** stays optional: projects that start from one keep the current
  GitHub App install flow.

## Onboarding

1. Icreon creates the organization and its license in `/admin` and invites the kickoff Director.
2. The organization connects its licensed entity. A marketer often can't create the Sitecore Cloud
   Portal credentials themselves, so this step can be sent to their Sitecore admin as a link that
   someone outside Launchworks can complete. The platform pack's live checks confirm it.
3. The Director invites the client's Directors and Watchers.
4. The first project starts from an active playbook.

## Export

- The repository as a zip, or transferred to the customer's own GitHub org through the App.
- Optionally the Vercel project, which Vercel can move between teams.
- The Sitecore serialization and the project documents, not only the front-end code.
- Available during the term and for 90 days after it ends; after that the organization's
  repositories, Vercel projects and data are purged (the existing purge path).

## Playbooks free of client names

Several prompts and roles name the clients whose projects taught them a lesson
(`prompts/media-migrator.md`, `prompts/head-integrator.md`, `prompts/rendering-registrar.md`,
`roles/rendering-registrar.yaml`, `plan.yaml` in `sitecoreai-migration` and
`sitecoreai-homepage-demo`). Every licensee's agents would read them. Restate each lesson without
the name, and keep a test that refuses client names so new ones can't land. Once organizations exist, the
knowledge review should also check a lesson against every organization's and project's name
before it reaches a playbook.

## Order of work

1. Remove client names from the playbooks; a test that refuses them. **Done:** `packages/playbook-sdk/test/client-names.test.ts`.
2. Organizations, memberships and roles in the data model, today's projects as organization #1.
   **Done**, except row-level security (see "Not yet" above).
3. Roles enforced in the API; Watcher with the read allowlist and redaction.
4. Auth0 sign-in, invitations, organization switcher.
5. Licenses: entities, playbooks, project count, term; the catalog filtered by them;
   the end-of-term pause.
6. Hosting per organization: prefixed names, usage recorded per organization.
7. Onboarding: connection step with the hand-off to the client's admin.
8. Export.
9. `/admin` (Icreon only): organizations, licenses, entity changes, playbooks, usage,
   diagnostics, support grants.
