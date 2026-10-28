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

## Handoff to the agents (2026-10-28, night)

Launchworks was brought up to date and the project resumed:

- Marked done outside the agents (`completeTasks`, operator API key): `register-site-header`,
  `register-site-footer` (their cards had expired) and `partial-designs` (waiting on them). We
  built the header and footer datasources, Component Queries, partial designs and page designs
  by hand.
- `enable-experience` was blocked "not connected" for Page builder, which only the proof variant
  needs. The template now says `uses: [sitecore-authoring, blackboard, artifacts]`, so it runs; its
  card was answered "retry".
- The hand fixes on `launchworks/integration` are also on `launchworks/director`, which every
  integration merges last (a `fresh` rebuild included), so phase 8's final integration keeps them.
- What the agents do next: phase 7 (redirects, SEO, sitemap, robots, error pages, dictionary),
  then 8–10. `final-visual` and
  `final-parity` check the small differences below.

## Status (2026-10-28, evening): every page matches the live site section by section

All 15 pages pass `parity.render` (98–100% of the text) and were compared with anscollc.com by
screenshot, page by page. The target is the **live site**: the source repository's rebuild differs
from it (footer column order, the contact and privacy layouts, list markers), and the client
compares against what visitors see.

### Editing host

- Renders every page per request (`SITECORE_RENDER_ON_REQUEST=true` on the Vercel project, no
  `generateStaticParams` export then): Sitecore edits show at once and signed CM media links never
  sit in a cached page. No redeploys to refresh content.
- `https://dycom-ansco-associates-sitecoreai-v2-editing.vercel.app` → the latest
  `launchworks/integration` build.

### Head code (`launchworks/integration`, after d3caeea)

- a25ac65, 4619d6c: per-request rendering; white cards keep dark text on coloured bands.
- 0914355 and later: footer in the live order (company, logo, links) with `careersCompany`;
  hero heights, title position and the red `.btn`; authored list markers (Tailwind preflight
  stripped them) and check-mark lists; dark headings unless `heading=primary`.
- New layouts: CardGrid `Feature`, `Service`, `Aside`, `Slider` (and `heading=none`,
  `align=left`, IconCircle as plain icon art, tile grid three to a row); CtaBanner red
  `TalentNetwork` and `Split`; LocationsList `Pins`; ContactForm, Accordion and VideoEmbed
  `layout=aside`; BenefitsCarousel `layout=split` (`imageSide=right`); ImageText `split=4-8|5-7`
  and `image=plain`; legal pages without a banner.
- Hidden content stays in the page: the contact form's address (hidden and disabled until a
  request type is chosen), every slide, the states list.

### Sitecore (`/sitecore/content/brands/ansco`)

- Every page's layout rewritten from the live page; new datasources where a section had none
  (Home `Contact`; About `Linking History`, `Linking Network`, `MVV Intro`, `MVV Values`, five
  `Service …` rows; Safety `Training Phases`, `Training Specialized`; Quality `Rightway Video`,
  `Committed Text`). Unused originals are kept (Home `Data/Unused`).
- Template fields added: Site Footer `careersCompany` (copyright now multi-line), Accordion
  `aside`, Benefits Carousel `image`; their Component Queries updated (mirrored in the
  `.graphql` files). Variant items for every new variant.
- Media added: `Heroes/banner-subcontractor-requests`, `Photos/Linking-Southeast`,
  `Careers/RS163__CGC2944`.

### Left for the agents (small)

- FAQ intro buttons are side by side (the live page stacks them); the FAQ installation band is
  faint (white on the live page).
- Contact form: the live page has a CAPTCHA and a small outlined submit button.
- Opportunities job titles: the live list uses a larger, lighter title and shows "Apply Now" on
  hover.
- Stats labels on About break onto two lines on the live page.
- Section paddings differ by a few pixels in places.

## Earlier status (2026-10-28, afternoon)


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

### Left as is

- Unused duplicates kept (not on any page): `Home/about/Data/Linking`, `Home/life/Data/Talent
  Development Grid`, `Home/opportunities/Data/Jobs` and `Job Categories`, `Home/contact/Data/Locations`,
  `Data/CTAs/Talent Network`, `Data/Forms/*` (its work types are not the source's). Their
  placeholder copy is cleared.
- The source's "Linking-Southeast" upper photo (About) and the careers CTA background image are
  not in the media library.
- Opportunities' featured jobs are a snapshot of the live site on 2026-10-28.

## Lessons now in the playbook

The evening pass added: the live site is the truth over the repository; the content inventory
records each section's layout and builders make one variant per layout; `parity.visual` judges
screenshots; new items set every field (template defaults like "Section heading" leak);
authored lists keep their markers; hidden content stays in the page; screenshots hide cookie
banners. See `known-pitfalls.md` and the Content Analyst, Solution Architect, Component Engineer
and Content Migrator prompts.


`platforms/sitecoreai/knowledge/known-pitfalls.md` (JSS partial design template, page-design
mapping, variants as items, query complexity, editing-host caching, File fields, coloured bands);
the Layout Engineer maps page designs with the new `sitecore-authoring.page-designs.map`.
