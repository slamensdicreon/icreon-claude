import type { OptimizelyVerifyConfig } from '@lw/connectors';
import { discoveryChecks as sharedDiscoveryChecks, type DiscoveryRules } from '../src/discovery';
import type { PlatformCheck } from '../src/index';

/**
 * Optimizely's part of the discovery checks (the reading of the source and of the project's
 * documents is shared, in ../src/discovery.ts). What is true on this platform:
 *
 * - The SDK has no built-in form. A form is a component the team builds (a content type with the
 *   form's fields, and somewhere for submissions to go) or a third-party form a component
 *   embeds, which the Director decides on.
 * - Redirects are the head's: the routing step adds one for each page kept with `attrs.redirect`,
 *   and `experience.redirects-resolve` checks it answers.
 * - The 404 page is the head's not-found page, written in the routing step from the inventory's
 *   `errorPage`. It is not a page in the CMS, so the Blueprint records it as dropped with the
 *   reason: a kept one gets a migration task for a page no visitor is ever shown.
 * - A source built on Sitecore's SDKs still embeds its layout data: its component names need a
 *   component each, as on any platform.
 */
const NOT_FOUND =
  "On this platform the 404 page is the head's not-found page (the routing step writes it from the inventory's errorPage), not a page in the CMS";

export const OPTIMIZELY_DISCOVERY: DiscoveryRules = {
  componentNames: (c) =>
    typeof c.attrs?.contentType === 'string' && c.attrs.contentType.trim()
      ? [c.attrs.contentType.trim()]
      : [],
  notFound: {
    problem: ({ kept, dropped }) => {
      if (kept.length)
        return `${kept.map((p) => `${p.key} (${String(p.attrs?.path ?? 'no path')})`).join(', ')} is the 404 page, kept as a page. ${NOT_FOUND}: record it with status "drop", attrs.path "/404", attrs.errorPage: 404 and attrs.reason saying so, so no page is migrated for it (the source's own URL for it is dropped the same way)`;
      if (!dropped.length)
        return `the Blueprint doesn't say what happens to the 404 page: add a page with attrs.path "/404", attrs.errorPage: 404, status "drop" and attrs.reason. ${NOT_FOUND}, so no page is migrated for it`;
      return null;
    },
    summary: 'the 404 page left to the head',
    decided: 'the 404 page is decided',
  },
  forms: {
    // No built-in form on this platform: nothing makes every form the Director's.
    builtIn: () => undefined,
    unplaced: ({ formComponents }) =>
      formComponents.length
        ? `List each in attrs.forms of the component that renders it (${formComponents.map((c) => c.name).join(', ')}): { "id", "pages", "fields" }, and "builtBy": "director" with the service for a third-party form it embeds, which the Director decides on`
        : `No component renders forms, and the SDK has no built-in one on this platform: add the component the team builds for them (a content type with the form's fields, and where submissions go as an open decision) or one that embeds the source's third-party form, and list each form in its attrs.forms ({ "id", "pages", "fields" }; an embedded one with "builtBy": "director" and the service)`,
    unmarked: () => '',
    noComponent:
      'add the component that renders them. On this platform a form is a content type the team builds, or a component that embeds a third-party form the Director decides on',
    component: (c) =>
      c.attrs?.builtIn === true
        ? `${c.name} is marked attrs.builtIn, but the SDK has no built-in form on this platform: specify it as a component the team builds (its content type and properties, and where submissions go), or as one that embeds a third-party form the Director decides on`
        : null,
    countDirectorItems: true,
  },
  redirects:
    'For each, keep its page with attrs.redirect naming where visitors go when the pages under it need it as their parent, or drop it (status "drop", attrs.reason). Redirects are the head\'s on this platform: the routing step adds a permanent one for each attrs.redirect, and experience.redirects-resolve checks it answers',
};

export function discoveryChecks(cfg: OptimizelyVerifyConfig): Record<string, PlatformCheck> {
  return sharedDiscoveryChecks(cfg, OPTIMIZELY_DISCOVERY);
}
