How you work:

You make the build repository's app a working Content SDK head and editing host for the portal. Read the prototype with `github` tools for its screens and assets; work in your working copy with `sandbox` tools.

1. `sandbox.workspace.open` with your branch: `launchworks/<task id>`.
2. Configure `sitecore.config.ts` (site name, default language), `next.config` and i18n for the project's languages. The proxy chain in `src/proxy.ts` keeps the portal shell's sign-in gate first, then the Content SDK proxies (preview, locale, multisite, redirects, personalize): don't remove the gate or its exceptions for Page builder (`__prerender_bypass`, `sc_itemid`) and static `assets/`. Environment values come from the hosting project, never from files: don't write secrets or Context IDs into the repository.
3. Keep `src/Layout.tsx` rendering `<Scripts />` (Sitecore's `<EditingScripts />`) and `<SitecoreStyles />` as the starter has them: without the editing scripts, Page builder shows every field's editing marker as raw JSON. `src/Layout.tsx` must not import `next/headers` (the client `global-error` page imports it): the route's `page.tsx` reads the session and passes the persona in. The editing host renders every page per request (`SITECORE_RENDER_ON_REQUEST=true`): in `src/app/[site]/[locale]/[[...path]]/page.tsx`, call `await connection()` (from `next/server`) at the top when it is set, and export `generateStaticParams` only when it is not.
4. Keep the editing endpoints (`/api/editing/render`, `/api/editing/config`) working; Page builder renders through them, signed out.
5. `sandbox.exec.build` until green, then `sandbox.git.commit` to your branch. Submit with the commit SHA and what you configured.

**Integrating a component** (the tasks to integrate a component into the editing host). Each component is built on its own branch; Page builder only offers components the editing host's code contains. You bring the accepted ones together on `launchworks/integration`, which deploys to the project's fixed editing address, `https://<Vercel project>-editing.vercel.app`.

1. `sandbox.workspace.open` with your branch, then `sandbox.git.integrate` with `launchworks/design-system`, `launchworks/portal-shell`, `launchworks/integrate-head` and the component's `launchworks/port-<key>`. Branches already integrated change nothing; ones that don't exist are skipped and listed. It merges, builds and pushes only if the build is green.
   When something already integrated must come out (a component whose task was cancelled), integrate with `fresh: true` and every branch that should stay. The Director's own fixes (`launchworks/director`) always come along.
2. On a source conflict (409, which names the branch and files) or a red build (422), report it with `needs_decision`: don't edit the merge by hand. 503 means other integrations kept pushing while yours built: integrate again once they finish. 403 means GitHub refused the push: report the reason it gives.
3. `hosting.deploy.preview` with ref `launchworks/integration`, then `hosting.deploy.status` with its deployment id and `wait: true`, which answers once it is `READY` or `ERROR` (a build takes minutes; if it says it is still building, call it again with `wait`). Once ready, the result names the editing address. On `ERROR`, report the error; don't deploy again in a loop.
4. Submit with the integration commit and the editing address.

For the production task in phase 6, integrate once more with the branches already in `launchworks/integration`, confirm the configuration matches the hosting project's variables and the registered editing host, and report the integration commit: the default branch takes it before the code release.

When a page answers 500 or renders wrong on the editing host, don't guess from the code: run `hosting.logs.runtime` with the page's path (signed-out requests land on `/sign-in`; that page and Page builder's render are what you can reproduce). It returns what the server logged while rendering, with the page's status and error digest.
