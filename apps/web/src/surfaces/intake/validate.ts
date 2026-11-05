/*
 * The checks the New project wizard and Project settings share, defined once. Each mirrors what the
 * Control API accepts (packages/contracts), so a value the page calls valid is one the API takes.
 */

/** A GitHub repository, "owner/name" (contracts: `Repo`). */
export const REPO = /^[\w.-]+\/[\w.-]+$/;

/** A slug field: lowercase letters, digits and dashes, starting with a letter or digit. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** A repository name on its own, as GitHub allows it (the build repository). */
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A live site: http or https, a host with a dot in it before any path, and no whitespace anywhere.
 *
 * The two old pages disagreed. Settings used this one; the wizard used
 * `/^https?:\/\/[^\s]+\.[^\s]+/`, which was unanchored at the end and let the dot fall anywhere,
 * so "https://localhost/a.html" and "https://a.com and more" passed and only failed at the API.
 * This, the stricter of the two, is the one both pages use now.
 */
export const SITE_URL = /^https?:\/\/[^\s/]+\.[^\s]+$/;

export const isRepo = (v: string) => REPO.test(v.trim());
export const isRepoName = (v: string) => REPO_NAME.test(v.trim());
export const isSiteUrl = (v: string) => SITE_URL.test(v.trim());

/** A name as a slug: lowercase, apostrophes dropped, anything else between words a dash. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Whether a value matches a field's own pattern, or the slug rule for a slug field. */
export function matchesField(
  value: string,
  spec: { pattern: string | null; kind: 'text' | 'list' | 'slug' },
): boolean {
  const pattern = spec.pattern ? new RegExp(spec.pattern) : spec.kind === 'slug' ? SLUG : null;
  return !pattern || pattern.test(value);
}

/** A positive number typed into a budget field. */
export const positive = (v: string) => Number(v) > 0;
