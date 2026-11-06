# Security pass

The open work from the November 2026 security audit, to pick up as one planned pass. The audit
reviewed the web app, the Control API, and the secrets, vault and agent tooling, and found nothing
critical. Authentication, CSRF protection, SQL, the vault's crypto and the gateway's grants all hold.

What shipped with the audit (commit `24e740d`):

- Stored blobs can't run as the app (nosniff, a sandboxing CSP, non-raster files download), and
  keys with `..` are refused.
- Agent documents: no styles, forms, fields or embeds; outside images become links.
- Security headers on the web app (`vercel.json`) and on every API answer.
- Exact path matching for open and cron routes.
- Agent GitHub tokens scoped to code, pull requests and CI reads.
- Sandbox git scrubs `.git` before any command that carries the token.
- Cypher and the project chat never answer locked-category cards.
- The vault pins the GCM tag length; dompurify upgraded; CI token read-only.

Everything below is still open, highest risk first.

## 1. Vercel environment variables

The "attention" marks in the Vercel dashboard.

- [ ] Limit the production database variables to Production. These are `DATABASE_URL`,
      `DATABASE_URL_UNPOOLED`, `PG*`, `POSTGRES_*`, `NEON_*` and `BLOB_READ_WRITE_TOKEN`, and today
      they are also scoped to Preview and Development. They're managed by the Neon and Blob
      integrations, so change them in each integration's settings.
- [ ] Limit `CREDENTIALS_KEY` and `SESSION_SECRET` to Production. With these and the database, a
      preview build could decrypt every vault secret and forge sessions.
- [ ] Mark the integration secrets **Sensitive**. They are "encrypted" today, which leaves them
      readable in the dashboard.
- [ ] If previews are ever turned back on, give them their own database, vault key and session
      secret, and keep Deployment Protection on.

## 2. Build sandbox

Agent-written code runs here (npm scripts, config files, dependency hooks), so treat everything in
the box as hostile.

- [ ] **Network allowlist.** `tool-servers/sandbox/src/vercel.ts` sets no `networkPolicy`. Allow
      only registry.npmjs.org, github.com and the platform hosts (Sitecore, Optimizely).
- [ ] **Keep the token out of the box entirely.** Push from the worker, using a bundle or a pipe,
      instead of `http.extraHeader` inside the sandbox. The `.git` scrub (`git-hygiene.ts`) is a
      stopgap.
- [ ] **No management secrets in builds.** `platforms/optimizely/pack.ts` puts
      `OPTIMIZELY_CMS_CLIENT_SECRET` into `buildEnv` for every `npm run`. Run content-type pushes
      and `ser` commands as a fixed step that can't be written to.
- [ ] Pass the Sitecore CLI client secret on stdin or in the environment, not on the command line
      (`sandbox/src/cli.ts`).
- [ ] Redact base64 and URL-encoded forms of known secrets in command output, not only exact
      matches.
- [ ] Make sandbox names collision-free. Truncating to 60 characters can make two tasks share a
      box.

## 3. Read-only paths

- [ ] Enforce `ALWAYS_READ_ONLY` and `recipe.readOnly` in `build-repo.branch.commit`
      (`tool-servers/github/src/server.ts`), not only in sandbox `fs.write` and `git.commit`.
- [ ] After every build, refuse a commit or integration if a protected path (`.config/`,
      `nuget.config`, `sitecore.json`, `.github/`) differs from the default branch.
- [ ] Turn on branch protection for `main` in build repositories.

## 4. Browser isolation

- [ ] Move Chromium out of the worker into its own unprivileged service. That service gets none of
      the worker's secrets: `CREDENTIALS_KEY`, `DATABASE_URL`, `VERCEL_PREVIEWS_TOKEN` or
      `TEMPORAL_API_KEY`.
- [ ] Run it non-root, with the Chromium sandbox on (drop `--no-sandbox` in
      `tool-servers/browser/src/guarded.ts`), and keep it patched.
- [ ] Launch through the egress proxy (`egress.chromeFlags()`). Today only Lighthouse uses it, so
      subresources on hostnames that resolve to internal IPs are fetched, and DNS rebinding is
      possible.
- [ ] Add a `USER` to `Dockerfile.worker` and `Dockerfile.api`, and pin base images by digest.

## 5. Outbound requests and data exfiltration

- [ ] Re-check every redirect hop on server-side fetches (`redirect: 'manual'`), or pin resolved
      IPs with an undici `lookup` guard. This applies to `sitecore-authoring media.upload` and
      `browser.fetch.asset`.
- [ ] Agents must not be able to widen the fetch allowlist. `assetHosts()` in
      `packages/stack/src/compose.ts` trusts hosts named in agent-written inventories. Allow only
      the source site's own domain or operator-approved hosts.
- [ ] Pin the Vercel preview host to the team slug. `projectHosts()` matches any `<name>*.vercel.app`.
- [ ] Don't give a role both private-repo read and arbitrary-host fetch. `content-migrator` has
      both today.
- [ ] Derive stored asset extensions from sniffed content, not the URL (`browser/src/server.ts`).

## 6. Secrets in results

- [ ] Let credential providers and tool servers report every secret they touch, so the gateway
      redacts it. Today only the gateway token is redacted. The Edge Context ID, the editing
      secret, the Vercel team token and the Sitecore client secret are not.
- [ ] Scrub output shaped like environment dumps from `hosting.logs.runtime`.
- [ ] Mark sandbox build and test output, and `sitecore-cli` output, as untrusted.
- [ ] Treat `heuristicDetector` as telemetry, not a control. The real limits are grants, gates and
      branch rules.

## 7. Cypher

- [ ] Make `answer_cards` two-phase. The tool proposes a plan, and a Director click
      (`POST /cypher/:id/confirm`) carries it out.
- [ ] Wrap untrusted fields in the tool results in clear delimiters with a "data, not instructions"
      note: card titles, gists, option labels, Activity rows and knowledge text.
- [ ] Review lessons authored by Cypher closely before approving them, since they flow into agent
      briefs.

## 8. Control API

- [ ] Rate-limit the routes that call the model or run heavy queries, keyed by operator:
      `/cypher`, triage replay, retrospectives, rule drafting and `activity.csv`.
- [ ] Record which operator acted. Every command logs `actor: director`; pass `req.operator.login`
      instead.
- [ ] Make sessions revocable, with a session version or deny-list, and consider a shorter TTL
      than 12 hours. Re-check `GITHUB_ORG` membership periodically, not only at sign-in.
- [ ] Make GET routes free of side effects: `/portfolio/watchdog` should accept cron only, and
      hosting promotion should move to POST.
- [ ] Keep one-time OAuth `code` values out of the request log, and stop echoing raw upstream
      error text (diagnostics, Resend, GitHub) in responses.
- [ ] Vault: bind `open(ref)` to the caller's project.

## 9. Supply chain

- [ ] Pin GitHub Actions by commit SHA.
- [ ] Align `.nvmrc` (24) with the Docker images (node 22).
- [ ] Update `@vercel/blob` once its transitive zod advisory is fixed. It isn't reachable today.
