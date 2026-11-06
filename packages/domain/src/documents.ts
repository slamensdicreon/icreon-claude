/**
 * Documents in plain words, for "the story so far": who a document is for, and a short title a
 * non-technical reader can scan. Agents may say both when they save; older documents (and agents
 * that say neither) fall back to these rules, from the kind and the title alone.
 */

export type Audience = 'director' | 'team';

const TEAM_REPORT =
  /conformance|validat|lighthouse|parity|accessib|perf|check|audit log|lint|test/i;
const DIRECTOR_INVENTORY = /content|route|page|sitemap|site map/i;

/** Who a document is written for: the Director (plans, results, briefings) or the team. */
export function audienceOf(kind: string, title: string): Audience {
  switch (kind) {
    case 'blueprint':
    case 'platform_notes':
    case 'handover_pack':
      return 'director';
    case 'report':
      return TEAM_REPORT.test(title) ? 'team' : 'director';
    case 'inventory':
      return DIRECTOR_INVENTORY.test(title) ? 'director' : 'team';
    default:
      // Pull requests, screenshots, videos and anything newer: the team's.
      return 'team';
  }
}

/** A pull request's title leads with its number ("12 Register batch 2 renderings"). */
const withoutNumber = (t: string) => t.replace(/^#?\d+\s+/, '');
const sentence = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/** A short title in plain words, from the kind and the document's own title. */
export function headlineOf(kind: string, title: string): string {
  const t = title.trim();
  switch (kind) {
    case 'blueprint':
      return 'How the site gets rebuilt';
    case 'platform_notes':
      return 'What makes this site different';
    case 'handover_pack':
      return 'The handover pack';
    case 'pull_request':
      return `Code: ${sentence(withoutNumber(t)).replace(/^Code:\s*/i, '')}`;
    case 'inventory': {
      if (/route|content/i.test(t)) return 'What content moves, and where';
      if (/page/i.test(t)) return 'Every page on the site';
      if (/component/i.test(t)) return 'Component list';
      if (/media|asset|image/i.test(t)) return 'Media list';
      if (/template/i.test(t)) return 'Template list';
      return sentence(t.replace(/\s*inventory$/i, ' list'));
    }
    case 'report': {
      const batch = /batch\s*(\d+)/i.exec(t)?.[1];
      if (/conformance/i.test(t)) return batch ? `Quality check, batch ${batch}` : 'Quality check';
      if (/pilot/i.test(t)) return 'Pilot results';
      return sentence(t.replace(/\s*report$/i, ''));
    }
    default:
      return sentence(t);
  }
}

/** Minutes to read a text, at an easy pace; at least one. */
export function readMinutes(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
