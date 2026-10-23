> Reference copy from the BLDR / New Brand build, kept as the source for the SitecoreAI migration playbook's known pitfalls (`playbooks/sitecoreai-migration/knowledge/known-pitfalls.md`) and Definition of Done (`knowledge/definition-of-done.md`). Relative links point into that build's repository and don't resolve here.

# Sitecore Website Build Playbook

## Reverse-engineered from the Builders First Source / BLDR implementation

**Purpose:** give a future agentic website-building system a repeatable, inspectable process for producing a Sitecore website—not just a screenshot-equivalent React page.

**Prepared:** 2026-10-23. **Scope:** repository reconstruction and operational guidance. No website code, CMS items, credentials, or deployments were changed to produce this document. No new live end-to-end verification was performed.

**Deliverable location:** `docs/SITECORE_WEBSITE_BUILD_PLAYBOOK.md`. All file references below are relative to the repository root unless expressed as Markdown links.

### Evidence labels

- **Verified in source:** supported by files inspected for this document; not a claim about the current live environment.
- **Historical:** supported by Git history, task records, or recorded troubleshooting. A past successful deployment is not a current health check.
- **Recommended:** a proposed repeatable practice or acceptance criterion for the future system, not a capability already implemented.
- **Unknown / needs verification:** insufficient evidence to establish the claim.

## Contents

1. [What we actually built](#1-what-we-actually-built)
2. [Evidence and reconstruction](#2-evidence-and-reconstruction)
3. [Intake and project parameters](#3-intake-and-project-parameters)
4. [Architecture and credentials](#4-architecture-and-credentials)
5. [Repeatable execution phases](#5-repeatable-execution-phases)
6. [Troubleshooting playbook](#6-troubleshooting-playbook)
7. [Agentic execution contract](#7-agentic-execution-contract)
8. [Definition of done](#8-definition-of-done)
9. [Commands and verification recipes](#9-commands-and-verification-recipes)
10. [Historical completion and remaining gaps](#10-historical-completion-and-remaining-gaps)
11. [Reusable run templates](#11-reusable-run-templates)
12. [Repeat-run checklist](#12-repeat-run-checklist)

---

## 1. What we actually built

### 1.1 Naming: BLDR and New Brand are the same implementation here

**Verified in source / historical:** “Builders First Source,” “Builders FirstSource,” and “BLDR” describe the visual brand/reference experience. “New Brand” / `new-brand` names the Sitecore site used to implement that experience. The collection is Brands; serialized item paths commonly use lowercase `brands`.

The evidence is explicit: the component guide describes the “full BLDR Ready homepage” on the New Brand Home page, and the completed homepage task describes replacing that site's placeholder content with the shared design system's BLDR experience. Do not create a second site solely because these names differ.

For a new client, parameterize collection, site, brand, repository, host, and environment names. Do not globally replace every occurrence of “New Brand”: stable item IDs, rendering names, SDK registrations, and external host references need deliberate mapping.

### 1.2 The product was more than a homepage

The build combined:

1. A source-backed BLDR design-system package with tokens and reusable component families.
2. A Next.js App Router website built on the Sitecore Content SDK starter.
3. CMS templates, fields, branches, rendering definitions, placeholder settings, site content, and media.
4. Shared Header/Footer partial designs and page-specific main-area components.
5. Editable datasource-backed content rather than a hard-coded visual replica.
6. The ability to create a blank page under Home and add reusable blocks with independent content.
7. A repository-backed authoring/editing-host deployment and a separate content-publishing flow.

**Critical distinction:** code deployment, CMS serialization synchronization, and publishing to Edge are different operations. Success in one does not prove the others succeeded.

### 1.3 Actual repository boundaries

| Area | Role | Evidence |
| --- | --- | --- |
| `examples/basic-nextjs/` | Actual Sitecore website source | App manifest, source components, SDK config |
| `artifacts/sitecore-website/` | Workspace artifact registration area | Do not mistake this thin directory for website source |
| `artifacts/bldr-design-system/` | Shared visual vocabulary and reference experience | Consumer documentation, component inventory, Ready homepage |
| `authoring/` | Sitecore authoring solution and serialized items | Root build configuration and serialization module |
| `artifacts/home-editor/` | WorkFLO Marketplace application | Separate product/deployable; not required to render the website |
| `artifacts/api-server/` | Workspace API service, including historical editor integration | Not the Sitecore website editing host |

The design-system documentation names `artifacts/bldr-home` as the original reference application. Treat that as historical provenance; do not assume the original application still exists. The retained Ready homepage experience is the practical visual reference.

### 1.4 The component/content contract

The visible shell is Header + Footer. Home's main area contains Hero plus seven sections:

| Rendering name | Content model | Behavior / constraints to preserve |
| --- | --- | --- |
| `Header` | Header root; Nav Group children; Nav Link grandchildren | CMS image logo, primary CTA, ordered navigation; integrated query limits first 4 groups / first 5 links |
| `Hero` | Hero root plus three Hero Panel children | Shared aligned day/dusk scenes; three desktop windows; mobile panel imagery; stable editing composition |
| `SearchDock` | Search Dock root plus Search Item children | Local authored catalog suggestions, keyboard selection; first 30 items—not evidence of a full enterprise search service |
| `CapabilitySection` | Capability Section plus Capability Card children | Featured and available flags; first 10 cards |
| `CatalogSection` | Catalog Section plus Catalog Item children | First 12 items; flat-field query adapter |
| `GreenerSection` | Greener Section plus Stat Item children | First 6 stats; poster/video behavior with reduced-motion considerations |
| `QuoteSection` | Quote Section | Scalar fields, no child collection |
| `KnowHowSection` | Know How Section plus Know How Item children | First 6 topics |
| `ServicesSection` | Services Section plus Service Item children | First 8 services |
| `Footer` | Footer scalar/link fields | Group links, social links, copyright; real destination checks still required |

These limits are implementation choices and observed query constraints, not a promise that all future Sitecore tenants have identical limits. Expose limits in author instructions; never silently imply unlimited authoring.

`ContentSection` is also retained from an earlier homepage iteration. Its presence is not proof it belongs in the final Ready homepage composition.

---

## 2. Evidence and reconstruction

### 2.1 Source index

| Ref | Source | What it establishes |
| --- | --- | --- |
| E1 | [Component and authoring guide](new-brand-components.md) | Models, rendering names, datasource creation, child limits, page reuse |
| E2 | [Website manifest](../examples/basic-nextjs/package.json) | SDK/framework dependencies and executable script names |
| E3 | [Root build configuration](../xmcloud.build.json) | Root build context, `basic-nextjs` host, authoring path |
| E4 | [Serialization module](../authoring/items/newbrand-components.module.json) and [CLI config](../sitecore.json) | Included roots, delete-capable push policy, pinned plugin versions |
| E5 | [Design-system consumption](../artifacts/bldr-design-system/docs/consuming-web.md) and [inventory](../artifacts/bldr-design-system/docs/references/component-inventory.md) | Token/component reuse and reference provenance |
| E6 | [Ready homepage reference](../artifacts/bldr-design-system/src/preview/experiences/ready-homepage.tsx) | Reference composition and visual families |
| E7 | [Header](../examples/basic-nextjs/src/components/header/Header.tsx) and [Hero](../examples/basic-nextjs/src/components/hero/Hero.tsx) | Current editing/interaction behavior and field wrappers |
| E8 | [Field adapter](../examples/basic-nextjs/src/lib/json-fields.ts), [layout](../examples/basic-nextjs/src/Layout.tsx), [proxy](../examples/basic-nextjs/src/proxy.ts) | Data-shape normalization, layout boundary, locale/proxy ordering |
| E9 | [SDK config](../examples/basic-nextjs/sitecore.config.ts) and [task runner](../examples/basic-nextjs/scripts/run-tasks.mjs) | Connected/disconnected behavior and map-generation ordering |
| E10 | [GitHub/Sitecore setup](github-sitecore-setup.md), [repository guide](repository-guide.md) | Repository/deployment procedure; verify current remote before using |
| E11 | [Memory index](../.agents/memory/MEMORY.md) | Historical diagnosis notes; specific sources linked in troubleshooting |
| E12 | [Serialized items](../authoring/items/items/) | Snapshot of CMS configuration, content and media; not a live tenant inventory |

Source precedence: current code and serialized structure for implemented behavior; history for transitions; current official documentation for supported API contracts; historical notes for observed pitfalls. Resolve conflicts explicitly.

### 2.2 Reconstructed progression

This is the supported sequence from selected commits, not a complete transcript of every attempt. Commit subjects report historical intent; they are not fresh test results.

| Stage | Historical evidence | Lesson |
| --- | --- | --- |
| Establish starter and authoring contract | `4186879`, `dc605b9`, `41c1c71` | Preserve the authoring solution even for a front-end-heavy project; disconnected buildability is not connected correctness |
| Create shell and connect preview | `f75ed9a`, `0b704d0`, `0d58558` | React components need CMS definitions and a correct preview context |
| Repair Edge rendering dependency chain | `5e5f2ed`, `551772f`, `aea2638` | Partial designs, published definitions, media, and datasource IDs must all resolve |
| Add initial content, then replace hero | `473cf07`, `437fd44`, `575289b`, `5311d83` | Mature from shell to brand-specific experience; keep editing usable without disturbing visual composition |
| Recreate Ready homepage | `3cf843c`, `ddcda95` | Convert every visual section to an authored component; verify real interactions, not appearance alone |
| Enable reusable blank pages and starter content | `c3d8ada`, `a8c62c9`, `392e44e` | Component toolbox registration, independent datasources, and populated branches are separate deliverables |
| Evolve navigation and deploy it | `56547c3`, `7ccf725`, `31e3d9c` | Nested content models need bounded queries; editing interactions must match the intended editor experience |
| Align repository release | `b20dd74` | Verify linked repository, exact commit, and both deployment targets |

Completed task records corroborate the shell, triptych, full homepage, reusable pages, starter content, menu deployment, and closed-menu editing changes. Task descriptions are acceptance intent, not proof every browser state was tested.

### 2.3 Known stale descriptions

- `replit.md` says the authoring folder has no custom serialization modules yet. E4 and E12 show it does.
- E1 says editing-mode navigation is always expanded and describes hover interaction. E7 and the later menu commit show closed, click-driven menus in live and editing modes.
- The serialization module description mentions only the three shell components, but its actual includes cover the broader implementation.
- The design-system inventory's original application reference is historical. The current website consumes the shared package.
- Earlier deletion notes suggest recycle-bin deletion fixes field removal; the later note records false-success results even for that method.

This document records these conflicts without changing the older files. A future executor must not treat the oldest guide as the final specification.

---

## 3. Intake and project parameters

**Recommended:** require an approved brief before authoring either code or CMS items.

### 3.1 Intake checklist

- [ ] Brand identity, typography, colors, component references, image rights, and approved copy sources.
- [ ] Page types, routes, navigation hierarchy, languages, regional variations, and content ownership.
- [ ] Exact reference states: desktop/mobile, menus open/closed, hero behavior, empty content, editing behavior.
- [ ] Existing site/collection versus greenfield build; templates/content to preserve.
- [ ] Required editorial operations: add/remove/reorder children, create independent content, intentionally share global content.
- [ ] Search, forms, commerce, personalization, analytics, and consent requirements; distinguish real integrations from visual controls.
- [ ] Target environments, repository/branch, hosting model, public domain, release approvals, rollback owner.
- [ ] Accessibility target, supported browsers, performance budgets, link/content approval owner.
- [ ] AI source-code extraction permission and any data-processing restrictions.

### 3.2 Parameter manifest

Store nonsecret parameters in the future run manifest, not hidden in prompts:

| Parameter | This implementation's example | New-project rule |
| --- | --- | --- |
| Brand/reference | BLDR Ready homepage | Explicit approved reference and usage rights |
| Collection / site | Brands / `new-brand` | Resolve actual names and casing from CMS |
| Start item | Site's `Home` | Verify configured start item before creating routes |
| Language | `en` | Verify CMS language and SDK routing agree |
| Rendering host key | `basic-nextjs` | Exact match across build config and Sitecore host |
| Website source | `examples/basic-nextjs` | Keep separate from workspace preview registration |
| Build context | Repository root `.` | Include sibling workspace dependencies |
| Serialization roots | Templates, renderings, branches, placeholders, media, content | Minimize scope to owned items; inventory existing content first |
| Auth/context references | Secret-store key names only | Never store credential values or tokens in run state |
| Release target | Verified repository + branch + environment pair | Never select by friendly name alone |

---

## 4. Architecture and credentials

### 4.1 Dependency flow

```text
Approved reference → shared tokens/components → SDK rendering adapters
                                               ↓
Templates → branches/defaults → datasources → rendering definitions
                                               ↓
Placeholders → partial designs → page design → page layout
                                               ↓
Serialization snapshot + code → repository → authoring/editing host deployment
                                               ↓
Publish complete dependency set → Edge → public delivery verification
```

The editing host renders the application for authors. The public rendering host serves visitors. They may share code but have different context/configuration and operational roles. WorkFLO's Marketplace iframe session is not a dependency of either website rendering path.

### 4.2 Access matrix

| Credential/context | Intended use | Boundary |
| --- | --- | --- |
| Environment Automation | CMS Authoring/Management and applicable XM Apps APIs for selected environment | Verify actual token scopes and a read; name alone is not authorization |
| Organization Automation | Deploy management and CMS access across organization environments | Broad privilege; not the default credential for a narrowly scoped builder |
| Edge administration | Settings, cache, webhooks, delivery-token management | Separate from CMS editing; content clearing can interrupt live delivery |
| Preview/Live Context IDs | SDK content access through Edge Platform | Select intended preview/delivery context; not a general admin credential |
| Editing secret | Editing integration validation | Separate from OAuth client credentials |
| External editing-host client | Authenticated Design studio code extraction on an externally hosted SDK app | Not a substitute for the editing endpoint configuration or CMS automation |
| Marketplace session | Authorized APIs for an installed app/user through SDK | Not reusable as a background service identity |
| Personalize/CDP credentials | Product-specific experience, experiment, decisioning, customer-data APIs | Optional future scope; not established by CMS access or installed SDK packages |

Earlier read-only checks in this conversation verified CMS content reads, configured context reads, and Edge settings/webhook reads with the appropriate credential pair. A different newly supplied automation pair failed authentication. These are point-in-time observations, not durable environment health guarantees. No secret values or client identifiers belong in this playbook.

Installed personalization/analytics packages and `PersonalizeProxy` demonstrate integration code, **not** activated experiences, CDP licensing, valid management credentials, or verified experiment behavior.

### 4.3 Security and approval rules

- Keep OAuth secrets and bearer tokens server-side; log only operation class, sanitized status, and request correlation where safe.
- Treat context IDs as sensitive configuration. The existing app has both server and public-prefixed context variables; audit browser exposure against the current SDK guidance before reusing that arrangement.
- Inspect scopes and read endpoints first. Never test destructive authorization by deleting content, clearing Edge, or revoking a token.
- New-project writes need target identity validation, a diff, and an approved scope. Production publication, source reconnection, deletion, and destructive resets require explicit approval.
- For Design studio extraction, decide source-sharing policy before deployment. Official documentation describes extracting component code and `package.json`, not merely screenshots. It documents Content SDK 1.1+ support and an opt-out through `disableCodeGeneration: true`; check the installed SDK's current behavior/configuration before applying that versioned guidance.
- An exposed secret must be revoked/replaced through the owner and secure secret flow. Never copy it from an attachment into documentation, history, or an agent prompt.

Official references consulted for this document:

- [Client types and scope](https://doc.sitecore.com/sai/en/developers/sitecoreai/deploying-sitecoreai/deploy-app/managing-sitecoreai-client-credentials/manage-client-credentials-for-a-sitecoreai-organization-or-environment.html)
- [Design studio extraction, versioned Content SDK guide](https://doc.sitecore.com/sai/en/developers/content-sdk/10/understanding-code-extraction-in-the-design-studio.html)
- [Edge authorization](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/authorization-and-api-access.html)
- [Pages API](https://api-docs.sitecore.com/xmc/pages-api)

The last two references also informed the preceding access audit. Recheck them during an actual new build; APIs and product naming evolve.

---

## 5. Repeatable execution phases

Every phase below is a **recommended execution contract**, grounded in this implementation. “Check” describes a future required check, not a test performed for this document.

### Phase 0 — Establish ownership, targets, and evidence

**Prerequisites / inputs:** approved brief, repository access, tenant owner, credential references.

**Actions:** inventory code, CMS ownership boundaries, current deployments, repository links, existing content, SDK versions, and secret-key presence. Record exact target identities without secrets. Read credentials documentation and perform safe authentication/read probes.

**Outputs:** parameter manifest, permission matrix, baseline revision, owned-path inventory, explicit unknowns.

**Check / gate:** repository, CM, editing host, site, language, and context all refer to the intended implementation. A human approves write boundaries.

**Stop / recovery:** if a project name matches but repository/host does not, stop. Resolve with the owner; do not create a duplicate project or unlink a working source connection speculatively.

### Phase 1 — Establish the visual system

**Prerequisites / inputs:** Phase 0, approved reference, asset rights.

**Actions:** identify repeated component families and tokens before building page sections. Reuse the existing design-system package; validate one primitive import and its theme before converting the full page. Preserve distinctive behavior such as the aligned triptych, rather than approximating it with unrelated cards.

**Outputs:** component inventory, page composition, responsive and interaction specifications, asset manifest.

**Check / gate:** approved reference states include mobile, keyboard, reduced motion, and authoring behavior. Product compositions reuse package primitives where compatible.

**Stop / recovery:** if the reference source is missing, use retained source-backed examples and mark unknown details; do not claim a fresh brand extraction. Avoid copying a second token system into the website.

### Phase 2 — Establish the connected starter

**Prerequisites / inputs:** Phase 0, target version choices, Phase 1 package requirements.

**Actions:** preserve the Content SDK App Router structure and official authoring solution. Wire workspace dependencies and root build scripts. Configure development host/port and preview context through secure configuration. Preserve locale-before-multisite proxy ordering.

**Outputs:** bootable website, dependency/lockfile baseline, generated component/site artifacts, environment-variable inventory.

**Check / gate:** build/typecheck/lint scripts exist; actual content resolves with the intended context. Distinguish a disconnected fallback build from a successful CMS connection.

**Stop / recovery:** missing credentials should produce a clear disconnected state, not fake CMS success. Inspect upstream content response and dev-origin warnings before redesigning error pages.

### Phase 3 — Design the content contract before wiring it

**Prerequisites / inputs:** reference sections and editorial requirements.

**Actions:** map each visible editable element to a field type and owning item. Use child items for repeatable collections; decide query limits, ordering, shared/global content, and independent per-page content. Define field names/types and the SDK response shape together.

**Outputs:** model specification: templates, fields, branches, child templates, rendering names, placeholder keys, query shapes, default/empty-state policy.

**Check / gate:** all intended editor operations have a model. A single component can distinguish no datasource, blank field, new branch content, and deliberately shared content.

**Stop / recovery:** do not patch a missing model with hard-coded brand copy. Revise the model before implementing duplicated fields or deeply nested unbounded queries.

### Phase 4 — Provision CMS definitions and starter branches

**Prerequisites / inputs:** approved model, validated write scope, before-state export.

**Actions:** create/update templates and field sections, standard values, populated branch roots and representative children, Json Rendering definitions, datasource locations, allowed controls, and Available Renderings. Discover correct design-item templates from the environment rather than choosing similarly named collection templates.

**Outputs:** provisioned model inventory with stable IDs and references; reconciliation diff.

**Check / gate:** rendering names match component map keys exactly; field names/types match source; “Create new content” creates explicit branch-root starter values and expected child items.

**Stop / recovery:** re-query after each logical batch. If a request times out, locate the created item before retrying. Field deletions require verification and a separate destructive-change decision.

### Phase 5 — Implement editable SDK components

**Prerequisites / inputs:** design-system primitives and CMS contract.

**Actions:** adapt CMS fields into branded compositions using SDK `Text`, `Image`, and `Link` where appropriate, preserving editable field metadata. Normalize flat GraphQL field lists without stripping editing wrappers. Implement missing-datasource guidance, valid empty states, and real interaction behavior.

**Outputs:** component adapters, generated component map, field/interaction coverage matrix.

**Check / gate:** populated, missing, blank, and editing states are all usable. Keyboard interactions and focus return work. Regenerate the map using the supplied scripts; never hand-edit generated registrations as the primary fix.

**Stop / recovery:** if content is blank, inspect the actual layout/datasource response before changing JSX. Test the integrated query directly; successful outer HTTP status alone is insufficient.

**Specific lessons:** Header currently starts closed in both live and editing mode and permits inline fields when opened. Its blur behavior avoids closing when Sitecore chrome takes focus. Hero suppresses interactive changes while editing to preserve composition; background images are managed via datasource controls rather than promising every image has direct canvas chrome.

### Phase 6 — Assemble designs, layouts, and routes

**Prerequisites / inputs:** registered renderings, datasources, site settings.

**Actions:** create proper Header/Footer partial-design items with signatures and site-level `sxa-<signature>` placeholder settings. Assign them to the default page design. Keep the default main area empty for new pages; add Home's sections to Home only. Create new routes beneath the configured Home/start item.

**Outputs:** Home layout, default page design, global partials, a reusable page-creation recipe.

**Check / gate:** resolved layout JSON contains nested partial placeholders and expected components. A new child page inherits only the shared shell; its main content and datasource IDs are independent.

**Stop / recovery:** when item rendering exists but route layout is null, check parent/start-item placement before cache-clearing. When a partial wrapper is empty, inspect signatures, placeholders, published definitions, and layout XML.

### Phase 7 — Populate content and media

**Prerequisites / inputs:** approved copy, rights-cleared media, models, defined route destinations.

**Actions:** populate real datasource fields and child order; upload project media within serialized roots; assign media fields. Use aligned day/dusk artwork for the triptych, mobile-specific crops, meaningful alt text, and approved video delivery.

**Outputs:** complete authored content, media provenance/optimization inventory, approved destination map.

**Check / gate:** source image IDs resolve; media dependencies can be recreated; no generic social destinations or dead anchors are accepted as final. Mobile avoids unnecessary desktop-only imagery; reduced-motion users receive appropriate alternatives.

**Stop / recovery:** do not hide missing fields with hard-coded production copy. Missing approved assets may have clearly labeled placeholders in staging, but block final acceptance.

**Historical detail:** this site's guide uses a rendering-host `public/videos/` URL for the Greener video. A future project must explicitly choose durable media storage, deployment inclusion, caching, rights, and size policy; do not assume copying a local file is a complete media strategy.

### Phase 8 — Serialize and prove reproducibility

**Prerequisites / inputs:** reviewed CMS state, declared item ownership, baseline snapshot.

**Actions:** ensure includes cover templates, branches, definitions, placeholder settings, project media, and owned content. Pull the relevant state, inspect the diff, and confirm references/media blobs are captured. Use a disposable environment for a clean replay when authorized.

**Outputs:** reviewed YAML/media snapshot, dependency/reference report, replay evidence or explicit pending status.

**Check / gate:** a clean target can reconstruct the intended site without hidden live-only items. A successful pull alone is not a successful replay.

**Stop / recovery:** the existing module allows `createUpdateAndDelete` and includes the broad Brands content root. Do not blindly push it into an occupied tenant. Narrow ownership or reconcile carefully; preserve concurrent edits rather than discarding them automatically.

### Phase 9 — Validate, synchronize, and deploy code

**Prerequisites / inputs:** reviewed code and serialized state, secure environment configuration, release approval.

**Actions:** run website typecheck/lint/build; commit the coherent release; synchronize the intended repository/branch. Verify the remote SHA. Verify linked authoring and editing-host targets, root build context, and exact host key before triggering approved deployment.

**Outputs:** commit identity, remote parity evidence, deployment records and build logs for the required targets.

**Check / gate:** deployment records reference the intended commit; the authoring solution and sibling design-system package were included. Host name matches build configuration exactly.

**Stop / recovery:** a branch-linked environment rejects local source uploads; fix repository linkage through its owner rather than forcing a different deployment path. Do not unlink until the acting identity can relink both related environments.

### Phase 10 — Publish the complete dependency graph

**Prerequisites / inputs:** validated authoring state, deployed rendering code, approved target/language and publication scope.

**Actions:** publish page/content and required model/layout/media dependencies. Explicitly include rendering definitions; do not assume “related items” captures them. Inspect publishing completion/errors and query Edge for expected structure and values.

**Outputs:** publication record and Edge content/layout evidence, with environment/context documented safely.

**Check / gate:** each expected component and datasource resolves; shared shell appears; the public route renders with published content. Unpublished-only changes remain appropriately separated.

**Stop / recovery:** compare authoring, Edge item, Edge route layout, then browser rendering in that order. Avoid repeated full publishes or broad cache purges without evidence.

### Phase 11 — Accept editorial and visitor journeys, then hand off

**Prerequisites / inputs:** deployed editing host and delivery route, approved test content/cleanup scope.

**Actions:** execute the definition-of-done matrix below in the real Pages editor and visitor browser. Create an independent page/datasource, edit/reorder content, publish approved test changes, and confirm delivery. Document ownership, limits, rollback, and known gaps.

**Outputs:** acceptance evidence, editor instructions, operational handoff, explicit remaining exclusions.

**Check / gate:** an owner can use the site without developer intervention for the agreed editorial tasks. Every mandatory acceptance item is passed or explicitly excluded by an authorized owner.

**Stop / recovery:** local editing flags do not substitute for the real editor. Do not mark a live iframe/editor check passed from source review alone.

---

## 6. Troubleshooting playbook

These are **historical observations**, not universal Sitecore invariants. Revalidate against the installed versions.

| Symptom | Observed cause | Diagnosis and resolution | Verify / prevent |
| --- | --- | --- | --- |
| Development content fails with “No sitecore context” despite configured secret | Wrong context/environment or request format | Confirm Preview enabled and intended preview context. Inspect the endpoint/header spelling; older direct-query recipes use camelCase `sitecoreContextId`, not snake_case | Query a known item and route; record environment role without recording context value |
| Page/partial design lacks expected fields | Used generated collection/folder template | Inspect template inheritance and insert options; use the actual JSS design-item template | Check assignment fields before adding renderings |
| Partial wrapper exists but Header/Footer missing | Missing signature, site-level placeholder setting, or unpublished rendering definition | Trace wrapper → nested placeholder → rendering definition → datasource. Supply the missing dependency, then publish appropriate roots | Require nested layout JSON evidence, not just a populated authoring tree |
| Component exists but datasource unresolved | Malformed/noncanonical datasource GUID | Inspect `dataSource` and `isContentResolved`; use canonical hyphenated IDs when constructing presentation | Validate all references before write and after publishing |
| Publish dependency errors or empty rendered object | Hand-generated delta-style presentation XML | Use full `id`, `ph`, `uid`, `ds`, device `id`, and layout `l` attributes when authoring XML. Namespace-prefixed attributes need valid namespace declarations | Re-query saved presentation and Edge; server-generated delta serialization is not itself evidence of corruption |
| Shared-field update says language version absent | Item has no version in requested language | Inspect versions; add a needed version through supported API before update, with approval | Verify field values afterward; do not invent versions across languages |
| Page exists and publishes, but public URL 404s | Page is sibling of Home rather than descendant of start item | Compare direct item rendering with `layout(site, routePath)`; inspect parent/start-item configuration | Create routes beneath Home; test route, not just item presence |
| Particular sections are blank with no useful app error | Integrated GraphQL complexity limit | Run exact ComponentQuery directly; use `fields(ownFields: true) { name jsonValue }` for wide roots and the field adapter | Inspect GraphQL `errors`, not only HTTP 200; budget queries before adding fields |
| Nested navigation fails at larger sizes | Child × grandchild × field cost | Reduce bounded collections; flat fields are not a universal fix for grandchild complexity | Document observed 4×5 menu contract and expose limits to editors |
| Newly added component displays “No Text in Field” | Blank own values override standard values | Populate branch `$name` root explicitly, as well as standard values and child examples | Create a genuinely new datasource and inspect its own fields |
| Clean sync loses images | Media outside module includes or missing blob evidence | Verify project media include and serialized media payload/reference | Replay in isolated target; reference-only YAML is not sufficient |
| Field delete reports failure—or success but field remains | Inconsistent template-field deletion behavior | Re-query item/section after each attempt. Earlier recycle-bin workaround did not always hold in later observations | Stop retry loops; document harmless stale-field drift if unused, seek owner-approved remediation |
| Local build works; editing-host install cannot find workspace package | Build context excludes sibling package | Set host build path to repository root and use root filtered scripts | Verify remote build includes design-system package; retain lockfile and package-manager contract |
| Blank not-found UI although response contains fallback text | Next dev resources blocked by proxied origin | Inspect dev-resource warnings and configured allowed origins before rewriting route components | Test nested fallback hydration through the actual preview proxy |
| Component disappears after tooling/build | Hand-edited generated map overwritten or naming mismatch | Fix source export/discovery and regenerate using Content SDK CLI script | Compare generated map keys with rendering `componentName` |
| Wrong language/site resolution | Locale/multisite ordering or config mismatch | Keep `LocaleProxy` before `AppRouterMultisiteProxy`; inspect generated sites and default language | Test routes in intended locale, not only `/` |
| Local source upload deployment rejected | Environment linked to branch | Verify linked repository/branch and deploy committed remote revision | Capture remote SHA and deployment trigger metadata |
| Source reconnected but editing host remains broken | Only authoring target reconnected, wrong host name, or owner-only relink rights | Have source-connection owner reconnect both targets; reuse exact host key | Verify both records; do not unlink first or create suffixed duplicate hosts |
| Header opens then immediately closes | Focus/click interaction race in earlier menu work | Review focus and click handlers together; do not open on all focus then toggle closed on the same click | Test mouse, keyboard, Escape, and editor chrome focus transitions |

Historical sources:

- [Preview context](../.agents/memory/sitecore-preview-context.md)
- [Design templates](../.agents/memory/sxa-design-item-templates.md)
- [Partial designs, layout XML, IDs, versions](../.agents/memory/sxa-partial-design-edge.md)
- [Route start item](../.agents/memory/sitecore-route-start-item.md)
- [GraphQL complexity](../.agents/memory/edge-graphql-depth.md)
- [Branch defaults](../.agents/memory/sitecore-datasource-branch-root-values.md)
- [Media serialization](../.agents/memory/sitecore-media-serialization.md)
- [Field deletion, including later qualification](../.agents/memory/sitecore-cli-template-field-deletes.md)
- [Monorepo build](../.agents/memory/xmcloud-pnpm-monorepo-build.md)
- [Next origins](../.agents/memory/next-replit-dev-origins.md)
- [Branch deployments](../.agents/memory/xm-cloud-branch-linked-deployments.md)
- [Source reconnects](../.agents/memory/xm-cloud-source-reconnects.md)
- [Menu race](../.agents/memory/menu-focus-click-race.md)

---

## 7. Agentic execution contract

**Recommended future design—not an implemented system.**

### 7.1 Separate responsibilities, not necessarily separate agents

Define responsibilities for intake/design, model planning, provisioning, component implementation, verification, and release. One executor can fulfill several roles. Parallelize only independent work after shared contracts are approved; two writers should not edit the same template, content subtree, or serialization snapshot concurrently.

The model contract should be approved before separate component and CMS executors work from it. Rendering names, field names, query shapes, ownership, and IDs are shared interfaces—not details each worker can improvise.

### 7.2 Stage state

Use explicit transitions:

```text
planned → preflight-passed → awaiting-approval → executing
        → verified → accepted
        ↘ blocked / failed / recovery-required
```

An API success response advances to “executed,” not “verified.” Read-back and the stage's acceptance evidence are required to advance further.

Persist:

- Nonsecret run ID, stage, approved target, source revision, input fingerprint.
- Resource mapping: logical component/item names to stable IDs and owned paths.
- Desired-state diff, before-state snapshot reference, intended operation.
- Sanitized operation result and verification evidence references.
- Approval scope and expiry, blocked reason, safe resume point.

Never persist tokens, secret values, raw authentication responses, signed media URLs, or unnecessary customer content. Evidence stores need retention and access controls.

### 7.3 Idempotency and resumption

1. Discover existing resources by stable identity plus template/path context before creating.
2. Compare desired fields with actual fields; preserve fields outside the run's ownership.
3. After a timeout, read back first. A timed-out create may already have succeeded.
4. Store the new resource mapping only after verified creation.
5. Resume only if target, source revision, and prerequisites still match the run.
6. Detect concurrent changes and stop rather than overwriting another editor.
7. Treat publish/deploy as tracked jobs: record job identity, await terminal status, then inspect output.
8. Use bounded retries for transient transport/rate-limit failures; respect retry guidance. Do not repeatedly retry authorization, schema, or ownership failures.

Recommended default: at most two retries for clearly transient reads, followed by escalation with sanitized evidence. Writes require reconciliation before retry, irrespective of the retry count.

### 7.4 Risk tiers

| Tier | Examples | Guard |
| --- | --- | --- |
| Read-only | Inspect schema, settings, known content, deployment status | Approved target; minimize data read |
| Scoped reversible write | Create draft datasource, update owned component definition | Approved diff, snapshot, read-back |
| Release-affecting | Push deployment branch, publish, update host settings | Explicit release approval and rollback plan |
| Destructive / authority-changing | Delete items, clear Edge content, revoke credentials, unlink repository | Separate explicit approval; never an automatic diagnostic |

Rollback must distinguish code, CMS configuration/content, and Edge state. Reverting a Git commit does not automatically revert authored content or already published data. Prefer a scoped restoration with known before-state; do not “reset the tenant” to recover one failed component.

---

## 8. Definition of done

**Recommended future release standard.** This table is not a claim that the historical build currently passes every row.

| Area | Required acceptance | Evidence |
| --- | --- | --- |
| Brand fidelity | Approved section order, tokens, imagery, typography, distinctive hero behavior | Reference comparison at agreed desktop/mobile sizes |
| Responsive behavior | No horizontal overflow, clipped controls, inaccessible text, or broken menus at supported widths | Screenshots plus interaction checks |
| Accessibility | Keyboard-only menu/search/hero operation; visible focus; Escape/focus return; labels, alt text, contrast; reduced-motion behavior | Automated report plus manual journey record |
| Genuine CMS content | Every agreed editable field comes from CMS; no production mock data hiding missing fields | Field-to-component matrix and sample read-back |
| Inline editing | Text/link/image editing through the appropriate supported editor surface persists correctly | Real Pages session evidence; list fields requiring datasource panel |
| New component creation | Every reusable rendering appears in toolbox and creates useful starter content | Fresh branch-created datasource evidence |
| Collection authoring | Add/remove/reorder children changes display order within documented limits | Before/after item and page evidence |
| Independence | Editing a new page's datasource leaves Home unchanged; shared shell reuse is intentional | Distinct IDs and before/after comparison |
| Empty states | Missing datasource, cleared optional fields, missing media, empty lists remain usable | Visitor and editor-state checks |
| Routes | Home, representative child page, language route, and unknown route behave correctly | HTTP + rendered-page evidence |
| Navigation | Every agreed CTA, anchor, social, support, and legal destination is real and approved | Destination audit; no generic placeholders accepted |
| Search | Suggestions/select actions work and actual search scope is disclosed | Keyboard and destination checks |
| Media | Assets load, rights/provenance known, alt text present where required, responsive loading and motion policy work | Media inventory/network checks |
| Serialization | Definitions/content/media references replay in a clean authorized target | Replay record and reference check |
| Code quality | Website typecheck, lint, and connected build pass on pinned dependencies | Command logs tied to revision |
| Editing-host deployment | Correct repository/commit/host; editor renders without missing component errors | Deployment record + Pages session |
| Publishing/delivery | Required definitions and data reach Edge; visitor sees published version | Publication record, Edge layout, public route check |
| Security | Credentials not shipped/logged, least privilege, approved extraction policy, safe admin boundaries | Configuration review and secret-safe evidence |
| Performance | Agreed route/image/JS budgets met on representative devices | Measured report against explicit project budget |
| Handoff | Editor guide, component limits, release/rollback runbook, ownership, known exclusions | Approved handoff package |

Do not make a metric up after testing to declare a pass. Agree budgets at intake. A missing mandatory test is “pending,” not “passed by code review.”

---

## 9. Commands and verification recipes

### 9.1 Version contract

At inspection, the website manifest declares Next `^16.2.6`, React `^19.2.4`, Content SDK Next.js/content/CLI `^2.2.0`, and companion analytics/events/personalize packages `^2.1.0`. These are **manifest ranges**, not a claim of exact installed versions. The lockfile is the resolution authority.

Root package manager is `pnpm@10.26.1`; Sitecore host config specifies Node `24.14.1`. CLI config pins Serialization/Publishing/Indexing/ResourcePackage `6.0.23` and XMCloud `1.1.120`. Check compatibility and current documentation before upgrading or applying this recipe elsewhere.

### 9.2 Local website checks

These script names were verified in the current manifests. They were **not executed for this documentation-only task**.

```bash
# From repository root, after provisioning dependencies/configuration:
pnpm run sitecore:typecheck
pnpm run sitecore:lint
pnpm run sitecore:build

# Development, when needed:
pnpm run sitecore:dev

# Explicit generation, normally performed by build/dev task runner:
pnpm --filter xmcloud-marketplace-website run sitecore-tools:generate-map
```

The build script regenerates the component map, runs `sitecore-tools:build`, then `next build`. A build can contact Sitecore and, depending on SDK configuration, participate in code extraction; configure policy first. Generated output changes must be inspected.

### 9.3 Content read: safe response summary

Illustrative Node recipe using secret-store injection, not literal credentials. It reads only a known item's ID and prints a boolean result.

```javascript
const response = await fetch(
  'https://edge-platform.sitecorecloud.io/v1/content/api/graphql/v1',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sitecore-contextid': process.env.SITECORE_EDGE_CONTEXT_ID,
    },
    body: JSON.stringify({
      query: 'query { item(path: "/sitecore/content", language: "en") { id } }',
    }),
  },
);
const body = await response.json();
console.log({
  status: response.status,
  hasItem: Boolean(body.data?.item),
  graphqlErrorCount: body.errors?.length ?? 0,
});
```

Replace the path/language with approved non-sensitive targets. Do not dump full request headers or customer content. A content read validates neither editing permissions nor personalization management.

### 9.4 CLI synchronization and publication

The following are historical command families, **not unattended commands to run against production**. Resolve exact installed flags with `--help`, establish the named endpoint securely, review module scope, and obtain write/release approval first.

```bash
dotnet tool restore
dotnet sitecore ser --help
dotnet sitecore publish item --help

# Pull changes into local serialization; inspect all resulting diffs:
dotnet sitecore ser pull -n "<approved-endpoint>"

# WRITE: only after a reviewed ownership/reconciliation diff:
dotnet sitecore ser push -n "<approved-endpoint>"

# RELEASE: historical item-publish invocation; replace placeholders:
dotnet sitecore publish item -n "<approved-endpoint>" \
  -p "<approved-item-path>" -sub -rel -r --pt "Edge"
```

Do not blindly replay the module's broad create/update/delete scope. Publishing content with related items historically did not include all rendering definitions; explicitly review the definition roots as well.

Authoring GraphQL was also used historically for item operations and publication. Inspect the live schema before constructing mutations; examples from old notes are not a substitute for schema validation.

### 9.5 Repository and deployment checks

```bash
# Read-only local checks:
git status --short
git rev-parse HEAD
git log --oneline -- examples/basic-nextjs authoring xmcloud.build.json
```

Use the approved repository integration to compare remote revision with the intended local release. Do not infer a production URL from development variables. Before triggering a deployment, verify repository, branch, environment IDs, host name, and revision in the deployment service.

If ordinary push is unavailable and Git Trees API publication is used, preserve the intended file tree and verify parity before moving the ref. The historical [GitHub publication note](../.agents/memory/github-empty-repository.md) describes environment-specific connector behavior; do not treat its workarounds as a universal GitHub recipe or bypass a security control.

---

## 10. Historical completion and remaining gaps

### Supported by inspected evidence

- The website source consumes the BLDR design-system package.
- The shell, triptych, and seven homepage sections have CMS-oriented implementations and serialization.
- Branches and reusable page authoring were implemented, not merely proposed.
- Header behavior evolved to closed click-driven dropdowns in the editor.
- History records publishing/deployment work and a root-context fix for shared workspace dependencies.
- The present source has a disconnected-build path; this is useful for tooling but not proof of a connected site.

### Not established by this reconstruction

- A fresh pass of every component inside the actual Sitecore Pages editor.
- A clean-environment replay of the entire current serialized snapshot.
- Current public delivery health, current deployed commit, or complete media availability.
- A comprehensive accessibility/performance conformance report.
- Correctness of every current external/anchor destination.
- Licensed and authenticated Personalize/CDP management, active decision models, or working A/B experiments.
- Whether the current SDK build's code-extraction policy has been explicitly approved.

Existing open project work includes navigation destination and footer account/support cleanup. These are relevant release gaps, but their older descriptions may predate the newer menu; re-audit current destinations rather than assuming all old examples remain.

Some historical task records explicitly distinguish local/source verification from live Pages verification. Therefore “implemented” and “merged” must not be translated into “fully accepted in the real editor.”

### What we would change on the next build

1. Approve the model and query budget before coding all sections.
2. Build one complete vertical slice: template → branch → rendering → editable component → publish → delivery.
3. Add a new-page/independent-datasource acceptance test before expanding the component library.
4. Capture rendering dependencies and media in serialization immediately.
5. Treat read-back, route resolution, and editor behavior as separate gates.
6. Establish the correct remote/host pair before the first deployment.
7. Keep credentials by capability and environment, not vague labels such as “Edge automation.”
8. Record evidence incrementally so future reconstruction does not depend on memory or commit subjects.

---

## 11. Reusable run templates

### 11.1 Stage record

```yaml
run: <nonsecret-run-reference>
stage: <phase-name>
status: planned
source_revision: <commit>
target:
  environment_ref: <nonsecret-reference>
  site: <site-name>
  language: <language>
inputs:
  approved_brief: <reference>
  model_contract: <reference>
  desired_state_hash: <hash>
permission:
  credential_reference: <secret-store-key-name-only>
  approved_paths: []
  approval_reference: <reference-or-not-required>
outputs:
  resource_map: <protected-artifact-reference>
  diff: <reference>
verification:
  checks: []
  evidence: []
  unresolved: []
recovery:
  before_state: <protected-artifact-reference>
  safe_resume_point: <description>
```

This is a proposed contract, not an existing executable manifest.

### 11.2 Component acceptance record

```text
Component / rendering key:
Template + branch:
Datasource location / ownership:
Fields and types:
Child templates, order, limits:
Query and response shape:
Visitor empty state:
Editor empty state:
Inline-editable fields / datasource-panel fields:
Interaction + keyboard + reduced-motion rules:
Media dependencies:
New datasource test:
Independent page test:
Published delivery test:
Evidence references / remaining gaps:
```

### 11.3 Incident record

```text
Symptom and affected boundary:
Expected versus actual:
Environment role + source revision:
Sanitized failing request / status:
Hypotheses checked:
Verified cause:
Smallest safe correction:
Approval required:
Read-back and end-user verification:
Preventive gate:
Unresolved uncertainty:
```

### 11.4 Release evidence record

```text
Approved release scope:
Code revision / remote parity:
Serialized snapshot / reviewed deletions:
Target authoring + editing-host identity:
Deployment jobs and terminal outcomes:
Publishing scope + outcome:
Edge item/layout checks:
Pages editorial checks:
Visitor route checks:
Accessibility/performance results:
Known exclusions accepted by:
Rollback code / CMS / delivery procedure:
Operational owner:
```

---

## 12. Repeat-run checklist

1. Confirm brief, brand/reference, content ownership, and actual target identity.
2. Establish safe credentials and prove read access; approve write boundaries.
3. Reuse or build the shared visual system before duplicating page styles.
4. Prove the connected starter and one complete editable/published component.
5. Approve template/branch/query contracts for the remaining components.
6. Provision definitions, populated branch roots, child items, and toolbox registrations.
7. Implement SDK adapters with editing, empty, responsive, and keyboard states.
8. Assemble shared partials/default design; create page routes under the start item.
9. Populate approved content/media; verify all destinations and media ownership.
10. Capture complete serialization and inspect the ownership/reference diff.
11. Validate website scripts, remote parity, and exact deployment targets.
12. Obtain release approval; deploy required targets and verify their revisions.
13. Publish complete dependency roots; verify Edge layout and public delivery.
14. Execute real-editor creation/editing/reuse checks and visitor acceptance.
15. Deliver evidence, editor guidance, rollback instructions, and explicit exclusions.

**The central lesson:** a Sitecore website is done when its visual experience, content model, editorial operations, serialized dependencies, and deployed delivery all agree. A successful build or attractive preview proves only one part of that contract.
