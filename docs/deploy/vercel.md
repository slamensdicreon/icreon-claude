# Deploying Launchworks on Vercel

_Status: deployed as project `launchworks` (https://launchworks-one.vercel.app). The web app, both
daemon images, the demo runner, Neon and Blob are verified on Vercel; the API waits on the GitHub
OAuth app. Services, Daemons and the container runtime are in beta on Vercel._

Everything runs in one Vercel project, on one domain:

| Unit     | Vercel primitive                        | Source                              | What it does                                                                 |
| -------- | --------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `web`    | Service: static Vite build on the CDN   | `apps/web`                          | The Control Center. Every path that isn't the API.                          |
| `api`    | Service: Function from a container image | `Dockerfile.api` → `apps/control-api` | `/projects/*`, `/intake/*`, `/auth/*`, `/health`: snapshots, commands, event streams, intake, sign-in |
| `demo`   | Daemon, 1 instance                      | `Dockerfile.api` → `src/demo-runner.ts` | Plays the two prototype projects and runs Director commands for them         |
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

The two run side by side: with `ORCHESTRATOR=temporal` and the `demo` daemon still at 1, the demo
projects keep playing in the demo runner while projects from the New Project wizard run on Temporal.
Set `demo` to 0 to retire the demo. The production deployment runs both (`launchworks.dxmpr` on
Temporal Cloud, `AGENTS=claude`).

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
| `GITHUB_ORG`                               | api               | Optional: also require active membership of this org                   |
| `SESSION_SECRET`                           | api               | 32+ random characters (`openssl rand -hex 32`)                         |
| `CREDENTIALS_KEY`                          | api, worker       | 32 random bytes, base64 (`openssl rand -base64 32`). Seals project credentials (Sitecore clients, Edge Context IDs) in Postgres. Without it the wizard checks credentials but won't store them |
| `CREDENTIALS_KEY_PREVIOUS`                 | api, worker       | Optional: the old key during a rotation, so secrets it sealed still open |
| `PUBLIC_URL`, `APP_URL`                    | api               | Optional: default to `https://$VERCEL_PROJECT_PRODUCTION_URL`. Set both to the custom domain if the project has several |
| `ORCHESTRATOR`                             | api               | `simulator` (default) or `temporal`                                    |
| `SIM_SPEED`                                | demo              | Optional: demo clock multiplier (default 1)                            |
| `TEMPORAL_ADDRESS`                         | api, worker       | Real mode: e.g. `us-east-1.aws.api.temporal.io:7233`                   |
| `TEMPORAL_NAMESPACE`                       | api, worker       | Real mode: `<namespace>.<account>`                                     |
| `TEMPORAL_API_KEY`                         | api, worker       | Real mode: connects over TLS with the key                              |
| `AGENTS`, `ANTHROPIC_API_KEY`              | worker            | Real mode: `AGENTS=claude` runs roles whose tools are connected on Claude |

Leave "Automatically expose System Environment Variables" on: the API reads
`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` and `VERCEL_BRANCH_URL` for its URLs and allowed
origins.

## Checking a deployment

1. `https://<domain>/health` answers `{"ok":true}` (no sign-in needed).
2. Open the domain, sign in with GitHub, and see both demo projects in the switcher.
3. Choose an option on a decision card: it resolves within a second, which shows the command queue
   and the demo daemon are working. If it answers "The project runner did not pick up the command",
   check the `demo` daemon's logs.
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

## Behaviour to know about

- **Previews** get `web` and `api` but no daemons (a beta limit). If previews share the production
  database, they show the live demo and their commands reach the production runner. With a Neon
  branch per preview, they show a frozen copy and commands answer "runner unavailable".
- **Sign-in on previews.** The OAuth callback is the production domain, and the session cookie
  belongs to it, so sign-in works on production only. For a signed-in preview, alias a branch
  domain, register a second OAuth app for it, and set that preview's `PUBLIC_URL`/`APP_URL`.
- **The demo restarts on deploy.** Each production deployment rolls out a new `demo` instance,
  which reseeds the two demo projects to the prototype's story; open pages follow along. A second
  runner waits on the advisory lock until the old one exits, so two never play at once. Projects
  started from intake in demo mode stop when the runner restarts.
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
