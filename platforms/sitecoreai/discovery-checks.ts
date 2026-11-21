import type { VerifyConfig } from '@lw/connectors';
import {
  discoveryChecks as sharedDiscoveryChecks,
  few,
  itemPath,
  type DiscoveryRules,
} from '../src/discovery';
import type { PlatformCheck } from '../src/index';
import { renderingName } from './checks';

/**
 * SitecoreAI's part of the discovery checks (the reading of the source and of the project's
 * documents is shared, in ../src/discovery.ts): a form is the SDK's built-in Form, made in
 * SitecoreAI Forms by the Director; a redirect is added by the experience step; the 404 page is a
 * page item at /404, which Next.js never serves at its own path.
 */
export const SITECOREAI_DISCOVERY: DiscoveryRules = {
  componentNames: (c) => [renderingName(c)],
  notFound: {
    // The 404 page: Next.js reserves /404, so the page item never renders at its own path.
    // A 404 page recorded as dropped is a decision too (the homepage demo builds none).
    problem: ({ kept, dropped }) => {
      const misplaced = kept.filter((p) => itemPath(p) !== '/404');
      if (!kept.length && !dropped.length)
        return `the Blueprint plans no 404 page: add a page with attrs.path "/404" and attrs.errorPage: 404 (copy from the inventory's errorPage). Next.js reserves /404, so the page never renders at its own path: the site's error-handling setting points at it, and it is checked at a URL that doesn't exist`;
      if (kept.length && misplaced.length === kept.length)
        return `${misplaced.map((p) => `${p.key} (${itemPath(p) ?? 'no path'})`).join(', ')} is the 404 page: give it attrs.path "/404" (and drop the source's own URL for it). Next.js reserves /404, so the page renders only through the site's error-handling setting, at a URL that doesn't exist, which is where it is checked`;
      return null;
    },
    summary: 'the 404 page at /404',
    decided: 'the 404 page is planned',
  },
  forms: {
    builtIn: (formComponents) => formComponents.find((c) => c.attrs?.builtIn === true),
    unplaced: ({ builtIn, formComponents }) =>
      builtIn
        ? `${builtIn.name} keeps the SDK's built-in Form (attrs.builtIn), so each is a Director item, built by hand in SitecoreAI Forms before UAT: list each in its attrs.forms ({ "id", "pages", "fields", "builtBy": "director" })`
        : formComponents.length
          ? `List each in attrs.forms of the component that renders it (${formComponents.map((c) => c.name).join(', ')})`
          : `No component renders forms: add Form as the SDK's built-in (attrs.builtIn: true; each form is then a Director item made in SitecoreAI Forms) and list each in its attrs.forms ({ "id", "pages", "fields", "builtBy": "director" })`,
    unmarked: (builtIn, forms) =>
      `${builtIn.name} keeps the SDK's built-in Form (attrs.builtIn), so ${few(forms, 3)} ${forms.length === 1 ? 'is a Director item' : 'are Director items'} (SitecoreAI Forms, built by hand before UAT): mark ${forms.length === 1 ? 'its attrs.forms entry' : 'their attrs.forms entries'} "builtBy": "director"`,
    noComponent:
      "add Form as the SDK's built-in (attrs.builtIn: true; its forms are Director items made in SitecoreAI Forms) or the component that renders them",
    countDirectorItems: false,
  },
  redirects:
    'For each, keep its page as a structural parent with attrs.redirect naming where visitors go (the experience step adds the redirect), or drop it (status "drop", attrs.reason)',
};

export function discoveryChecks(cfg: VerifyConfig): Record<string, PlatformCheck> {
  return sharedDiscoveryChecks(cfg, SITECOREAI_DISCOVERY);
}
