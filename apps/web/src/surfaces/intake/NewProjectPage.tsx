/*
 * New project (Everything only). The Director first picks the entity (the platform the site is
 * built on), then one of its playbooks: what the team will deliver. The playbook then decides the
 * rest: whether there is a source repository and live site, which target values and which
 * credentials, in which steps. Each credential is tested against the live service here; the API
 * tests them again, seals them in the vault and records the project ready to start.
 *
 * The steps are one list of objects ({key, title, valid, render}), so a step's title, its check
 * and its page can never drift apart. The logic lives in ./model; this file only lays it out.
 */
import type {
  IntakeCredentialSpec,
  VerifyIntakeCredential,
  VerifyIntakeResult,
} from '@lw/contracts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { messageOf, postFor } from '../../lib/api';
import { catalogGroups } from '../../lib/showcase';
import { useApp } from '../../state';
import { Icon } from '../../theme/icons';
import {
  briefValid,
  credentialCheck,
  credentialsOf,
  failedCheck,
  GITHUB_CHECK,
  hasSource,
  initialAnswers,
  intakeBody,
  intakeStepValid,
  projectValid,
  providedBy,
  questionsFor,
  repoCheck,
  sourceValid,
  staleChecks,
  wizardTitle,
  type Answers,
  type BaseFields,
  type Checks,
} from './model';
import { Action, Notice, usePlaybooks } from './shared';
import {
  BriefStep,
  EntityStep,
  IntakeStepBody,
  PlaybookStep,
  ProjectStep,
  ReviewStep,
  SourceStep,
} from './steps';
import { Summary } from './Summary';
import s from './intake.module.css';

/** One step of the wizard: its title in the rail, whether it is complete, and its page. */
interface Step {
  key: string;
  title: string;
  valid: boolean;
  render: () => ReactNode;
}

export function NewProjectPage() {
  const { home, switchProject, toast, newProjectIntent } = useApp();
  const { remix, preset, origin } = newProjectIntent;
  const draft = remix?.draft;
  const chosen = draft?.playbookId ?? preset?.playbookId ?? null;
  const { playbooks, error: loadError } = usePlaybooks();

  const [entityId, setEntityId] = useState<string | null>(null);
  const [playbookId, setPlaybookId] = useState<string | null>(chosen);
  // A draft or a chosen playbook skips the two catalog steps; Back still reaches them.
  const [at, setAt] = useState(chosen ? { key: 'project', i: 2 } : { key: 'entity', i: 0 });
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(draft));
  const [checks, setChecks] = useState<Checks>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Credentials the connection provides; one the Director types in overrides it. */
  const provided = useMemo(() => providedBy(draft), [draft]);
  const heading = useRef<HTMLHeadingElement>(null);
  const rail = useRef<HTMLOListElement>(null);

  // The catalog arrives: open on the chosen playbook's entity, or on the only playbook there is.
  useEffect(() => {
    if (!playbooks) return;
    const picked = playbooks.find((p) => p.id === chosen);
    if (picked) setEntityId(picked.platform.id);
    else if (playbooks.length === 1) {
      setEntityId(playbooks[0]!.platform.id);
      setPlaybookId(playbooks[0]!.id);
    }
  }, [playbooks, chosen]);

  const groups = useMemo(() => catalogGroups(playbooks ?? []), [playbooks]);
  const entity = groups.find((g) => g.entity.id === entityId) ?? null;
  const pb = playbooks?.find((p) => p.id === playbookId) ?? null;
  const credentials = credentialsOf(pb);
  const questions = questionsFor(pb, answers.f.repo);
  const withSource = hasSource(pb);

  /* ---------- changes, and the checks they make stale ---------- */

  const clear = (keys: string[]) => {
    if (keys.length)
      setChecks((c) => ({ ...c, ...Object.fromEntries(keys.map((k) => [k, { state: 'idle' }])) }));
  };
  const setBase = (k: keyof BaseFields, v: string) => {
    setAnswers((a) => ({ ...a, f: { ...a.f, [k]: v } }));
    clear(staleChecks({ base: k }, credentials));
  };
  const setField = (key: string, v: string) => {
    setAnswers((a) => ({ ...a, target: { ...a.target, [key]: v } }));
    clear(staleChecks({ field: key }, credentials));
  };
  const setSecret = (credentialId: string, key: string, v: string) => {
    setAnswers((a) => ({
      ...a,
      secrets: { ...a.secrets, [credentialId]: { ...a.secrets[credentialId], [key]: v } },
    }));
    clear(staleChecks({ credential: credentialId }, credentials));
  };
  const setBrief = (key: string, v: string) =>
    setAnswers((a) => ({ ...a, brief: { ...a.brief, [key]: v } }));

  /** POST /intake/verify: one credential, or GitHub access, against the live service. */
  const test = async (key: string, input: VerifyIntakeCredential) => {
    setChecks((c) => ({ ...c, [key]: { state: 'busy' } }));
    try {
      const r = await postFor<VerifyIntakeResult>('/intake/verify', input);
      setChecks((c) => ({ ...c, [key]: { state: 'done', ...r } }));
    } catch (err) {
      setChecks((c) => ({ ...c, [key]: failedCheck(messageOf(err, 'The check could not run.')) }));
    }
  };
  const testCredential = (c: IntakeCredentialSpec) =>
    pb && void test(c.credentialId, credentialCheck(pb, c, answers));

  const pickEntity = (id: string) => {
    const g = groups.find((x) => x.entity.id === id);
    if (!g || g.entity.status !== 'ready') return;
    setEntityId(id);
    const ready = g.playbooks.filter((p) => p.status === 'ready');
    // One runnable playbook on the entity: it is the choice; otherwise a playbook from elsewhere is dropped.
    setPlaybookId(
      ready.length === 1
        ? ready[0]!.id
        : ready.some((p) => p.id === playbookId)
          ? playbookId
          : null,
    );
    setChecks({});
  };
  const pickPlaybook = (id: string) => {
    setPlaybookId(id);
    setChecks({});
  };

  /* ---------- the steps ---------- */

  const steps: Step[] = [
    {
      key: 'entity',
      title: 'Entity',
      valid: Boolean(entity && entity.entity.status === 'ready'),
      render: () => (
        <EntityStep
          groups={groups}
          value={entityId}
          loading={!playbooks && !loadError}
          error={loadError}
          onPick={pickEntity}
        />
      ),
    },
    {
      key: 'playbook',
      title: 'Playbook',
      valid: Boolean(pb && pb.platform.id === entityId),
      render: () => <PlaybookStep entity={entity} value={playbookId} onPick={pickPlaybook} />,
    },
    {
      key: 'project',
      title: 'Project',
      valid: projectValid(answers.f),
      render: () => <ProjectStep f={answers.f} set={setBase} />,
    },
  ];
  if (pb && withSource) {
    const source = pb.intake.source;
    steps.push({
      key: 'source',
      title: 'Source',
      valid: sourceValid(source, answers.f),
      render: () => (
        <SourceStep
          source={source}
          f={answers.f}
          set={setBase}
          checks={checks}
          onTestRepo={() => void test(GITHUB_CHECK, repoCheck(answers.f))}
        />
      ),
    });
  }
  (pb?.intake.steps ?? []).forEach((st, i) =>
    steps.push({
      key: `intake-${i}-${st.title}`,
      title: st.title,
      valid: intakeStepValid(st, answers, checks, provided),
      render: () => (
        <IntakeStepBody
          step={st}
          answers={answers}
          checks={checks}
          provided={provided}
          connectionName={remix?.connectionName ?? null}
          onField={setField}
          onSecret={setSecret}
          onTest={testCredential}
        />
      ),
    }),
  );
  if (questions.length)
    steps.push({
      key: 'brief',
      title: 'Brief',
      valid: briefValid(questions, answers.brief),
      render: () => <BriefStep questions={questions} brief={answers.brief} onChange={setBrief} />,
    });
  steps.push({
    key: 'review',
    title: 'Review',
    valid: true,
    render: () =>
      pb && (
        <ReviewStep
          pb={pb}
          answers={answers}
          checks={checks}
          provided={provided}
          showSource={withSource}
          questions={questions}
        />
      ),
  });

  // The open step, by key; if it disappears (another playbook), the step now in its place.
  const found = steps.findIndex((x) => x.key === at.key);
  const index = found >= 0 ? found : Math.min(at.i, steps.length - 1);
  const step = steps[index]!;
  const last = index === steps.length - 1;
  /** Steps the rail may jump to: every step before it is complete. */
  const canJump = (i: number) => i <= index || steps.slice(0, i).every((x) => x.valid);
  const goTo = (i: number) => {
    setAt({ key: steps[i]!.key, i });
    // The new step's title takes focus, so a screen reader hears where it is; on a phone, where
    // the rail scrolls sideways, the current step comes into view.
    requestAnimationFrame(() => {
      rail.current
        ?.querySelector('[aria-current="step"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      heading.current?.focus();
    });
  };

  const create = async () => {
    if (!pb) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postFor<{ projectId: string }>(
        '/projects',
        intakeBody(pb, answers, { draft, origin }),
      );
      toast({
        title: `${answers.f.name.trim()} is set up`,
        detail: 'Its credentials are verified and sealed.',
        tone: 'done',
      });
      switchProject(r.projectId);
    } catch (err) {
      setError(messageOf(err, 'The project could not be created.'));
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <nav className={s.rail} aria-label="Steps">
        <button type="button" className={`${s.back} type-meta`} onClick={home}>
          <Icon name="chevron" size={18} className={s.backIcon} />
          Dashboard
        </button>
        <h1 className={`${s.title} type-card-title`}>{wizardTitle(draft)}</h1>
        <ol className={s.steps} ref={rail}>
          {steps.map((x, i) => (
            <li
              key={x.key}
              aria-current={i === index ? 'step' : undefined}
              data-done={i < index || undefined}
            >
              <button
                type="button"
                className={s.stepButton}
                disabled={!canJump(i)}
                onClick={() => goTo(i)}
              >
                <span className={s.num} aria-hidden="true">
                  {i < index ? <Icon name="check" size={16} /> : i + 1}
                </span>
                <span className={s.stepLabel}>{x.title}</span>
                {i < index && <span className="sr-only">, done</span>}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className={s.main} aria-labelledby="np-step-title">
        <header className={s.head}>
          <span className={`${s.count} type-label`}>
            Step {index + 1} of {steps.length}
          </span>
          <h2 id="np-step-title" ref={heading} tabIndex={-1} className="type-title">
            {step.title}
          </h2>
        </header>
        <div className={s.body}>{step.render()}</div>
        {error && (
          <div className={s.error} role="alert">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        <footer className={s.foot}>
          <Action onClick={index ? () => goTo(index - 1) : home}>
            {index ? 'Back' : 'Cancel'}
          </Action>
          {!last ? (
            <Action kind="primary" disabled={!step.valid} onClick={() => goTo(index + 1)}>
              Next
            </Action>
          ) : (
            <Action
              kind="primary"
              disabled={busy || !steps.every((x) => x.valid)}
              onClick={() => void create()}
            >
              {busy ? 'Checking and creating…' : 'Create project'}
            </Action>
          )}
        </footer>
      </section>

      <Summary
        entity={entity}
        pb={pb}
        answers={answers}
        checks={checks}
        provided={provided}
        showSource={withSource}
      />
    </div>
  );
}
