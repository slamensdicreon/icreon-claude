import type { DecisionView, TaskView } from '@lw/contracts';
import { expect, it } from 'vitest';
import { relevantDecisions } from '../src/triage-context';

const task = (taskId: string, title: string, itemKeys: string[]) =>
  ({ taskId, title, itemKeys }) as TaskView;
const decision = (
  ref: string,
  question: string,
  answer: string,
  rationale = '',
  decidedBy: DecisionView['decidedBy'] = 'director',
): DecisionView => ({
  decisionId: ref,
  ts: '2026-11-04T00:00:00.000Z',
  question,
  answer,
  rationale,
  decidedBy,
  scopeKey: `decision:${ref}`,
  escalationId: null,
  ref,
});

it('gives a card the decisions about its task and the tasks it names, newest first, without defaults', () => {
  const state = {
    tasks: {
      'migrate-pages-contact': task('migrate-pages-contact', 'Migrate Contact', ['contact']),
      'port-form': task('port-form', 'Port Form to Content SDK', ['form']),
      'port-hero': task('port-hero', 'Port Hero to Content SDK', ['hero']),
    },
    decisions: [
      decision(
        'D-24',
        'How to resolve the Form name clash with the SDK built-in?',
        'Use the built-in',
        'Form is the SDK built-in; its form is built in SitecoreAI Forms by the Director (OD-2).',
      ),
      decision('D-30', 'Port Hero to Content SDK: what it needs is missing', 'Retry'),
      decision(
        'D-31',
        'Record 1 task as done',
        'Done outside the agents',
        'The contact form is a Director item (migrate-pages-contact).',
      ),
      decision(
        'D-32',
        'Port Form to Content SDK: needs a decision',
        'Retry',
        'Deadline passed.',
        'default',
      ),
      decision('D-33', 'Informational performance review', 'Noted'),
    ],
  };
  const got = relevantDecisions(state, 'migrate-pages-contact', {
    title: 'Migrate Contact: what it needs is missing',
    context:
      'It waits on fixes to Form, but Port Form to Content SDK was already sent back 2 times.',
  });
  expect(got.map((d) => d.split(' ')[0])).toEqual(['D-31', 'D-24']);
  expect(got[1]).toContain('built in SitecoreAI Forms by the Director');
});
