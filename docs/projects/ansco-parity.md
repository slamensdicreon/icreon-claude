# Ansco parity: handoff

Goal: the migrated Ansco site (SitecoreAI, editing host
`https://dycom-ansco-associates-sitecoreai-v2-editing.vercel.app`) matches the source site
(`https://anscollc.com`, rebuilt as code in `slamensdicreon/dycom-ansco-associates`,
`artifacts/ansco/src`) page for page. The Launchworks project is `prj-0a77a24d`.

Measure it with:

```
pnpm --filter @lw/platforms exec tsx scripts/parity-report.ts \
  --host dycom-ansco-associates-sitecoreai-v2 --origin https://anscollc.com \
  --pages /,/about,/safety,/quality,/subcontractors,/subcontractor-request,/careers,/benefits,/life,/opportunities,/contact,/contact/locations,/faq,/faq-es,/privacy-policy \
  --lists CardGrid,StatsCounter,Accordion,JobList,LocationsList,BenefitsCarousel,ContactForm,SubcontractorForm
```

Done: every page passes when it prints `PASS` (90% of the source text and headings, list items
rendered, no placeholder copy, header and footer present).

## Status (2026-10-28): every page passes

All 15 pages print `PASS` (98–100% of the source text) on the editing host, deployment
`dpl_FXgFPsCDEAF5Cz6kUZVdytoV8mQZ` (head d3caeea). Nothing is published; Page builder and the editing host
read the preview (master).

### Head code (`icreon-launchworks/dycom-ansco-associates-sitecoreai2`, `launchworks/integration`)

- d9d8beb: `ui/Section` bands from rendering parameters (`tone`, `diagonal`, `spacing`);
  RichText, ImageText, JobList and JobSearch on the source's markup; list components read both
  field shapes (`ui/fields.ts`), each with its `<Name>.graphql`.
- 5958f40: LocationsList's query selects each office's fields as one list
  (`fields(ownFields: true) { name jsonValue }`, read by `itemFields`), since six aliased fields on
  fifty offices exceed the query complexity limit; SiteHeader's nested children have no `first`
  (same limit); the contact form's state list matches the source's.
- d3caeea: on `bg-primary` / `bg-navy` bands `.primary` headings and buttons take the light
  treatment; CardGrid `Tile` variant (image, heading, copy stacked).

The `.graphql` files there are the queries set on the renderings
(`/sitecore/layout/Renderings/Project/brands/ansco/*` → `ComponentQuery`).

### Sitecore content (`/sitecore/content/brands/ansco`)

- Component Queries on all ten list, header and footer renderings.
- Header and footer: `Data/Navigation/Main Navigation` (nav in source order, About Us and Careers
  submenus) and `Data/Footer/Footer` (quick links, social, address, phone, careers assistance and
  EEO links). Partial designs `Header`, `Footer`, `Careers Footer` (variant `Careers`), recreated on
  the JSS Partial Design template; the MVC-template originals are in the recycle bin. Page designs
  `Corporate Page` and `Careers Page`, mapped with `configurePageDesigns`.
- Headless variants added: HeroBanner (Default, Home, Compact), CardGrid (Default, Panel,
  PanelTall, FancyBox, IconCircle, Contact, Tile), ImageText (Default, ImageLeft, ImageRight).
- Every page's layout rewritten from its source page, section by section, with variant and band
  parameters. Content filled from the source where it was missing: Life@Ansco (values, work with
  us, growth cards, workforce), Opportunities (live featured jobs, category copy, talent network
  CTA), contact request types, subcontractor work types and consent, hero images. Image Text
  template has `image2`. File Download `file` fields hold `<file mediaid=…/>`.

### How the editing host refreshes

Pages render once per deployment and stay cached, so content changes show only on a new
deployment: redeploy the editing alias's deployment (`POST /v13/deployments` with its
`deploymentId`) and move `dycom-ansco-associates-sitecoreai-v2-editing.vercel.app` onto it.

### Left as is

- Unused duplicates kept (not on any page): `Home/about/Data/Linking`, `Home/life/Data/Talent
  Development Grid`, `Home/opportunities/Data/Jobs` and `Job Categories`, `Home/contact/Data/Locations`,
  `Data/CTAs/Talent Network`, `Data/Forms/*` (its work types are not the source's). Their
  placeholder copy is cleared.
- The source's "Linking-Southeast" upper photo (About) and the careers CTA background image are
  not in the media library.
- Opportunities' featured jobs are a snapshot of the live site on 2026-10-28.

## Lessons now in the playbook

`platforms/sitecoreai/knowledge/known-pitfalls.md` (JSS partial design template, page-design
mapping, variants as items, query complexity, editing-host caching, File fields, coloured bands);
the Layout Engineer maps page designs with the new `sitecore-authoring.page-designs.map`.
