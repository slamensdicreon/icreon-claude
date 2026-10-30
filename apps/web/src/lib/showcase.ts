import type { PlaybookSummary } from '@lw/contracts';

/**
 * The catalog as the Control Center presents it: the entities and playbooks that exist today
 * come from the API; the ones on the roadmap are listed here so the catalog reads as a whole.
 * A roadmap tile is readable (title, what it would deliver) and disabled: nothing can start on it.
 */

export interface CatalogEntity {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  /** `ready` when at least one playbook can run today. */
  status: 'ready' | 'coming';
}

export interface CatalogPlaybook {
  id: string;
  entityId: string;
  name: string;
  description: string;
  status: 'ready' | 'coming';
  /** The API's summary, for a playbook that can run today. */
  summary: PlaybookSummary | null;
}

export interface CatalogGroup {
  entity: CatalogEntity;
  playbooks: CatalogPlaybook[];
}

/** Entities on the roadmap: not in the API yet. */
const ROADMAP_ENTITIES: Omit<CatalogEntity, 'status'>[] = [
  {
    id: 'contentful',
    name: 'Contentful',
    vendor: 'Contentful',
    category: 'Headless CMS, SaaS',
    description:
      'Content models and entries in one space, pages composed in Contentful Studio with Live Preview, delivered through the Delivery and GraphQL APIs to a Next.js head.',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    vendor: 'Salesforce',
    category: 'CRM, experience and commerce clouds',
    description:
      'Experience Cloud sites, Sales and Service Cloud, Marketing Cloud and Commerce Cloud on one org, with Data Cloud and Agentforce as the data and agent layer.',
  },
];

/** Playbooks on the roadmap, by entity. The two that run today are not listed: the API has them. */
const ROADMAP_PLAYBOOKS: Omit<CatalogPlaybook, 'status' | 'summary'>[] = [
  // SitecoreAI
  {
    id: 'sitecoreai-xp-to-xmcloud',
    entityId: 'sitecoreai',
    name: 'Migrate Sitecore XP or XM to SitecoreAI',
    description:
      'Moves an MVC or SXA site off a self-hosted Sitecore instance: content and media exported, templates mapped to headless renderings, the head rebuilt on the Content SDK, with a parity gate before cutover.',
  },
  {
    id: 'sitecoreai-additional-site',
    entityId: 'sitecoreai',
    name: 'Launch another site on an existing tenant',
    description:
      'A second brand or market on a collection already in use: shared components reused, new page designs, its own editing host and languages, without touching the sites beside it.',
  },
  {
    id: 'sitecoreai-personalize',
    entityId: 'sitecoreai',
    name: 'Personalization with Sitecore Personalize and CDP',
    description:
      'Audiences, page variants and A/B/n tests on a live site: the components made datasource-driven, the proof variant published, and marketers trained to run experiments in Page builder.',
  },
  {
    id: 'sitecoreai-search',
    entityId: 'sitecoreai',
    name: 'Site search on Sitecore Search',
    description:
      'Replaces a bolted-on search with Sitecore Search: sources crawled, the index tuned, a results component with facets and suggestions, and the editor-side controls for synonyms and pins.',
  },
  {
    id: 'sitecoreai-component-library',
    entityId: 'sitecoreai',
    name: 'Component library and design system',
    description:
      'A governed library of Content SDK components with variants, rendering parameters and starter content, documented for marketers and shared across the sites on a tenant.',
  },
  {
    id: 'sitecoreai-localization',
    entityId: 'sitecoreai',
    name: 'Add languages and a translation workflow',
    description:
      'New language versions with fallbacks, dictionary entries, language-aware routing on the head, and a workflow that hands content to translators and back.',
  },
  {
    id: 'sitecoreai-content-hub',
    entityId: 'sitecoreai',
    name: 'Connect Content Hub DAM',
    description:
      'Media moved to Content Hub and served from it: the DAM connector configured, renditions mapped, existing media references rewritten, and rights metadata carried over.',
  },
  {
    id: 'sitecoreai-forms',
    entityId: 'sitecoreai',
    name: 'Forms and lead capture',
    description:
      'Sitecore Forms or a hosted form service wired into the head: every form on the source site rebuilt, submissions routed to the client’s systems, spam protection and consent in place.',
  },
  {
    id: 'sitecoreai-seo-redirects',
    entityId: 'sitecoreai',
    name: 'SEO, redirects and analytics hardening',
    description:
      'Redirect maps from the old URLs, structured data, sitemaps and robots, canonical rules, and analytics and consent configured so rankings survive the move.',
  },
  {
    id: 'sitecoreai-performance-a11y',
    entityId: 'sitecoreai',
    name: 'Performance and accessibility remediation',
    description:
      'Core Web Vitals and WCAG findings on a live site worked down to a budget: images, fonts, scripts and components fixed, with before-and-after reports as evidence.',
  },
  {
    id: 'sitecoreai-operate',
    entityId: 'sitecoreai',
    name: 'Operate and optimize a SitecoreAI site',
    description:
      'A continuous engagement after launch: a backlog of marketer requests, monthly experiments and performance reviews, dependency upgrades and releases on a cadence.',
  },
  {
    id: 'sitecoreai-commerce',
    entityId: 'sitecoreai',
    name: 'Storefront with OrderCloud',
    description:
      'Catalog, cart and checkout on OrderCloud behind the SitecoreAI head: product pages composed by marketers, pricing and inventory from the commerce API, orders into the client’s ERP.',
  },
  // Optimizely
  {
    id: 'optimizely-cms12-to-saas',
    entityId: 'optimizely',
    name: 'Migrate Optimizely CMS 12 to CMS (SaaS)',
    description:
      'Content types and content exported from a PaaS instance, Razor views rebuilt as SDK components, Visual Builder experiences for the composed pages, and Graph as the delivery layer.',
  },
  {
    id: 'optimizely-experimentation',
    entityId: 'optimizely',
    name: 'Experimentation with Web and Feature Experimentation',
    description:
      'Experiments on a SaaS CMS site: the SDK wired, audiences and metrics defined, a first set of tests run on the pilot pages, and a program the client’s team can continue.',
  },
  {
    id: 'optimizely-graph-search',
    entityId: 'optimizely',
    name: 'Site search and recommendations on Optimizely Graph',
    description:
      'Search built on Graph’s full-text and semantic queries: a results experience with facets, synonyms and pinned results, and recommendations from content relationships.',
  },
  {
    id: 'optimizely-forms',
    entityId: 'optimizely',
    name: 'Forms with the JavaScript SDK',
    description:
      'Every form on the source site rebuilt with Optimizely Forms rendered through the SDK, multi-step where needed, submissions to the client’s endpoint, consent and anti-spam in place.',
  },
  {
    id: 'optimizely-dam',
    entityId: 'optimizely',
    name: 'Adopt Optimizely DAM',
    description:
      'Media into the DAM with renditions and usage tracking: assets migrated, pickers enabled on image and link properties, and Graph delivering public URLs.',
  },
  {
    id: 'optimizely-visual-builder-enablement',
    entityId: 'optimizely',
    name: 'Visual Builder enablement for marketers',
    description:
      'Blueprints, display templates and styles that make composing fast and on-brand, with a component catalog and a training path for the client’s editors.',
  },
  {
    id: 'optimizely-localization',
    entityId: 'optimizely',
    name: 'Locales and fallback languages',
    description:
      'New locales with global fallbacks, localized properties on the content types, locale routing in the head, and a translation handoff through the REST API.',
  },
  {
    id: 'optimizely-cmp-workflows',
    entityId: 'optimizely',
    name: 'Content Marketing Platform workflows',
    description:
      'Planning, briefs and approvals in CMP flowing into CMS (SaaS) content: the connector configured, tasks mapped to content types, and publishing gated by CMP approvals.',
  },
  {
    id: 'optimizely-seo-redirects',
    entityId: 'optimizely',
    name: 'SEO, redirects and analytics hardening',
    description:
      'Redirects from the old URLs in the head, structured data and sitemaps from Graph, canonical rules, and analytics and consent configured before cutover.',
  },
  {
    id: 'optimizely-performance-a11y',
    entityId: 'optimizely',
    name: 'Performance and accessibility remediation',
    description:
      'Core Web Vitals and WCAG findings on a live site worked down to a budget, component by component, with the reports as evidence.',
  },
  {
    id: 'optimizely-operate',
    entityId: 'optimizely',
    name: 'Operate and optimize an Optimizely site',
    description:
      'A continuous engagement after launch: marketer requests, experiments and performance reviews on a cadence, SDK and dependency upgrades, releases through the same gates.',
  },
  {
    id: 'optimizely-commerce',
    entityId: 'optimizely',
    name: 'Storefront with Configured Commerce',
    description:
      'Catalog, pricing and checkout from Configured Commerce behind the SaaS CMS head: product and category pages composed in Visual Builder, orders into the client’s ERP.',
  },
  // Contentful
  {
    id: 'contentful-migration',
    entityId: 'contentful',
    name: 'Build a Contentful website',
    description:
      'Rebuilds a live site on Contentful: a governed content model, components in a Next.js head with Live Preview, pages composed in Studio, and a parity-checked content migration.',
  },
  {
    id: 'contentful-wordpress-migration',
    entityId: 'contentful',
    name: 'Migrate WordPress to Contentful',
    description:
      'Posts, pages, media and taxonomies exported from WordPress, modelled as content types, migrated with the Management API, and served from a new head with redirects from every old URL.',
  },
  {
    id: 'contentful-content-model',
    entityId: 'contentful',
    name: 'Content model design and governance',
    description:
      'A content model built from the editorial needs: types, references and validations, roles and workflows, environment strategy and migration scripts under version control.',
  },
  {
    id: 'contentful-studio-enablement',
    entityId: 'contentful',
    name: 'Contentful Studio enablement',
    description:
      'Studio experiences, design tokens and component registration so marketers compose pages themselves, with patterns, a catalog and training for the editorial team.',
  },
  {
    id: 'contentful-localization',
    entityId: 'contentful',
    name: 'Locales and translation workflow',
    description:
      'Locales with fallbacks, field-level localization decisions, locale routing in the head, and a translation vendor connected through an app or the Management API.',
  },
  {
    id: 'contentful-personalization',
    entityId: 'contentful',
    name: 'Personalization with Ninetailed',
    description:
      'Audiences and experiences on Contentful content: the Ninetailed app installed, components made variant-aware, a proof experiment run, and insights wired to analytics.',
  },
  {
    id: 'contentful-search',
    entityId: 'contentful',
    name: 'Site search with Algolia',
    description:
      'Entries indexed to Algolia on publish, a search experience with facets and suggestions in the head, and the editor controls for synonyms and merchandising rules.',
  },
  {
    id: 'contentful-dam',
    entityId: 'contentful',
    name: 'DAM connections and asset governance',
    description:
      'Bynder or Cloudinary connected to the space: asset pickers on media fields, existing assets migrated or linked, renditions and rights metadata carried over.',
  },
  {
    id: 'contentful-multisite',
    entityId: 'contentful',
    name: 'Multi-brand sites on one organization',
    description:
      'Several brands or markets from shared and per-site spaces: a space topology, shared content types, one head with site-aware routing, and per-brand theming.',
  },
  {
    id: 'contentful-apps',
    entityId: 'contentful',
    name: 'Custom apps and editorial workflows',
    description:
      'Apps built on the App Framework for the editorial gaps: custom field editors, sidebar tools, workflow states and integrations, installed and documented for the client.',
  },
  {
    id: 'contentful-seo-redirects',
    entityId: 'contentful',
    name: 'SEO, redirects and analytics hardening',
    description:
      'Redirects from the old URLs, SEO fields on every page type, structured data, sitemaps and canonical rules, with analytics and consent configured before cutover.',
  },
  {
    id: 'contentful-performance-a11y',
    entityId: 'contentful',
    name: 'Performance and accessibility remediation',
    description:
      'Core Web Vitals and WCAG findings on a live site worked down to a budget, with image delivery, fonts and components fixed and the reports as evidence.',
  },
  {
    id: 'contentful-operate',
    entityId: 'contentful',
    name: 'Operate and optimize a Contentful site',
    description:
      'A continuous engagement after launch: editorial requests, model changes through migrations, performance reviews and dependency upgrades on a cadence.',
  },
  // Salesforce
  {
    id: 'salesforce-experience-cloud-site',
    entityId: 'salesforce',
    name: 'Build an Experience Cloud site',
    description:
      'A customer or partner portal on Experience Cloud with LWR: the brand applied, Lightning web components for the journeys, CRM data surfaced with the right sharing, and self-service flows.',
  },
  {
    id: 'salesforce-sales-cloud',
    entityId: 'salesforce',
    name: 'Sales Cloud implementation',
    description:
      'Leads, accounts, opportunities and forecasting set up for the client’s sales process: objects and automation, data migrated from the old CRM, dashboards and user training.',
  },
  {
    id: 'salesforce-service-cloud',
    entityId: 'salesforce',
    name: 'Service Cloud with cases and knowledge',
    description:
      'Case management across email, web and chat: queues and routing, a knowledge base, entitlements and SLAs, and a service console the team adopts from day one.',
  },
  {
    id: 'salesforce-marketing-cloud',
    entityId: 'salesforce',
    name: 'Marketing Cloud Engagement journeys',
    description:
      'Data extensions, the contact model and journeys built from the client’s lifecycle: email and SMS templates, consent handled, and reporting back into the CRM.',
  },
  {
    id: 'salesforce-account-engagement',
    entityId: 'salesforce',
    name: 'Account Engagement with web forms',
    description:
      'B2B marketing automation connected to the website and the CRM: forms and landing pages, scoring and grading, nurture programs, and sales alerts.',
  },
  {
    id: 'salesforce-b2c-commerce',
    entityId: 'salesforce',
    name: 'B2C Commerce storefront',
    description:
      'A composable storefront on the PWA Kit against B2C Commerce: catalog, search, cart and checkout, payments and tax, with the CMS content beside the products.',
  },
  {
    id: 'salesforce-b2b-commerce',
    entityId: 'salesforce',
    name: 'B2B Commerce on Lightning',
    description:
      'Account-specific catalogs and pricing, reorders and approvals for business buyers, on an Experience Cloud storefront connected to the ERP.',
  },
  {
    id: 'salesforce-data-cloud',
    entityId: 'salesforce',
    name: 'Data Cloud unification',
    description:
      'Customer data from the CRM, web and commerce unified in Data Cloud: identity resolution, calculated insights and segments activated into Marketing Cloud and the site.',
  },
  {
    id: 'salesforce-agentforce',
    entityId: 'salesforce',
    name: 'Agentforce agents for service and sales',
    description:
      'Agents grounded in the client’s knowledge and CRM data: topics and actions designed, guardrails tested, handoff to people defined, and the agents launched on the site and in the console.',
  },
  {
    id: 'salesforce-revenue-cloud',
    entityId: 'salesforce',
    name: 'Revenue Cloud and CPQ',
    description:
      'Products, price books and rules for configure, price and quote: quote templates, approvals and contracts, connected to billing and the ERP.',
  },
  {
    id: 'salesforce-mulesoft-integration',
    entityId: 'salesforce',
    name: 'Integration with MuleSoft',
    description:
      'APIs and flows between the org and the client’s systems: ERP, identity, web and data warehouse, with monitoring, error handling and a catalog of reusable APIs.',
  },
  {
    id: 'salesforce-org-health',
    entityId: 'salesforce',
    name: 'Org health, security and technical debt',
    description:
      'An org assessed and remediated: unused fields and automations, security settings and permissions, Apex and flow debt, release process and documentation.',
  },
  {
    id: 'salesforce-operate',
    entityId: 'salesforce',
    name: 'Managed services for a Salesforce org',
    description:
      'A continuous engagement: a backlog of admin and development requests, release cadence, user support, and quarterly reviews against the roadmap.',
  },
];

/**
 * The whole catalog, entities in order: the API's first (they can run), then the roadmap's.
 * Within an entity, the API's playbooks come before the roadmap's.
 */
export function catalogGroups(api: PlaybookSummary[]): CatalogGroup[] {
  const groups: CatalogGroup[] = [];
  for (const p of api) {
    let g = groups.find((x) => x.entity.id === p.platform.id);
    if (!g) {
      g = { entity: { ...p.platform, status: 'ready' }, playbooks: [] };
      groups.push(g);
    }
    g.playbooks.push({
      id: p.id,
      entityId: p.platform.id,
      name: p.name,
      description: p.description,
      status: 'ready',
      summary: p,
    });
  }
  for (const e of ROADMAP_ENTITIES) {
    if (!groups.some((g) => g.entity.id === e.id))
      groups.push({ entity: { ...e, status: 'coming' }, playbooks: [] });
  }
  for (const r of ROADMAP_PLAYBOOKS) {
    const g = groups.find((x) => x.entity.id === r.entityId);
    if (g && !g.playbooks.some((p) => p.id === r.id))
      g.playbooks.push({ ...r, status: 'coming', summary: null });
  }
  return groups;
}

/** "1 ready · 11 coming" for an entity tile. */
export function readiness(g: CatalogGroup): string {
  const ready = g.playbooks.filter((p) => p.status === 'ready').length;
  const coming = g.playbooks.length - ready;
  return [
    ready ? `${ready} ${ready === 1 ? 'playbook' : 'playbooks'} ready` : null,
    coming ? `${coming} coming` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
