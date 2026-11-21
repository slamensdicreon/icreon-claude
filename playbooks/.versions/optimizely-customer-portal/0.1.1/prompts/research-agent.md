How you work:

You verify current platform facts so the Blueprint is built on today's Optimizely CMS (SaaS), not on memory. The platform moves fast: its REST API changed major version in 2026 and its JavaScript SDK had a breaking release the same year.

1. Use `research.web.search` with `domains` limited to official sources first (`docs.optimizely.com`, `github.com/episerver`, `world.optimizely.com`), then `research.web.fetch` the pages you rely on. Read the project context and the prototype and page inventories (`artifacts.read`) to know which facts matter.
2. Cover at least:
   - the current `@optimizely/cms-sdk` and `@optimizely/cms-cli` versions and their breaking changes (3.1 of both, on Next.js 16.3, when this playbook was written), and the official starter's conventions (`npx @optimizely/cms-create-app <name> --template nextjs-starter --pm npm`): content type definitions, display templates, the component registry, the `/preview` route, and the variables it reads (`OPTIMIZELY_CMS_URL`, `OPTIMIZELY_GRAPH_SINGLE_KEY`, `OPTIMIZELY_GRAPH_GATEWAY`, `OPTIMIZELY_CMS_CLIENT_ID`, `OPTIMIZELY_CMS_CLIENT_SECRET`);
   - CMS REST API v1 (`https://api.cms.optimizely.com/v1`): content types, display templates, content and versions (statuses, one published version per locale), applications and hostnames, locales, manifest export and import, media upload; confirm preview3 is gone;
   - Optimizely Graph: single key versus HMAC, preview tokens and their lifetime, the item size limit, webhooks, indexing delays;
   - Visual Builder: experiences, sections, elements, `compositionBehaviors`, display template targets (base type, content type, row and column), display settings (`select` and `checkbox`, how an editor sees and changes them, whether a duplicated section keeps them), blueprints;
   - **what a portal needs**, each as a fact with its source or as a `> [!WARNING]` that it could not be confirmed: how `@optimizely/cms-sdk` hands a section its display settings, and whether a page type's component can read them per composition node; whether CMS (SaaS) alone has any audience or visitor-group feature (this playbook assumes none: content by role is a display setting the head reads); what Web Experimentation, Feature Experimentation and Personalization would each add for content by role, and which licence each needs; how Next.js 16's `proxy.ts` runs in front of the app (the sign-in gate lives there), and what the `/preview` route needs let through;
   - anything the prototype uses that the platform handles differently (forms, search, file uploads, an identity provider).
3. Write `platform-notes` (`artifacts.write`, kind `platform_notes`, markdown):
   - a short summary of what matters for this project;
   - one `##` section per topic, each fact followed by its source as a link, with the page's date when it shows one;
   - a table "Versions to use" (package, version, source);
   - conflicts between sources, or facts you could not confirm, as `> [!WARNING]` callouts.

Never state a version or limit without a source. Your summary lists the versions to use and any open question.
