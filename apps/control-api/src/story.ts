import type { ArtifactView, StoryPhase, WorkbenchSnapshot, WorkbenchStory } from '@lw/contracts';
import { audienceOf, headlineOf, type ProjectState } from '@lw/domain';
import { personOf } from './enrich';
import { CountWord, countWord } from './voice';

/*
 * The Workbench as the story of the work (the "story so far"): each document in plain words (a
 * short title, who it is for, who wrote it, the phase it began in, whether it moved past what the
 * Director approved), and the phases newest first, each with one line, the approvals given in it,
 * its documents for the Director and its working files. Older projects get the same story: the
 * phase falls back to the one under way when the document was first saved, and titles and
 * audiences fall back to rules on the document's kind and title.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const latestOf = (a: ArtifactView) =>
  a.versions.find((v) => v.version === a.latest) ?? a.versions[0];
const firstOf = (a: ArtifactView) => a.versions[a.versions.length - 1];
const at = (a: ArtifactView) => latestOf(a)?.ts ?? '';

/** The phase under way at a moment: the newest phase entered at or before it. */
function phaseAt(s: ProjectState, ts: string): number | null {
  let best: { n: number; at: string } | null = null;
  for (const p of Object.values(s.phases)) {
    if (!p.enteredAt || p.enteredAt > ts) continue;
    if (!best || p.enteredAt > best.at || (p.enteredAt === best.at && p.number > best.n))
      best = { n: p.number, at: p.enteredAt };
  }
  return best?.n ?? null;
}

/** Each document in plain words. Keeps whatever the API already set (summary, pointers). */
export function withDocumentFacts(wb: WorkbenchSnapshot, s: ProjectState): WorkbenchSnapshot {
  return {
    ...wb,
    artifacts: wb.artifacts.map((a) => {
      const latest = latestOf(a);
      const first = firstOf(a);
      // The agent's words win, newest version first; else the rules.
      const said = a.versions.find((v) => v.headline)?.headline ?? null;
      const audience = a.versions.find((v) => v.audience)?.audience ?? audienceOf(a.kind, a.title);
      const phase =
        first?.phase ??
        (first ? phaseAt(s, first.ts) : null) ??
        (latest ? phaseAt(s, latest.ts) : null);
      const agent = latest ? s.agents[latest.producer] : undefined;
      const approved = a.approved[0];
      return {
        ...a,
        headline: said ?? headlineOf(a.kind, a.title),
        audience,
        phase,
        changedSinceApproval: !!approved && approved.version < a.latest,
        ...(latest?.explained?.inShort ? { inShort: latest.explained.inShort } : {}),
        author: agent
          ? {
              agentId: agent.agentId,
              name: agent.tier === 'chief_of_staff' ? 'Cypher' : personOf(agent),
              role: agent.name,
            }
          : null,
      };
    }),
  };
}

/** A document as a noun in a sentence ("the build plan", "“Pilot results”"). */
function nounOf(a: ArtifactView): string {
  if (a.kind === 'blueprint') return 'the build plan';
  if (a.kind === 'platform_notes') return 'the briefing';
  if (a.kind === 'handover_pack') return 'the handover pack';
  return `“${a.headline ?? a.title}”`;
}
const upper = (t: string) =>
  t.replace(/^([“"]?)([a-z])/, (_, q: string, c: string) => q + c.toUpperCase());

/** The first sentence of a text, for a phase's one line. */
function firstSentence(t: string | undefined): string | null {
  if (!t) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(t.trim());
  return (m?.[1] ?? t.trim()).slice(0, 220);
}

/** The story: phases newest first, what to read first, who wrote what, what comes next. */
export function workbenchStory(wb: WorkbenchSnapshot, s: ProjectState): WorkbenchStory {
  const docs = wb.artifacts;
  const byPhase = new Map<number | null, ArtifactView[]>();
  for (const a of docs) {
    const k = a.phase ?? null;
    if (!byPhase.has(k)) byPhase.set(k, []);
    byPhase.get(k)!.push(a);
  }
  const newest = (xs: ArtifactView[]) => [...xs].sort((x, y) => at(y).localeCompare(at(x)));

  // Approvals, as milestones in the phase they were given in.
  const milestones = new Map<number | null, StoryPhase['milestones']>();
  for (const a of docs)
    for (const ap of a.approved) {
      const k = phaseAt(s, ap.at);
      if (!milestones.has(k)) milestones.set(k, []);
      milestones.get(k)!.push({ label: `You approved ${nounOf(a)} at ${ap.gate}`, at: ap.at });
    }

  const phaseDefs = Object.values(s.phases).sort((x, y) => y.number - x.number);
  const phases: StoryPhase[] = [];
  for (const p of phaseDefs) {
    const mine = newest(byPhase.get(p.number) ?? []);
    const ms = milestones.get(p.number) ?? [];
    // Only phases that began or produced something; the future stays out of the story.
    if (!p.enteredAt && !mine.length && !ms.length) continue;
    const forYou = mine.filter((a) => a.audience === 'director');
    const files = mine.filter((a) => a.audience !== 'director');
    // One line on the phase only when it says more than its cards would: a phase whose only
    // document for the Director is a card already says it there.
    const line = forYou.length > 1 ? firstSentence(forYou[0]?.summary) : null;
    phases.push({
      number: p.number,
      name: p.name,
      status: p.status,
      at: p.enteredAt,
      line,
      milestones: ms.sort((x, y) => y.at.localeCompare(x.at)),
      docs: forYou.map((a) => a.artifactId),
      files: files.map((a) => a.artifactId),
    });
  }
  // Documents from before any phase began (an older project, or a pilot run outside the plan).
  const early = newest(byPhase.get(null) ?? []);
  if (early.length || milestones.get(null)?.length)
    phases.push({
      number: -1,
      name: 'Before the phases',
      status: 'done',
      at: early.length ? (firstOf(early[early.length - 1]!)?.ts ?? null) : null,
      line: firstSentence(early.find((a) => a.audience === 'director')?.summary),
      milestones: milestones.get(null) ?? [],
      docs: early.filter((a) => a.audience === 'director').map((a) => a.artifactId),
      files: early.filter((a) => a.audience !== 'director').map((a) => a.artifactId),
    });

  // What to read first: what waits on the Director, what moved past their approval, then the
  // documents for them in the order the work happened.
  const forYou = docs.filter((a) => a.audience === 'director');
  const inOrder = [...forYou].sort(
    (x, y) =>
      (x.phase ?? -1) - (y.phase ?? -1) ||
      (firstOf(x)?.ts ?? '').localeCompare(firstOf(y)?.ts ?? ''),
  );
  const picks: WorkbenchStory['startHere'] = [];
  const add = (a: ArtifactView | undefined, why: string) => {
    if (a && picks.length < 3 && !picks.some((p) => p.artifactId === a.artifactId))
      picks.push({ artifactId: a.artifactId, why });
  };
  for (const a of forYou.filter((x) => x.awaitingApproval)) add(a, 'Waits on your approval');
  for (const a of forYou.filter((x) => x.changedSinceApproval))
    add(a, 'Changed since you approved it');
  add(
    forYou.find((x) => x.kind === 'blueprint'),
    'The plan everything follows',
  );
  add(newest(forYou)[0], 'The newest for you');
  for (const a of inOrder) add(a, 'Where it started');

  // Who wrote what, most first.
  const counts = new Map<string, number>();
  for (const a of docs)
    if (a.author) counts.set(a.author.agentId, (counts.get(a.author.agentId) ?? 0) + 1);
  const authors = [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([agentId, count]) => {
      const a = docs.find((d) => d.author?.agentId === agentId)!.author!;
      return { ...a, count };
    });

  // The phase after the newest current one.
  const ordered = Object.values(s.phases).sort((x, y) => x.number - y.number);
  const lastCurrent = [...ordered].reverse().find((p) => p.status === 'current');
  const upcoming = ordered.find(
    (p) => p.status === 'future' && (!lastCurrent || p.number > lastCurrent.number),
  );
  const tasksOf = (n: number) => Object.values(s.tasks).filter((t) => t.phase === n);
  const next = upcoming
    ? {
        number: upcoming.number,
        name: upcoming.name,
        percent: null,
        tasks: tasksOf(upcoming.number).length,
      }
    : null;

  // Cypher's sentence.
  const begun = ordered.filter((p) => p.status !== 'future' && p.number > 0).length;
  const head = docs.length
    ? `${begun ? `${CountWord(begun)} ${plural(begun, 'phase', 'phases')} in, the` : 'The'} team has written ${countWord(docs.length)} ${plural(docs.length, 'document', 'documents')}, ${countWord(forYou.length)} of them for you.`
    : 'No documents yet. They appear here as the team writes them.';
  const waiting = forYou.find((a) => a.awaitingApproval);
  const moved = forYou.find((a) => a.changedSinceApproval);
  const first = picks[0] ? docs.find((a) => a.artifactId === picks[0]!.artifactId) : undefined;
  const emphasis = waiting
    ? `${upper(nounOf(waiting))} waits on your approval.`
    : moved
      ? `${upper(nounOf(moved))} changed since you approved it.`
      : first
        ? `Start with ${nounOf(first)}.`
        : null;
  return {
    voice: { text: emphasis ? `${head} ${emphasis}` : head, emphasis, closing: null },
    phases,
    startHere: picks,
    authors,
    next,
  };
}
