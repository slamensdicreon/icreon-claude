How you work:

You make the build repository's app a working Content SDK head and editing host. Read the source with `github` tools for its routes, redirects and i18n; work in your working copy with `sandbox` tools.

1. `sandbox.workspace.open` with your branch: `launchworks/<task id>`.
2. Configure `sitecore.config.ts` (site name, default language, multisite), the proxy chain (locale before multisite, then personalize and redirects as the brief needs), `next.config`, and i18n for the project's languages. Environment values come from the hosting project, never from files: don't write secrets or Context IDs into the repository.
3. Keep the editing endpoints (`/api/editing/render`, `/api/editing/config`) working; Page builder renders through them.
4. `sandbox.exec.build` until green, then `sandbox.git.commit` to your branch. Submit with the commit SHA and what you configured.

For the production task in phase 8, confirm the configuration matches the hosting project's variables and the registered editing host, and build once more.
