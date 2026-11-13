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
| Sign-in             | WorkOS AuthKit (chosen over Auth0: built for B2B, SSO priced per customer connection, identity only). Email, Google, Microsoft now; SSO per organization later. GitHub stays one way in. |
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
  `lw_project_organizations` (migration `010_organizations.sql`). The migration creates
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

A person (a WorkOS user, or a GitHub login) can belong to several organizations; Icreon Directors belong to every
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
without a rewrite. WorkOS holds identity only; memberships and invitations are ours.

### The Icreon kickoff Director

For the first 3 months the customer can't remove the kickoff Director or lower their role; the API
refuses it. After that nothing changes on its own: Icreon keeps providing service and support, and
the Director stays until the customer asks for them to be removed.

### Enforcing roles (step 3, built)

Every check is in the Control API (`apps/control-api/src/organizations.ts`); the Control Center
only explains it.

- **Watcher: an allowlist of read routes** (`WATCHER_ROUTES`), deny by default, so a route added
  later is closed to Watchers until someone lists it. A test fails if the list names a route that
  doesn't exist. Open: the projects list, the Dashboard and the portfolio pages, and on each
  project Mission Control, Team and agents, Plan and tasks, the conversation, cards and the
  Decision Log, facts, the Workbench and its documents and screenshots, schedule, preview,
  Blueprint, Activity and the live stream. Closed: every command and change, intake, settings,
  saved connections, Cypher, remix, the documents zip and the CSV exports. Their own screen modes
  (`PUT /me/preferences`) are theirs to keep. A refusal is `403 read_only`.
- **What a Watcher's answers leave out** (`apps/control-api/src/redact.ts`), on every JSON answer
  and on the live stream: amounts (spend, budgets, tokens) are 0 and money lines in Activity read
  "Spend recorded"; credential hints, sealed references and the scope a credential was granted
  for are blank. Values are blanked, not removed, so every answer keeps its contract.
- **Prompt text** is not in any answer, for any role: no route returns a role's prompt.
- **Super admin: a Director of Icreon (organization #1)**, wherever the request acts. Only they
  reach the knowledge base and its review, rules, proposals, the GitHub App, retrospectives,
  triage replays, the operator test email, the simulator's scenarios and the system's
  diagnostics (`403 super_admin_only` for everyone else). This means a customer's Director does
  not make rules from their answers yet; which rules they may make is still to decide.
- **The Control Center** reads the role before it renders. A Watcher sees "Watching
  <organization> · read only" at the bottom of every screen, amounts as "—", and any button they
  press answers with the read-only message instead of sending anything.
  `LOCAL_ROLE=watcher pnpm dev` shows a local run as a Watcher sees it.

Still to do in the Control Center: hide the buttons a Watcher can't use (they show, and explain
themselves when pressed), and word the Dashboard for someone who decides nothing ("Four things are
yours" is the Director's line).

## Sign-in (step 4)

WorkOS AuthKit, chosen over Auth0: it is built for selling to companies, each customer's own SSO
and directory sync are priced per connection (switched on only for customers who want them), and
it holds identity only, so our memberships, roles and invitations stay ours.

Built:

- **Both ways in** (`apps/control-api/src/auth.ts`). With `WORKOS_CLIENT_ID` and `WORKOS_KEY` set,
  `/auth/login` offers "Continue with email, Google or Microsoft" (AuthKit) beside GitHub for
  Icreon's operators; `AUTH=workos` drops GitHub. A WorkOS session is `workos:<user id>` in
  memberships and needs no place on `OPERATORS`.
- **Only people with an invitation get in.** On the way back from AuthKit, every open invitation
  for the person's verified address becomes a membership; someone with none is turned away with
  "hasn't been invited yet", and no session is made.
- **Invitations** (`lw_invitations`, migration `011`; `apps/control-api/src/people.ts`): a Director
  invites by email as Director or Watcher, from **People** in Global settings. WorkOS sends the
  email; its link (`/auth/login?invitation_token=…`) goes straight to AuthKit. An invitation is
  open 7 days, inviting again replaces it, and it can be withdrawn. If WorkOS can't send the
  email, the invitation still stands: the person signs in with that address.
- **People** also changes a member's role and removes members. Nobody changes their own access,
  an organization always keeps a Director, and a customer can't remove or demote Icreon's
  Director (only Icreon can). The 3-month minimum isn't separate from that yet.

Not yet:

- The organization switcher in the Control Center, for people in several organizations (Icreon's
  Directors). The API already takes `x-lw-organization`; the stream (an `EventSource`) can't send
  a header, so the choice needs a cookie.
- API keys (`OPERATOR_API_KEYS`) per organization, each with a role. The cron secret stays system
  level.
- Creating organizations from `/admin`.

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

1. Remove client names from the playbooks; a test that refuses them. **Done**
   (`packages/playbook-sdk/test/client-names.test.ts`).
2. Organizations, memberships and roles in the data model, today's projects as organization #1.
   **Done**; row-level security deferred (below).
3. Roles enforced in the API; Watcher with the read allowlist and redaction. **Done.** Watchers
   see no decision buttons (cards offer "Read it" / "Open"; Needs you says the Director decides)
   and Cypher's lines read about the Director ("One thing waits on the Director").
4. WorkOS sign-in, invitations, organization switcher. **Done.** The switcher keeps the choice in
   an `lw_org` cookie (the stream sends it too); the account menu lists the person's
   organizations. API keys follow memberships like people do: a key's login is
   `github:<login>`, so it acts in that login's organizations, in that role.
5. Licenses. **Done** (`apps/control-api/src/licenses.ts`, migration 012): platforms, playbooks,
   projects included and term per customer organization, every change kept; creating a project
   checks it (a project holds a place while live and not on its way to deletion); the catalog
   marks unlicensed playbooks; after the term the organization is read only, and an hourly
   scheduled call (`/portfolio/licenses`) pauses its running projects and resumes exactly those on
   renewal. A platform taken out of a license does the same to that platform's projects.
6. Hosting per organization. **Done**: a customer's Vercel project and build repository are named
   with its slug first; `/admin/organizations` reports agent spend per organization. Usage per
   organization: Claude spend, time its agents' tools ran (sandbox, browser, …, from each step's
   duration) and Vercel builds and build minutes per hosting project, in Manage → Usage. Vercel's
   API gives no bandwidth or function time per project, so those aren't metered.
7. Onboarding. **Done**: "Send to their admin" beside each credential gives a signed link (7 days,
   one save) to a page where the client's administrator enters it; it is checked and sealed as if
   the Director had (`apps/control-api/src/handoff.ts`).
8. Export. **Done**: `GET /projects/:id/export` and "Take it with you" in project Settings:
   documents, activity, and a fresh GitHub link to the code; open during the license and 90 days
   after. Moving the repository and the Vercel project to the customer's accounts is still done by
   Icreon by hand. When export closes, the hourly license check purges the organization's projects
   (as a deletion would) and records it in the license history.
9. `/admin`. **Done**: Organizations (create, standing, use, spend), Manage (license editor with
   its history), support access (1 to 72 hours, Watcher or Director, shown in the customer's
   People; migration 013), switching. Diagnostics stays the Diagnostics page.
10. The admin console, apart from the product. **In progress.** Everything Icreon administers
    moves out of the Control Center into `/admin` on Icreon's own site (the `cypher-web`
    repository, built there), so customers' browsers carry none of it.
    - The console has its own sign-in (one-time email links for named people). It lets in only
      those the platform says are Icreon Directors (`GET /admin/me`): one list, Icreon's Directors
      in People.
    - It calls the platform server to server with `ADMIN_CONSOLE_KEY`, naming who is acting:
      `x-lw-actor-email` (required), `x-lw-actor-name` (URI-encoded, optional), `x-lw-actor` (a
      WorkOS user id, optional). By email alone, the person is the Icreon Director whose
      membership carries that address (the address they accepted their invitation with). The
      platform then treats them like anyone signed in: their memberships decide, every call, and
      the record names them. The key reaches the super-admin routes and two reads
      (`GET /playbooks`, `GET /portfolio`), nothing else.
    - Phases: (1) the key; (2) the console's screens, built in `cypher-web`; (3) those pages leave
      the Control Center, and the platform stops taking browser sessions on the super-admin
      routes.

### Row-level security: deferred

Not built, on purpose. Postgres policies keyed on the request's organization only protect anything
when each request runs on its own connection, as a database role that doesn't own the tables, with
the organization set for that transaction. Today:

- every API instance reads all projects through one shared pool (the read models catch up across
  every project, then filter by organization in memory);
- the worker, the demo runner and the scheduled calls work across organizations by design;
- the API connects as the tables' owner, which policies don't bind.

What it takes: a second database role for the API, a connection (and transaction) per request with
`set_config('lw.org', …)`, read models built per organization instead of across all, and the
system paths (worker, cron, migrations) kept on the owner role. That is a restructuring of the data
layer, best done as its own piece of work before the first customer whose contract asks for
database-level isolation. Until then, isolation rests on the single API checks (organization scope,
project ownership, allowlists), which the tests cover.
