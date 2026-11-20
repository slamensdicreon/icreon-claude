/*
 * The nouns that differ by platform, for copy that has to name them: the vendor, the CMS's visual
 * page editor and the delivery API. Chosen by the platform pack's id; a project whose platform is
 * unknown gets neutral words, never another platform's.
 */

export interface PlatformTerms {
  /** The vendor, as a sentence names it: "Sitecore", "Optimizely". */
  vendor: string;
  /** Where editors put pages together: "Page builder", "Visual Builder". */
  editor: string;
  /** The API the site reads published content from: "Experience Edge", "Optimizely Graph". */
  delivery: string;
}

const NEUTRAL: PlatformTerms = {
  vendor: 'the platform',
  editor: 'the CMS’s page editor',
  delivery: 'the delivery API',
};

const TERMS: Record<string, PlatformTerms> = {
  sitecoreai: { vendor: 'Sitecore', editor: 'Page builder', delivery: 'Experience Edge' },
  optimizely: { vendor: 'Optimizely', editor: 'Visual Builder', delivery: 'Optimizely Graph' },
};

/** The platform's own nouns, by its id (`project.platform?.id`); neutral ones when unknown. */
export const platformTerms = (platformId: string | null | undefined): PlatformTerms =>
  (platformId && TERMS[platformId]) || NEUTRAL;
