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
| Kickoff             | Every customer starts with an Icreon Director, who is a member of the customer's organization for 3 months and can't be removed by the customer.             |
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

An organization holds one license per entity it is on. Most hold one. Each license says:

- **The entity** (SitecoreAI, Optimizely, …). Every playbook and connection used under the license
  is on that entity.
- **Active playbook slots.** How many playbooks can be active at once. The starting license has 1;
  an organization that buys every playbook on the entity has them all active.
- **Projects.** How many projects can exist at once. The starting license includes 1; each further
  project is bought (for example, 1 entity, 1 playbook, 10 projects).
- **Playbook switches.** 3 per license year.
- **Term.** Start and end dates.

```
License
  organizationId
  entity              'sitecoreai'
  playbookSlots       2              // or 'all'
  activePlaybooks     ['sitecoreai-migration', 'sitecoreai-homepage-demo']
  projectsIncluded    10
  switchesPerYear     3
  startsAt, endsAt
```

### Rules the server enforces

Every rule is checked by the Control API. Hiding something in the Control Center is never the
only guard.

- **Creating a project** needs a license in its term on the project's entity, an active playbook,
  and fewer existing projects than `projectsIncluded`.
- **Deleting a project gives its slot back** as soon as the deletion is requested. Restoring it
  during the deletion grace period (`DELETE_GRACE_DAYS`) needs a free slot. An archived project
  keeps its slot.
- **Switching playbooks.** A Director, in the Control Center, replaces one active playbook with
  another on the same entity. That is one switch; the organization has 3 per license year, counted
  from `startsAt`, and unused switches don't carry over. The Control Center shows how many are left.
  A switch affects only new projects: a project already running on the playbook switched out
  continues to completion.
- **The catalog** shows active playbooks as available, other playbooks on the entity as "switch
  to" (while switches remain) or "upgrade", and nothing from unlicensed entities.
- **Entities are Icreon's to change.** Only a super admin, in `/admin`, adds an entity (a second
  license) or moves a license to another entity when the customer changes platforms. Projects on
  the entity left behind are treated like an ended license.
- **When the term ends**, a scheduled check (the existing cron path pattern) pauses every running
  workflow and marks the license's projects read-only. Everyone can still sign in and read; no
  command is accepted. Export stays available for 90 days. Renewal resumes the paused projects
  where they stopped.
- **Every change to a license** (granted, playbook switched, projects added, entity changed,
  ended) is an event, so there is an audit trail for billing disputes.

### Usage to meter

Licensing counts projects, not usage, but Icreon pays for the usage. Record it per organization
and per project from the start, even before any limit uses it: Claude tokens (the agent runtime
already tracks budgets), Vercel builds and bandwidth, and sandbox time. This tells us what a
project costs us, and is how we will find out if one license is unprofitable.

## Organizations and isolation

- Every project, event, sealed credential, saved connection, blob and setting gets an
  `organizationId`. Today none of them carries one, and the portfolio lists every project.
- The event store is the hard part: every existing event needs the field, and the projections
  and the `LISTEN/NOTIFY` live tail must filter by it. The current projects become
  organization #1 (Icreon) in one migration.
- **Postgres row-level security** on every table, keyed on the organization set for each
  connection. A query that forgets its filter returns nothing instead of another customer's data.
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
its licenses and usage, swapping playbooks or entities, and diagnostics. Whatever role someone
holds inside an organization, it never opens `/admin`.

| Role                   | Who                                    | Can                                                                                                                                       |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Super admin**        | Icreon staff                           | `/admin`: every organization, licenses, entities, playbook swaps, usage, diagnostics. Not inside projects, except through a logged, time-limited support grant. |
| **Director**           | Icreon's kickoff Director; client DIDs | Everything inside the organization: intake, commands, cards and gates, connections, invites, playbook switching, export, delete.          |
| **Watcher**            | Client stakeholders                    | See everything about progress (plans, status, the agent view, cards, documents, the scorecard). Change nothing.                          |

Roles are stored in our database as permission sets, not in Auth0, so we can add a role (a client
approver who answers only some cards is the likely next one) or grant a role on a single project
without a rewrite. Auth0 holds identity, organization membership and invitations.

### The Icreon kickoff Director

The kickoff Director's membership carries an end date 3 months after the organization starts.
Until then the customer can't remove them or lower their role; the API refuses it. On that date
the membership ends on its own. Icreon can extend it in `/admin`.

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
the name, and make the playbook validator refuse client names so new ones can't land.

## Order of work

1. Remove client names from the playbooks; validator check.
2. Organizations, memberships and roles in the data model, row-level security, today's projects as
   organization #1.
3. Roles enforced in the API; Watcher with the read allowlist and redaction.
4. Auth0 sign-in, invitations, organization switcher.
5. Licenses: entity, playbook slots, project count, term; the catalog filtered by them;
   the end-of-term pause.
6. Hosting per organization: prefixed names, usage recorded per organization.
7. Onboarding: connection step with the hand-off to the client's admin.
8. Export.
9. `/admin` (Icreon only): organizations, licenses, entity changes, playbook swaps, usage,
   diagnostics, support grants.

## Open questions

- When a customer changes platforms, do projects on the old entity become read-only (as written
  above), or carry on until they finish?
