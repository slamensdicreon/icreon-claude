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

## Done (head code, `icreon-launchworks/dycom-ansco-associates-sitecoreai2`)

On `launchworks/integration` (commit d9d8beb), deployed to the editing host:

- `components/ui/Section.tsx`: every content component renders in a section band driven by
  rendering parameters: `tone` (`none` | `faint` | `primary` | `navy`), `diagonal`
  (`none` | `left` | `right`), `spacing` (`both` | `top` | `bottom` | `none`, so two adjacent
  components share one band).
- RichText (`Default`, `Centered`, `Legal`; parameter `heading=primary` colours the heading red),
  ImageText (fields `image` and optional `image2`; parameter `split=5-7`), JobList and JobSearch
  rebuilt on the source's markup and CSS.
- List components read fields and items from the layout service or a Component Query
  (`components/ui/fields.ts`). Each has its `<Name>.graphql` beside it.

## Remaining (Sitecore content; needs authoring API access)

The CM host is `xmc-icreonpartn775e-newbranddem8eb3-newbranddem12b2.sitecorecloud.io`, site
`/sitecore/content/brands/ansco` (a shared collection: change only Ansco's own items). Token:
`POST https://auth.sitecorecloud.io/oauth/token` (`client_credentials`, audience
`https://api.sitecorecloud.io`); authoring GraphQL at `https://<cm>/sitecore/api/authoring/graphql/v1/`.
Layout XML IDs must be `{8-4-4-4-12}` (the API returns bare hex).

1. **Component Queries.** Set each list rendering's `ComponentQuery` field (under
   `/sitecore/layout/Renderings/Project/brands/ansco`) to its `.graphql` on
   `launchworks/integration`: CardGrid, StatsCounter, Accordion, JobList, LocationsList,
   BenefitsCarousel, ContactForm, SubcontractorForm, SiteHeader, SiteFooter. Keep the aliases;
   change `field(name: …)` only where the template's field name differs (read the template).
2. **Header and footer.** Datasources under `<site>/Data` from the source's `SiteHeader` and
   `SiteFooter` (`src/content/site.ts`: nav in order with submenus, address, phone, links,
   social); `Header` and `Footer` partial designs under `<site>/Presentation/Partial Designs`
   with the renderings in `headless-header` / `headless-footer`; page designs `Default` (and
   `Careers`, footer variant `Careers`) with both in `PartialDesigns`; every page template mapped
   in the Page Designs item's `TemplatesMapping`.
3. **Pages, section by section from the source page files** (`app/(corporate)/*/page.tsx`,
   `app/(careers)/*/page.tsx`; copy in `src/content/*.ts`): one component per source section,
   with its variant and parameters (`tone`, `diagonal`, `spacing`, `heading`, `split`), every list
   item created as a child of its datasource, every field filled, no placeholder copy. Add
   `image2` (Image) to the ImageText datasource template where a section has two images.
4. Publish nothing; Page builder and the editing host read the preview.
5. Re-run the parity report until every page passes.

## Lessons already in the playbook

`platforms/sitecoreai/knowledge/known-pitfalls.md` (Component Queries, both field shapes,
Section bands, section-by-section mapping, partial designs, layout ID format) and the checks
`parity.render`, `structural.component-queries`, `head.sections`, `head.header-footer`.
## Component Queries (one `<Name>.graphql` per list component)

### CardGrid.graphql
```graphql
query CardGrid($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    intro: field(name: "intro") { jsonValue }
    children(first: 12) {
      results {
        id
        title: field(name: "title") { jsonValue }
        text: field(name: "text") { jsonValue }
        image: field(name: "image") { jsonValue }
        link: field(name: "link") { jsonValue }
      }
    }
  }
}
```

### StatsCounter.graphql
```graphql
query StatsCounter($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    children(first: 6) {
      results {
        id
        value: field(name: "value") { jsonValue }
        suffix: field(name: "suffix") { jsonValue }
        label: field(name: "label") { jsonValue }
      }
    }
  }
}
```

### Accordion.graphql
```graphql
query Accordion($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    intro: field(name: "intro") { jsonValue }
    children(first: 40) {
      results {
        id
        question: field(name: "question") { jsonValue }
        answer: field(name: "answer") { jsonValue }
      }
    }
  }
}
```

### JobList.graphql
```graphql
query JobList($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    intro: field(name: "intro") { jsonValue }
    allJobsLink: field(name: "allJobsLink") { jsonValue }
    children(first: 10) {
      results {
        id
        title: field(name: "title") { jsonValue }
        location: field(name: "location") { jsonValue }
        link: field(name: "link") { jsonValue }
      }
    }
  }
}
```

### LocationsList.graphql
```graphql
query LocationsList($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    intro: field(name: "intro") { jsonValue }
    hqMapUrl: field(name: "hqMapUrl") { jsonValue }
    children(first: 60) {
      results {
        id
        name: field(name: "name") { jsonValue }
        address: field(name: "address") { jsonValue }
        city: field(name: "city") { jsonValue }
        state: field(name: "state") { jsonValue }
        postalCode: field(name: "postalCode") { jsonValue }
        phone: field(name: "phone") { jsonValue }
      }
    }
  }
}
```

### BenefitsCarousel.graphql
```graphql
query BenefitsCarousel($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    label: field(name: "label") { jsonValue }
    children(first: 20) {
      results {
        id
        icon: field(name: "icon") { jsonValue }
        title: field(name: "title") { jsonValue }
        text: field(name: "text") { jsonValue }
      }
    }
  }
}
```

### ContactForm.graphql
```graphql
query ContactForm($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    intro: field(name: "intro") { jsonValue }
    consentText: field(name: "consentText") { jsonValue }
    submitLabel: field(name: "submitLabel") { jsonValue }
    successMessage: field(name: "successMessage") { jsonValue }
    errorMessage: field(name: "errorMessage") { jsonValue }
    children(first: 10) {
      results {
        id
        label: field(name: "label") { jsonValue }
        redirectLink: field(name: "redirectLink") { jsonValue }
      }
    }
  }
}
```

### SubcontractorForm.graphql
```graphql
query SubcontractorForm($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    heading: field(name: "heading") { jsonValue }
    intro: field(name: "intro") { jsonValue }
    consentText: field(name: "consentText") { jsonValue }
    submitLabel: field(name: "submitLabel") { jsonValue }
    successMessage: field(name: "successMessage") { jsonValue }
    errorMessage: field(name: "errorMessage") { jsonValue }
    children(first: 30) {
      results {
        id
        label: field(name: "label") { jsonValue }
      }
    }
  }
}
```

### SiteHeader.graphql
```graphql
query SiteHeader($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    logo: field(name: "logo") { jsonValue }
    logoLink: field(name: "logoLink") { jsonValue }
    children(first: 8) {
      results {
        id
        title: field(name: "title") { jsonValue }
        link: field(name: "link") { jsonValue }
        children(first: 5) {
          results {
            id
            title: field(name: "title") { jsonValue }
            link: field(name: "link") { jsonValue }
          }
        }
      }
    }
  }
}
```

### SiteFooter.graphql
```graphql
query SiteFooter($datasource: String!, $language: String!) {
  datasource: item(path: $datasource, language: $language) {
    logo: field(name: "logo") { jsonValue }
    address: field(name: "address") { jsonValue }
    phone: field(name: "phone") { jsonValue }
    quickLinksHeading: field(name: "quickLinksHeading") { jsonValue }
    socialHeading: field(name: "socialHeading") { jsonValue }
    facebookLink: field(name: "facebookLink") { jsonValue }
    instagramLink: field(name: "instagramLink") { jsonValue }
    linkedinLink: field(name: "linkedinLink") { jsonValue }
    careersText: field(name: "careersText") { jsonValue }
    copyright: field(name: "copyright") { jsonValue }
    children(first: 8) {
      results {
        id
        link: field(name: "link") { jsonValue }
      }
    }
  }
}
```

