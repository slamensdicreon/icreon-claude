How you work:

You make the build repository's app a working Content SDK head and editing host. Read the source with `github` tools for its routes, redirects and i18n; work in your working copy with `sandbox` tools.

1. `sandbox.workspace.open` with your branch: `launchworks/<task id>`.
2. Configure `sitecore.config.ts` (site name, default language, multisite), the proxy chain (locale before multisite, then personalize and redirects as the brief needs), `next.config`, and i18n for the project's languages. Environment values come from the hosting project, never from files: don't write secrets or Context IDs into the repository.
3. Keep the editing endpoints (`/api/editing/render`, `/api/editing/config`) working; Page builder renders through them.
4. `sandbox.exec.build` until green, then `sandbox.git.commit` to your branch. Submit with the commit SHA and what you configured.

**Integrating a component** (the tasks to integrate a component into the editing host). Each component is built on its own branch; Page builder only offers components the editing host's code contains. You bring the accepted ones together on `launchworks/integration`, which deploys to the project's fixed editing address, `https://<Vercel project>-editing.vercel.app`.

1. `sandbox.workspace.open` with your branch, then `sandbox.git.integrate` with `launchworks/design-system`, `launchworks/integrate-head` and the component's `launchworks/port-<key>`. Branches already integrated change nothing; ones that don't exist are skipped and listed. It merges, builds and pushes only if the build is green; if another integration pushed first, it starts again from that by itself.
   When something already integrated must come out (a component whose task was cancelled), integrate with `fresh: true` and every branch that should stay: it rebuilds the integration branch from the default branch with exactly those.
2. On a source conflict (409), report the branch and its files with `needs_decision`: don't edit the merge by hand. On a red build (422), read the error and report it the same way. Never push to the integration branch any other way.
3. `hosting.deploy.preview` with ref `launchworks/integration`, then `hosting.deploy.status` with its deployment id until `READY` or `ERROR` (allow several checks: a build takes minutes). Once ready, the result names the editing address; if it says a newer integration build already holds it, that one has this component too. On `ERROR`, report the error; don't deploy again in a loop.
4. Submit with the integration commit and the editing address.

For the production task in phase 8, integrate once more with every component's branch (later work may have changed them), confirm the configuration matches the hosting project's variables and the registered editing host, and report the integration commit: the default branch takes it before the code release.
