# The admin console's API

Icreon's `/admin` (in the `cypher-web` repository) administers Launchworks by calling the platform's
admin routes server to server. This is the contract. The platform side is
`apps/control-api/src/auth.ts` (the key and the acting person), `admin.ts`, `licenses.ts` and the
routes in `app.ts` named below. Tests: `apps/control-api/test/workos.test.ts`, "the admin console".

## Calling it

- **Base URL:** `https://launchworks-one.vercel.app` (the API answers on the same origin as the
  Control Center; `vercel.json` routes these paths to it).
- **Key:** the platform reads `ADMIN_CONSOLE_KEY` (32+ characters). The console sends
  `Authorization: Bearer <key>`, from its server only. Unset means off: every call answers 401.
- **Who is acting**, on every call:
  - `x-lw-actor-email`: required. The address the console's own sign-in verified.
  - `x-lw-actor-name`: optional, `encodeURIComponent`-ed, up to 120 characters. Shown in records.
  - `x-lw-actor`: optional, a WorkOS user id (`user_…`). The console doesn't need it.
- **Organization:** send `x-lw-organization: org-icreon`. The admin routes act from Icreon.
- **The person must be an Icreon Director.** By email alone, they are the member of Icreon whose
  membership carries that address: the address they accepted their Launchworks invitation with,
  shown in People. Then their memberships decide on every call, like anyone signed in, and every
  record names them. Removing someone from Icreon in People removes their console access at once.
- `GET /admin/me` answers `{ subject, login, name, superAdmin: true }` for an Icreon Director. Use
  it at the console's sign-in to decide who gets in.
- **Errors** are `{ "error": { "code": string, "message": string } }`. The message is written for
  people and can be shown as is.

| Status | Code                  | Meaning                                                                |
| ------ | --------------------- | ---------------------------------------------------------------------- |
| 400    | `no_actor`            | `x-lw-actor-email` missing or malformed                                |
| 401    | `unauthenticated`     | Wrong key, or the key isn't set on the platform                        |
| 403    | `not_icreon_director` | Nobody among Icreon's Directors has that email                         |
| 403    | `not_a_member`        | The person isn't in the organization named by `x-lw-organization`      |
| 403    | `super_admin_only`    | The person is in Icreon, but not as a Director                         |
| 403    | `console_only`        | The key doesn't reach this route (see below)                           |
| 404    | `unknown_…`           | No such organization, rule, entry or playbook                          |
| 409    | various               | A rule of the product: e.g. `icreon` (Icreon needs no license)         |
| 422    | `invalid`             | The input broke a rule; the message says which (zod errors are 400s)   |

**What the key reaches:** the super-admin routes (`SUPER_ADMIN_ROUTES` in
`apps/control-api/src/organizations.ts`), plus `GET /playbooks` and `GET /portfolio`. Nothing else.

## Organizations

`GET /admin/organizations` returns every organization, as an array of:

```ts
{
  id; name; slug; createdAt;
  directors: number; watchers: number; invitations: number;  // open invitations
  projects: number;   // live projects
  running: number;
  usage: { usd; tokens; hours; sandboxMinutes };  // Claude spend and sandbox time, live projects
  license: {
    standing: 'unlimited' | 'none' | 'upcoming' | 'active' | 'ended';  // Icreon: 'unlimited'
    used: number;  // projects holding a place
    // When there is a license:
    entities?; playbooks?; projectsIncluded?; startsAt?; endsAt?; purgedAt?: string | null;
  };
}
```

Screen rules (from the Control Center's `apps/web/src/surfaces/manage/Organizations.tsx`):

- **Icreon's own row** (`org-icreon`) has no Manage: it needs no license, and support access to
  itself is refused (`409 icreon`).
- **Standing labels:** No license needed, No license, Starts later, Active, Ended. Add ", data
  purged" when `purgedAt` is set. Show "used of projectsIncluded projects · to endsAt".

`POST /admin/organizations` takes `{ name (2–80), slug? (≤40, else made from the name),
directorEmail? }` and returns `201 { organization, invited: { email, emailSent, detail } | null }`.

- The acting person becomes the new organization's **kickoff Director**. The customer can't remove
  them for 3 months; after that the customer's Directors can.
- `directorEmail` invites the customer's first Director (open 7 days). WorkOS sends the email.
  `emailSent: false` with a `detail` means it didn't send. The invitation still stands: they sign
  in to Launchworks with that address.

## License

`GET /admin/organizations/:id/license` returns
`{ license: Terms & { suspended: { projects: string[] } | null, purgedAt } | null, history: { at, by, kind, license: Terms }[] }`.
`kind` is one of `granted`, `changed`, `suspended` ("Paused projects") or `resumed`. `by` is a
subject (`workos:…`, `github:…`): strip the prefix to show it.

`PUT /admin/organizations/:id/license` takes
`Terms = { entities: string[] (platform ids), playbooks: string[] (playbook ids), projectsIncluded: int ≥ 0, startsAt: ISO, endsAt: ISO }`.
It returns `{ license, reconciled: { action: 'none' | 'suspended' | 'resumed', projects: string[] } }`.

- **The catalog** comes from `GET /playbooks`: each `{ id, name, platform: { id, name }, … }`.
  Group by platform. A playbook counts only on a licensed platform, so drop the others before
  saving (the Control Center does).
- `422 invalid` covers an end before the start, a playbook not on a licensed platform, and similar.
- **This changes live behavior.** Taking out a platform, or ending the term, pauses that
  organization's running projects at once. Renewing resumes exactly the ones the license paused.
  Show the `reconciled` result ("2 project(s) paused: outside the license now"). The Control Center
  defaults a new license to today through a year from today.
- After the term the organization is read only. Export stays open 90 days, then the hourly check
  purges its projects (below).

## Usage

`GET /admin/organizations/:id/usage` returns
`{ organization, totals: { claudeUsd, claudeTokens, sandboxMinutes, toolMinutes, vercelDeployments, vercelBuildMinutes }, projects: [...], cachedForMinutes: 15 }`.
Each project is
`{ projectId, name, status, claude: { usd, tokens, hours }, toolMinutes: { [toolServer]: minutes }, vercel: { hostingProject, deployments, failed, buildMinutes }, vercelNote: string | null }`.

- Vercel's answers are cached 15 minutes per hosting project, in the API's memory.
- `vercelNote` explains a row with no build figures: "No hosting project", "Vercel not connected
  here", "Not in our Vercel team yet", or Vercel's error. Show it instead of zeros.
- Tool minutes count from 2026-11-13 only: earlier steps weren't timed. Vercel gives no bandwidth
  or function time per project, so neither is reported.

## Support access

`POST /admin/organizations/:id/support` takes
`{ hours: int 1–72 (default 4), role: 'watcher' | 'director' (default 'watcher') }` and returns
`{ organization, role, expiresAt }`.

- It makes the **acting person** a member of that organization until `expiresAt`, in that role.
  The organization's Directors see it in their People, with when it ends, and it ends on its own.
- `409 already_member` means they're already a permanent member. `409 icreon` means it's Icreon.
- **Using the access happens in the Control Center.** The person signs in to Launchworks as
  themselves and picks the organization in the account menu. The console can only grant it; link
  to the Control Center after.

## The other Icreon-only pages

The Control Center sources are in `apps/web/src/surfaces/manage/`. Bodies are in
`packages/contracts/src/commands.ts`.

**Settings: the GitHub App** (`apps/web/src/surfaces/settings/AccessSections.tsx`,
`GithubAppPanel`)

- `GET /integrations/github` returns its status.
- `POST /integrations/github/manifest { name? }` starts creating the app.
- `GET /integrations/github/callback` is where GitHub sends the browser back. **This can't work
  through the console as is:** GitHub redirects a browser to the platform, and the console's key
  isn't a browser session. It's a one-time setup that's already done. Leave it in the Control
  Center, or ask for a console-shaped flow.

**In force** (`InForce.tsx`)

- `GET /playbooks/:id/in-force` returns what a new project on that playbook starts with: rules,
  lessons, procedures and known gaps. Read only.

**Rules** (`Rules.tsx`). These are how the Leads answer cards on their own.

- `GET /rules?status=proposed|active|retired`
- `POST /rules` (`CreateRule`)
- `PUT /rules/:id` (`EditRule`)
- `POST /rules/:id/activate` and `POST /rules/:id/retire`
- `GET /rules/:id/history`
- `POST /projects/:id/rules/harvest` drafts proposed rules from a project's answered cards.
  **Live:** an active rule answers matching cards in every customer's projects, without a person.
  Activating, editing an active rule, and retiring all change what running projects do next.

**Knowledge** (`Knowledge.tsx`, `ProposalReview.tsx`, `EntryCard.tsx`). Lessons, procedures and
gaps that every new build on a playbook starts with.

- `GET /knowledge?status&kind&q`
- `POST /knowledge` (`CreateKnowledge`)
- `PUT /knowledge/:id` (`EditKnowledge`)
- `POST /knowledge/:id/approve|activate|reject|retire`
- `GET /knowledge/:id/history`
- `GET /knowledge/export?platform=` returns a download.
- `POST /proposals/sort` returns Cypher's recommendation on every waiting proposal. It calls Claude
  (costs money, slow).
- `POST /proposals/apply` takes `ApplyProposals`: decisions `{ kind: 'knowledge' | 'rule', id,
  action: approve | edit | reject, edit? }`, applied together.
- **Live:** approved entries and rules shape every future build on their scope.

**Diagnostics** (`Diagnostics.tsx`)

- `GET /portfolio/diagnostics` returns the services and each project's orchestrator.
- `POST /projects/:id/operator/test-email` emails the Operator's notice for a project. **It sends
  a real email.**
- `GET /portfolio/watchdog` **runs** the watchdog: it nudges stuck projects. It's a GET with
  effects; call it only from a button.

**Never call casually:** `GET /portfolio/licenses` **runs** the hourly license check. It pauses
and resumes projects, and purges organizations whose export window has closed. It is for the
scheduled job, or a deliberate button.

**Inside one project:** `/projects/:id/lessons`, `retrospectives`, `scenarios`, `triage/replay`,
`diagnostics` and `escalations/:escalationId/rule-draft`. These are Icreon-only tools on a single
project's pages in the Control Center. They act on one project's live run.

## Known gaps

- **Customer projects through the console.** Project routes (`/projects/:id/...`) answer only for
  projects of the organization named by `x-lw-organization`. Through the console that is Icreon,
  so a customer's project answers 404 (the harvest, test email, a project's diagnostics), and
  `GET /portfolio` lists only Icreon's projects. If the console needs these for customers, the
  platform needs a console-wide read: ask.
- **Phase 3 is the platform's to do:** remove these pages from the Control Center and stop
  browser sessions on the super-admin routes. It waits until the console's screens are live, so
  there's never a moment with no admin.
- **Row-level security** in Postgres is deferred. Isolation is enforced in the API (organization
  scope on every route). The design is in `multi-tenancy.md`.
- **Moving a customer's repository and Vercel project** to their own accounts at the end is still
  done by hand.
