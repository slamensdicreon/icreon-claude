import { describe, expect, it } from 'vitest';
import {
  cardSubject,
  choiceWords,
  clip,
  clockWord,
  countWord,
  countsAsWords,
  firstNameOf,
  firstSentence,
  handledLine,
  handledSummary,
  initialsOf,
  leadRead,
  missionVoice,
  portfolioVoice,
  projectRead,
  recommendationFor,
  shortClock,
  untilWord,
  workingWord,
  yoursNote,
  type ProjectReadInput,
} from '../src/voice';

const TZ = 'America/New_York';
/** Tuesday, November 3, 2026, 11:42 AM in New York. */
const MORNING = Date.parse('2026-11-03T16:42:00Z');
/** The same day, 6:10 PM. */
const EVENING = Date.parse('2026-11-03T23:10:00Z');
/** 2:24 PM that day. */
const AT_224 = Date.parse('2026-11-03T19:24:00Z');

const voiceRules = (v: { text: string; emphasis: string | null; closing: string | null }) => {
  if (v.emphasis) expect(v.text).toContain(v.emphasis);
  // Cypher never apologises and never narrates its process.
  expect(`${v.text} ${v.closing ?? ''}`).not.toMatch(/sorry|apolog|processing|computing|I am now/i);
};

describe('words', () => {
  it('says counts under thirteen as words and larger ones as digits', () => {
    expect([0, 1, 3, 11, 12].map(countWord)).toEqual(['zero', 'one', 'three', 'eleven', 'twelve']);
    expect(countWord(13)).toBe('13');
    expect(countWord(1506)).toBe('1,506');
  });

  it('writes small counts in borrowed text as words, but not numbers that name things', () => {
    expect(countsAsWords('Approving confirms the pattern for the remaining 12 renderings.')).toBe(
      'Approving confirms the pattern for the remaining twelve renderings.',
    );
    expect(countsAsWords('Retry them in phase 9 after 3 builds')).toBe(
      'Retry them in phase 9 after three builds',
    );
    expect(countsAsWords('Preview 7 is queued; 24 pages placed; batch 2 items')).toBe(
      'Preview 7 is queued; 24 pages placed; batch 2 items',
    );
    expect(countsAsWords('It returned 403 errors')).toBe('It returned 403 errors');
  });

  it('names people by first name, with initials for their face', () => {
    expect(firstNameOf('Emily Chen')).toBe('Emily');
    expect(initialsOf('Emily Chen')).toBe('EC');
    expect(initialsOf('Mary Ann de la Cruz')).toBe('MC');
    expect(initialsOf('Cypher')).toBe('C');
  });

  it('keeps the first sentence and clips long ones at a clause', () => {
    expect(firstSentence('Rendering Registrar is blocked. Renderings register without.')).toBe(
      'Rendering Registrar is blocked.',
    );
    expect(firstSentence('Uses v1.2 of the SDK. Then more.')).toBe('Uses v1.2 of the SDK.');
    const long = `${'word '.repeat(30)}and then, after that, ${'more '.repeat(20)}`;
    expect(clip(long, 160).length).toBeLessThanOrEqual(161);
    expect(clip(long, 160)).not.toMatch(/\s$/);
  });
});

describe('time', () => {
  it('says times as the local clock, and stays quiet until five or until morning', () => {
    expect(shortClock(AT_224, TZ)).toBe('2:24');
    expect(clockWord(AT_224, MORNING, TZ)).toBe('2:24');
    expect(clockWord(AT_224 + 86_400_000, MORNING, TZ)).toBe('tomorrow at 2:24');
    expect(clockWord(AT_224 + 2 * 86_400_000, MORNING, TZ)).toBe('Thursday at 2:24');
    expect(untilWord(MORNING, TZ)).toBe('until five');
    expect(untilWord(EVENING, TZ)).toBe('until morning');
    expect(yoursNote([AT_224], MORNING, TZ)).toBe('One has a clock: 2:24 PM');
    expect(yoursNote([], MORNING, TZ)).toBe('No clocks');
  });
});

describe('the portfolio voice', () => {
  it('matches the board: three yours, one with a clock', () => {
    const v = portfolioVoice({
      now: MORNING,
      tz: TZ,
      projects: 4,
      running: 4,
      yours: [{ deadline: AT_224 }, { deadline: null }, { deadline: null }],
      watching: [],
    });
    expect(v).toEqual({
      text: 'Three things are yours. One needs you before 2:24. The other two can wait for a quiet half hour.',
      emphasis: 'One needs you before 2:24.',
      closing: "Everyone else is fine. I'll say nothing until five.",
    });
    voiceRules(v);
  });

  it('says nothing needs you, with no emphasis, and goes quiet until morning after five', () => {
    const v = portfolioVoice({
      now: EVENING,
      tz: TZ,
      projects: 2,
      running: 2,
      yours: [],
      watching: [],
    });
    expect(v).toEqual({
      text: 'Nothing needs you.',
      emphasis: null,
      closing: "Everyone is on pace. I'll say nothing until morning.",
    });
  });

  it('handles one card, cards without clocks, and a project worth watching', () => {
    const one = portfolioVoice({
      now: MORNING,
      tz: TZ,
      projects: 3,
      running: 3,
      yours: [{ deadline: AT_224 }],
      watching: [{ name: 'Northwind', why: 'a task is on its second retry' }],
    });
    expect(one.text).toBe('One thing is yours. It needs you before 2:24.');
    expect(one.closing).toBe(
      "Everyone else is fine but Northwind, where a task is on its second retry. I'll say nothing until five.",
    );
    voiceRules(one);
    const two = portfolioVoice({
      now: MORNING,
      tz: TZ,
      projects: 3,
      running: 3,
      yours: [{ deadline: null }, { deadline: AT_224 - 4 * 3_600_000 }],
      watching: [],
    });
    // A clock that has already run out is not a clock.
    expect(two.text).toBe(
      'Two things are yours. None has a clock; they can wait for a quiet half hour.',
    );
    expect(two.emphasis).toBe('Two things are yours.');
    voiceRules(two);
  });
});

describe('Mission Control', () => {
  it('matches the Ansell board', () => {
    const v = missionVoice({
      now: MORNING,
      tz: TZ,
      status: 'running',
      accepted: false,
      acceptedAt: null,
      phase: { name: 'Components', percent: 62 },
      yours: [{ type: 'decision', deadline: AT_224 }],
      waiter: 'Emily',
      attention: null,
      paused: false,
    });
    expect(v.text).toBe(
      'Components is at 62 percent. One decision before 2:24 is yours, and Emily is waiting on it. Everything else is on pace.',
    );
    expect(v.emphasis).toBe('One decision before 2:24 is yours,');
    expect(v.closing).toBe("Emily picks up the moment you decide. I'll say nothing until five.");
    voiceRules(v);
  });

  it('says a small percent in words, and nothing yours plainly', () => {
    const v = missionVoice({
      now: MORNING,
      tz: TZ,
      status: 'running',
      accepted: false,
      acceptedAt: null,
      phase: { name: 'Discovery', percent: 9 },
      yours: [],
      waiter: null,
      attention: 'budget',
      paused: false,
    });
    expect(v.text).toBe('Discovery is at nine percent. Spend is past 80 percent of the budget.');
    expect(v.emphasis).toBeNull();
  });

  it('says an accepted project was delivered', () => {
    const v = missionVoice({
      now: MORNING,
      tz: TZ,
      status: 'completed',
      accepted: true,
      acceptedAt: Date.parse('2026-10-16T15:00:00Z'),
      phase: null,
      yours: [],
      waiter: null,
      attention: null,
      paused: false,
    });
    expect(v.text).toBe('Accepted. Delivered on October 16.');
  });
});

describe('recommendations', () => {
  const base = {
    title: 'One campaign-slot rendering, or three?',
    context: 'The source has three slot components that differ only in layout.',
    impact: 'Emily is waiting on this to build. More words.',
    defaultOptionId: 'one',
  };

  it("follows the Lead's triage and gives its first sentence as the reason", () => {
    const r = recommendationFor({
      ...base,
      type: 'decision',
      options: [
        { id: 'one', label: 'One' },
        { id: 'three', label: 'Three renderings' },
      ],
      triage: {
        mode: 'shadow',
        optionId: 'one',
        reasoning:
          'The three layouts become a parameter, and marketers learn one component. Also cheaper.',
      },
    });
    expect(r).toEqual({
      verdict: "I'd choose one.",
      why: 'The three layouts become a parameter, and marketers learn one component.',
      pick: 'one',
    });
  });

  it('falls back to the recommended option and turns an action into a verdict', () => {
    const r = recommendationFor({
      type: 'access',
      title: 'Thumbnail upload returned 403',
      context: '',
      impact: 'Rendering Registrar is blocked on thumbnails. Renderings register without them.',
      defaultOptionId: 'A',
      triage: null,
      options: [
        { id: 'A', label: 'Re-verify the credential and retry the upload', recommended: true },
        { id: 'B', label: 'Continue without thumbnails. Retry them in phase 9' },
      ],
      names: (t) => t.replace('Rendering Registrar', 'Carlos'),
    });
    expect(r).toEqual({
      verdict: "I'd re-verify the credential and retry the upload.",
      why: 'Carlos is blocked on thumbnails.',
      pick: 'A',
    });
  });

  it('says rotate, grant, a bare verb, or the ordinal when the label is a long noun phrase', () => {
    const card = (label: string) =>
      recommendationFor({
        ...base,
        type: 'access',
        triage: null,
        options: [{ id: 'x', label, recommended: true }],
      }).verdict;
    expect(card('Rotate the Vercel token')).toBe('Rotate it.');
    expect(card('Grant workflow read on bldr-web')).toBe('Grant it when you can.');
    expect(card('Acknowledge')).toBe("I'd acknowledge it.");
    expect(
      recommendationFor({
        ...base,
        type: 'decision',
        triage: null,
        options: [
          { id: 'a', label: 'Something else entirely, for later' },
          {
            id: 'b',
            label: 'SitecoreAI Forms posting to an endpoint Ansell provides',
            recommended: true,
          },
        ],
      }),
    ).toMatchObject({ verdict: "I'd pick the second.", pick: 'b' });
  });

  it('asks for a gate to be read first, with no pick', () => {
    const r = recommendationFor({
      type: 'gate',
      title: 'Pilot slice review',
      context: '',
      impact: 'Approving confirms the pattern for the remaining 12 renderings. Sending back holds.',
      options: [{ id: 'approve', label: 'Approve' }],
      defaultOptionId: null,
      triage: null,
    });
    expect(r).toEqual({
      verdict: 'Read it first.',
      why: 'Approving confirms the pattern for the remaining twelve renderings.',
      pick: null,
    });
  });
});

describe('subjects', () => {
  it('finds a short subject in a card title', () => {
    expect(cardSubject({ type: 'decision', title: 'Where search reads its content' })).toBe(
      'search decision',
    );
    expect(cardSubject({ type: 'access', title: 'Thumbnail upload returned 403' })).toBe(
      'thumbnail upload',
    );
    expect(cardSubject({ type: 'risk', title: 'Quote calculator calls a private API' })).toBe(
      'quote calculator',
    );
    expect(
      cardSubject({ type: 'decision', title: 'Campaign slots: one rendering, or three' }),
    ).toBe('campaign slots decision');
    expect(cardSubject({ type: 'gate', title: 'Pilot slice review' })).toBe('pilot slice review');
    // A name stays capitalised when the card's own text writes it that way.
    expect(
      cardSubject({
        type: 'access',
        title: 'Vercel token expired',
        context: 'The deploy to Vercel was refused.',
      }),
    ).toBe('Vercel token');
  });
});

describe('reads', () => {
  const read = (p: Partial<ProjectReadInput>) =>
    projectRead({
      status: 'running',
      accepted: false,
      acceptedAt: null,
      tz: TZ,
      health: 'healthy',
      attention: null,
      yours: [],
      atGate: false,
      stoppedOn: null,
      working: 3,
      paused: false,
      latest: null,
      ...p,
    });

  it('reads a project tile the way the board does', () => {
    expect(read({ atGate: true, yours: [{ type: 'gate', title: 'Blueprint v1' }] })).toEqual({
      read: 'At your gate. Nothing starts until you approve.',
      tone: 'yours',
    });
    expect(read({ yours: [{ type: 'decision', title: 'Campaign slot: one or three' }] })).toEqual({
      read: "On pace. The campaign slot decision is the one thing that's yours.",
      tone: 'yours',
    });
    expect(
      read({
        yours: [
          { type: 'decision', title: 'A' },
          { type: 'risk', title: 'B' },
        ],
      }).read,
    ).toBe('On pace. Two things are yours.');
    expect(read({ health: 'blocked', stoppedOn: 'workflow scope', working: 0 })).toEqual({
      read: 'Paused for access. Nothing is burning.',
      tone: 'blocked',
    });
    expect(read({ latest: 'Leila placed 24 pages before noon' })).toEqual({
      read: 'On pace. Leila placed 24 pages before noon.',
      tone: 'normal',
    });
    expect(
      read({ status: 'completed', accepted: true, acceptedAt: Date.parse('2026-10-16T15:00:00Z') }),
    ).toEqual({ read: 'Accepted. Delivered on October 16.', tone: 'quiet' });
  });

  it("reads a Lead's team", () => {
    const base = {
      workstream: 'engineering',
      leadDone: false,
      active: 0,
      stuck: [],
      waiting: [],
      cards: [],
      nextPhase: null,
    };
    expect(
      leadRead({ ...base, active: 4, stuck: [{ first: 'Ryan', on: 'Vercel token' }] }),
    ).toEqual({ read: 'Four building; Ryan is stuck on the Vercel token.', tone: 'blocked' });
    expect(
      leadRead({ ...base, workstream: 'quality', active: 1, cards: [{ type: 'gate' }] }).read,
    ).toBe('One checking; one review is with you.');
    expect(
      leadRead({ ...base, leadDone: true, waiting: [{ first: 'Aisha', onYou: true }] }).read,
    ).toBe('Done. Aisha is on call for your decision.');
    expect(leadRead({ ...base, nextPhase: { name: 'Migration', number: 6 } })).toEqual({
      read: 'Standing by until migration, phase six.',
      tone: 'quiet',
    });
  });

  it('says who is working in words', () => {
    expect(workingWord(9, 1)).toBe('nine working');
    expect(workingWord(0, 1)).toBe('waiting on you');
    expect(workingWord(0, 0)).toBe('resting');
  });
});

describe('handled', () => {
  it('says what was settled without the Director, in the first person when it was Cypher', () => {
    expect(
      handledLine({ by: 'lead', who: 'Kevin', subject: 'alt-text decision', choice: null }),
    ).toBe('Kevin settled the alt-text decision.');
    expect(
      handledLine({
        by: 'default',
        who: null,
        subject: 'search decision',
        choice: choiceWords('Build the index at build time'),
        project: 'Ansell',
      }),
    ).toBe('The search decision on Ansell took its default: build the index at build time.');
    expect(
      handledLine({ by: 'chief_of_staff', who: null, subject: 'naming decision', choice: null }),
    ).toBe('I settled the naming decision.');
    expect(
      choiceWords('Keep the hand-off to the ansell.com contact page, as the concept does today'),
    ).toBeNull();
  });

  it("sums up the Leads' morning", () => {
    expect(handledSummary(11, Date.parse('2026-11-03T13:05:00Z'), MORNING, TZ)).toEqual({
      text: 'The leads settled eleven cards on their own this morning.',
      at: null,
      when: 'since 8',
    });
  });
});

describe('cardGist', () => {
  it('says what keeps failing, not the list, for a Lead’s repeated rejection', async () => {
    const { cardGist } = await import('../src/voice');
    const context =
      'The Lead rejected this output and retries did not fix it. Rejected 3 times: seo.titles: /about has the title "About Us"; the source page\'s is "About Us - Ervin Cable - Broadband & Telecom Construction Services"; /construction-services has the title "Construction Services"; the source page\'s is "Broadband & Telecom Construction Services - Ervin Cable Construction"; /safety has the title "Safety"; the source page\'s is "Safety Training & Protocols - Ervin Cable Construction"; and 7 more.';
    const gist = cardGist({
      type: 'decision',
      title: 'Redirects, SEO, sitemap, robots, error pages and dictionary: needs a decision',
      context,
    });
    expect(gist).toBe(
      "The Lead sent this back three times, and retrying hasn't fixed it. Ten pages fail the SEO titles check: they don't match the live site.",
    );
    expect(gist.length).toBeLessThan(160);
  });

  it('keeps the first sentence, and stops before a long list', async () => {
    const { cardGist } = await import('../src/voice');
    expect(
      cardGist({
        type: 'access',
        title: 'Thumbnail upload returned 403',
        context:
          'The Authoring API refused the HazardRoute rendering thumbnail with 403. The Automation credential verified at 8:02 AM.',
      }),
    ).toBe(
      'The Authoring API refused the HazardRoute rendering thumbnail with 403. The Automation credential verified at 8:02 AM.',
    );
    const long = cardGist({
      type: 'decision',
      title: 'Which pages move',
      context:
        'These pages have no owner in the brief: /about, /careers, /safety, /quality, /subcontractors, /engineering-services, /acctraining and more. Pick who decides.',
    });
    expect(long).toBe('These pages have no owner in the brief. Pick who decides.');
  });
});
