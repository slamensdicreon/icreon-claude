# Deploying Launchworks on Vercel

_Status: deployed as project `launchworks` (https://launchworks-one.vercel.app), running real
projects on Temporal Cloud with GitHub sign-in, Neon and Blob. Services, Daemons and the container
runtime are in beta on Vercel._

Everything runs in one Vercel project, on one domain:

| Unit     | Vercel primitive                        | Source                              | What it does                                                                 |
| -------- | --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `web`    | Service: static Vite build on the CDN   | `apps/web`                          | The Control Center. Every path that isn't the API.                          |
| `api`    | Service: Function from a container image | `Dockerfile.api` → `apps/control-api` | `/projects/*`, `/intake/*`, `/integrations/*`, `/auth/*`, `/health`: snapshots, commands, event streams, intake, the GitHub App, sign-in |
| `demo`   | Daemon, not deployed on production       | `Dockerfile.api` → `src/demo-runner.ts` | Plays the scripted demo project (Ansell) and runs Director commands for it  |
| `worker` | Daemon, 0 instances until real mode     | `Dockerfile.worker` → `apps/worker` | Temporal workflows and activities, tool servers, Chromium                    |

Outside the project: **Neon Postgres** (Vercel Marketplace) holds the event log and the command
queue, a **private Vercel Blob** store holds artifacts and screenshots, **Temporal Cloud** runs the
workflows in real mode, and a **GitHub OAuth app** signs operators in.

```
browser ──► vercel.json rewrites ──┬─► web (static)
                                   └─► api (Function) ──► Neon ◄── demo (Daemon)
                                            │   │                ◄── worker (Daemon) ──► Temporal Cloud
                                            │   └──► Blob ◄──────────┘
                                            └──► Temporal Cloud (real mode: start projects, send commands)
```

## Why it's shaped this way

The API used to be one long-running process: it folded every project into memory at start, held a
Postgres LISTEN connection for the live tail, kept event streams open indefinitely, and (in demo
mode) ran the demo's timers in-process. A Vercel Function is paused between requests and stopped at
its time limit (300 s by default), so:

- **Read models catch up on request.** Before any `/projects/:id/...` handler, the API reads the log
  past its read model's seq (`Projections.catchUp`). Instances fold a project on first use
  (`PROJECTIONS=lazy`) and don't hold a LISTEN socket that could go stale while paused
  (`LISTEN=false`).
- **Event streams poll and end on schedule.** The stream reads the log every second and closes with
  a `bye` event after 240 s; the browser reopens it from the last seq without showing
  "Reconnecting". A reseeded log sends `reset` so the browser refetches.
- **Anything continuous runs in a Daemon.** The demo runner and the Temporal worker hold state and
  timers, so they are long-lived containers. The API reaches the demo runner through a command
  queue in Postgres (`lw_commands`); in real mode it reaches the worker through Temporal.
- **Migrations take turns.** Every cold start runs the idempotent migrations under an advisory lock,
  because instances starting together would otherwise collide.

The same images run locally with `docker compose up` (below), which is how this setup was tested.

## Modes

|                    | Demo (default)                       | Real                                                   |
| ------------------ | ------------------------------------ | ------------------------------------------------------ |
| `ORCHESTRATOR`     | `simulator`                          | `temporal`                                             |
| `demo` instances   | 1                                    | 0, or 1 to keep the demo beside real projects          |
| `worker` instances | 0                                    | 1 or more                                              |
| Needs              | Neon, Blob, GitHub OAuth             | also Temporal Cloud; `ANTHROPIC_API_KEY` for live agents |

The two can run side by side: with `ORCHESTRATOR=temporal` and a `demo` daemon, the demo project
plays in the demo runner while projects from the New Project wizard run on Temporal. Production runs
real projects only (`launchworks.dxmpr` on Temporal Cloud, `AGENTS=claude`): the `demo` daemon was
removed from `vercel.json` and the demo data deleted. To bring the demo back, add the daemon again:

```json
"demo": {
  "root": "./",
  "entrypoint": "Dockerfile.api",
  "command": ["node", "--import", "tsx", "src/demo-runner.ts"],
  "instances": { "iad1": 1 },
  "resources": { "requests": { "memory": "1Gi" } }
}
```

Instance counts live in `vercel.json` (`daemons.*.instances`); you can also override them from the
dashboard without a deployment. Overrides persist across deployments until cleared.

## One-time setup

1. **Project.** Import the repository in Vercel. Keep **Root Directory** at the repository root:
   daemons can't be added to a project whose root is a subfolder. Vercel reads `vercel.json` and
   finds the two services and two daemons.
2. **Postgres.** Add Neon from the Marketplace in the same region as the functions (`iad1`,
   Washington D.C.; Neon `aws-us-east-1`) and connect it to Production. It sets `DATABASE_URL`
   (pooled) and `DATABASE_URL_UNPOOLED` (direct; the daemons use it for LISTEN and the runner
   lock). Tables are created on first start.
3. **Blob.** Create a **private** Blob store and connect it to the project. Create a read-write token
   and set it as `BLOB_READ_WRITE_TOKEN` for the project: the daemons need it, and it also works in
   the Function. (Functions can use OIDC with `BLOB_STORE_ID` instead.)
4. **Sign-in.** Create a GitHub OAuth app with callback `https://<production domain>/auth/callback`
   and set the sign-in variables below. The API refuses to start on Vercel without sign-in.
5. **Real mode only.** Create a Temporal Cloud namespace in `aws-us-east-1` with an API key, set the
   Temporal variables, set `ORCHESTRATOR=temporal`, then scale `worker` to 1 and `demo` to 0.
6. **Deploy** to production. Daemons start only for production deployments.

## Environment variables

Set them in the project's settings. Variables the images already default are in
`Dockerfile.api` / `Dockerfile.worker`; project variables override them.

| Variable                                   | Used by           | Value                                                                  |
| ------------------------------------------ | ----------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED`    | api, demo, worker | From the Neon integration                                              |
| `BLOB_READ_WRITE_TOKEN`                    | api, demo, worker | The private store's read-write token                                   |
| `AUTH`                                     | api               | `github`                                                               |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | api               | The OAuth app                                                          |
| `OPERATORS`                                | api               | Comma-separated GitHub logins allowed in                               |
| `OPERATOR_API_KEYS`                        | api               | `login:sha256` pairs (comma-separated): API keys for scripts and agents acting as an operator; only the key hashes are stored|
| `GITHUB_ORG`                               | api               | Optional: also require active membership of this org                   |
| `SESSION_SECRET`                           | api               | 32+ random characters (`openssl rand -hex 32`)                         |
| `CREDENTIALS_KEY`                          | api, worker       | 32 random bytes, base64 (`openssl rand -base64 32`). Seals project credentials (Sitecore clients, Edge Context IDs, the GitHub App's keys) in Postgres. The worker opens them for tool calls; without it no tool that needs a project credential connects |
| `CREDENTIALS_KEY_PREVIOUS`                 | api, worker       | Optional: the old key during a rotation, so secrets it sealed still open |
| `PUBLIC_URL`, `APP_URL`                    | api               | Optional: default to `https://$VERCEL_PROJECT_PRODUCTION_URL`. Set both to the custom domain if the project has several |
| `GITHUB_APP_ORG`                           | api               | Optional: create the GitHub App under this organization instead of the operator's own account |
| `ORCHESTRATOR`                             | api               | `simulator` (default) or `temporal`                                    |
| `SIM_SPEED`                                | demo              | Optional: demo clock multiplier (default 1)                            |
| `TEMPORAL_ADDRESS`                         | api, worker       | Real mode: e.g. `us-east-1.aws.api.temporal.io:7233`                   |
| `TEMPORAL_NAMESPACE`                       | api, worker       | Real mode: `<namespace>.<account>`                                     |
| `TEMPORAL_API_KEY`                         | api, worker       | Real mode: connects over TLS with the key                              |
| `AGENTS`, `ANTHROPIC_API_KEY`              | worker            | Real mode: `AGENTS=claude` runs roles whose tools are connected on Claude |
| `DIRECTOR_WEBHOOK_URL`                     | worker            | Optional: a Slack-style incoming webhook (receives `{ text }`). The operator posts there, as well as in the project, when a card no Lead could settle waits on the Director or nothing has moved for 30 minutes |
| `OPERATOR_MINUTES`                         | worker            | Optional: how often the operator looks at the projects (default 5) |
| `WORKER_SHUTDOWN_GRACE_SECONDS`            | worker            | Optional (default 240): how long activities get to finish after SIGTERM. Keep it plus 30 under the daemon's `terminationGracePeriodSeconds` (300 in `vercel.json`); see [Deploying while projects run](#deploying-while-projects-run) |

Leave "Automatically expose System Environment Variables" on: the API reads
`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` and `VERCEL_BRANCH_URL` for its URLs and allowed
origins.

## Checking a deployment

1. `https://<domain>/health` answers `{"ok":true}` (no sign-in needed).
2. Open the domain and sign in with GitHub. With no projects yet, the page offers the New Project
   wizard and the GitHub App panel.
3. The `worker` daemon's log shows "Temporal: connected to …" and each Claude model as ok.
4. Leave a page open for five minutes: Activity keeps updating across the stream's scheduled
   reconnects, with no "Reconnecting" note.

## Project credentials

The New Project wizard collects each project's SitecoreAI environment automation client (required),
an organization client (optional, for the Deploy API) and Experience Edge Context IDs. Each is
tested against Sitecore before anything is stored: a token from `auth.sitecorecloud.io`, the
Authoring API's site list on the CM host, a site query through Edge. The API then seals them with
AES-256-GCM under `CREDENTIALS_KEY` in the `lw_secrets` table. The event log, Activity and Settings
only ever see a reference and the last four characters. The API calls only `https://` CM hosts
under `.sitecorecloud.io`.

Keep `CREDENTIALS_KEY` only in Vercel (Sensitive). Losing it makes the stored secrets unreadable;
the fix is to re-enter them. To rotate it, set the new key, move the old one to
`CREDENTIALS_KEY_PREVIOUS`, redeploy, and re-enter credentials when convenient.

## Repository access: the GitHub App

Agents reach client repositories through one Launchworks GitHub App, shared by every project. It
is created from **Settings → GitHub App → Create on GitHub** with GitHub's manifest flow: the
browser posts the app's definition to GitHub, the operator confirms it there, and GitHub sends a
one-time code back to `/integrations/github/callback`. The API trades the code for the app's
private key, client secret and webhook secret, seals them in the vault (project `__system__`) and
keeps the app's details in `lw_integrations`. Nothing is pasted by hand, and the callback only
works for a signed-in operator with the state the API issued an hour or less earlier.

The app is public (installable by any account, listed nowhere) and asks for: contents and pull
requests (write); checks, statuses, Actions and metadata (read). It has no webhook. Each client
installs it from the install link in Settings, choosing only the repository being migrated;
GitHub then shows them `/integrations/github/installed`, the one page that needs no sign-in.

The wizard's Source step checks access: it finds the installation on the repository, takes an
installation token limited to that one repository, and reads the repository and branch. Intake
records the outcome as the project's `github` credential (`github-app:installation/<id>`, or the
reason it isn't reachable yet); **Check again** in the project's Settings picks up a later
installation. The app is only offered where `CREDENTIALS_KEY` is set, since GitHub hands its keys
over once.

## What agents are connected to

Real projects never run on stand-in agents. Each specialist role runs on Claude only when every
operation it is granted is served by a connected tool server; otherwise its tasks block with a
"Not connected" card naming what is missing, and nothing is recorded as done.

| Tool server          | Backed by                                                         | Roles it completes (with the rest) |
| -------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| `browser`, `validators` | Chromium in the worker, limited to the project's source host (and its www form) | Content Analyst, QA roles |
| `artifacts`, `blackboard`, `decision-log` | The event log and Blob                     | Everyone who writes documents       |
| `github`             | The Launchworks GitHub App: an installation token for the project's one repository; commits only to `launchworks/*` branches | Repo Analyst, Tenant Provisioner |
| `sitecore-authoring` | The project's environment automation client, on its CM host's Authoring and Management GraphQL API | Tenant Provisioner, Content Migrator, Media Migrator, Experience Enabler |
| `research`           | Claude's server-side web search and web fetch (`ANTHROPIC_API_KEY`) | Research Agent |

Not connected yet, so the roles that need them block: `sandbox` (building and running the client's
code), `sitecore-cli` (serialization, needs .NET in the worker), `hosting` (the client's Vercel
project needs its own token) and `sitecore-deploy` (the Deploy API). The worker logs
`Connected tool servers: …` and `Live agents: …` at start.

`site.verify` confirms the project's site exists (a read); sites themselves are created in SitecoreAI Sites.

## Resetting a project

**Settings → Danger zone → Reset** (type the project name) takes a real project back to intake: the
API terminates its Temporal workflow, deletes its events after intake and its Blob files, and keeps
the intake facts, credentials (and their checks) and the source site. **Start** on Mission Control
runs it again from phase 0.

## Deploying while projects run

Push at any time; nothing needs pausing. Every deployment replaces the `worker` daemon, and agent
sessions (often several minutes, sometimes far longer) carry on across it:

1. Vercel sends the old worker SIGTERM. It stops taking tasks from Temporal and tells every
   agent session in it to stop after its turn in progress.
2. Each session finishes that turn (the model's reply and the tool calls it asked for), saves
   it, and hands over: its activity fails with a retryable `WorkerShutdown`, and Temporal retries
   it a second later.
3. The new deployment's worker picks the retry up and carries the session on from the turn it
   saved, with the same conversation, step count and spend. Nothing is redone, and the handoff
   spends none of the task's attempts and raises no card. The task's log shows "Resumed after
   turn N".
4. Other activities in flight get `WORKER_SHUTDOWN_GRACE_SECONDS` (240) to finish. At the end
   of it, a session still mid-turn (a long build, say) is cancelled: it hands over too, and the
   next worker redoes that one turn. 30 s later the old worker exits, before Vercel's
   `terminationGracePeriodSeconds` (300) runs out.

How it works: after every completed turn the session's new messages go to the Blob store
(`sessions/<task>/<attempt>/` under the project; deleted when the session ends), and the
activity's heartbeat carries where they are. Temporal hands the last heartbeat to the next
attempt. The activity counts attempts by how the earlier ones ended: an error of the session's own
starts it over and the third ends it, as before; a worker that vanished without handing over (a
crash, or killed before its turn finished) resumes it, and the third such loss ends it; a handoff
is free (Temporal's limit of 25 attempts is only a backstop).

What a deploy can still cost:

- **The turn in progress, if the worker dies or is killed mid-turn.** The next attempt redoes it,
  so a tool call made in that turn may run again (the agent sees the item already exists, or
  reads before writing again). Its tokens are spent twice and counted in the budget once.
- **A few more turns after a crash.** Heartbeats reach Temporal within 5 s of a turn; a worker
  that dies in that window resumes one turn earlier. A crash is noticed after the 5-minute
  heartbeat timeout.
- **Other activities cut off at the grace period** (a Lead review, a check run) start over on the
  next worker, as before, and spend one of their three attempts.
- If Vercel stopped the daemon sooner than `terminationGracePeriodSeconds` (Daemons are in beta,
  and these docs don't confirm how it treats the setting), sessions mid-turn are lost as in a
  crash: each resumes from its last turn after the heartbeat timeout.

## Behaviour to know about

- **Previews** get `web` and `api` but no daemons (a beta limit). If previews share the production
  database, they show the live demo and their commands reach the production runner. With a Neon
  branch per preview, they show a frozen copy and commands answer "runner unavailable".
- **Sign-in on previews.** The OAuth callback is the production domain, and the session cookie
  belongs to it, so sign-in works on production only. For a signed-in preview, alias a branch
  domain, register a second OAuth app for it, and set that preview's `PUBLIC_URL`/`APP_URL`.
- **The demo restarts on deploy** (where the `demo` daemon runs). Each deployment rolls out a new
  `demo` instance, which reseeds the demo project to the prototype's story and deletes retired demo
  projects; open pages follow along. A second runner waits on the advisory lock until the old one
  exits, so two never play at once.
- **Cold starts.** The API image is about 1 GB, mostly packages only the local inline worker needs
  (`@temporalio/worker`, the tool servers). Splitting the orchestrator's Temporal client from its
  worker would cut the API image to a fraction; that's the next improvement to make.
- **Rollback.** Instant Rollback moves the services and rolls the daemons to the previous
  deployment's images. The event log is append-only, so rolling back code never loses data.

## Running the deployed topology locally

```bash
docker compose up --build        # Postgres, the API image and the demo runner, from Dockerfile.api
pnpm --filter @lw/web dev        # the Control Center on http://localhost:5173, proxied to :4000
```

Blobs go to a shared volume instead of Vercel Blob, and the API runs without sign-in on a port
published to 127.0.0.1 only (`INSECURE_NO_AUTH=true`, never set on Vercel). The worker image is
built with `docker build -f Dockerfile.worker .`; run it against a Temporal dev server with
`TEMPORAL_ADDRESS` and `DATABASE_URL` set.
