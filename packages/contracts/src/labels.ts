/**
 * The few values the Control Center needs at runtime, without the schemas: importing them from
 * here keeps zod and every contract out of the web app's bundle.
 */
import type { DecisionCategory } from './enums';
import type { BriefQuestion } from './playbooks';

export const DECISION_CATEGORY_LABEL: Record<DecisionCategory, string> = {
  media: 'Media sources',
  tool: 'Tool problems',
  retry: 'Retries after rejection',
  ownership: 'Ownership and missing work',
  naming: 'Naming and structure',
  content: 'Content within the Blueprint',
  access: 'Access and permissions',
  scope: 'Scope',
  release: 'Releases, gates and budget',
  other: 'Other',
};

/** The feature a project has when it was given a source repository at intake. */
export const SOURCE_REPO = 'source-repo';

/** Whether a brief question is asked of a project with these features. */
export function briefApplies(
  q: Pick<BriefQuestion, 'when' | 'unless'>,
  features: readonly string[],
): boolean {
  return (!q.when || features.includes(q.when)) && (!q.unless || !features.includes(q.unless));
}
