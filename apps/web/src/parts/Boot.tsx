import { useEffect, useRef, useState } from 'react';
import { live } from '../lib/live';
import { useApp, useMission, useNow } from '../state';
import { Button } from '../ui/cypher/parts';
import { Eye } from '../ui/Eye';
import b from './boot.module.css';

/**
 * The first load. The Control API runs on paused, short-lived instances, so the first answer can
 * take seconds: instead of an empty shell with "Loading…" lines, the shell renders blurred under
 * a full-screen overlay with the mark, what is being waited for, and a plain error with a retry
 * when the API doesn't answer. It shows once per page load; switching projects later uses the
 * surfaces' own loading lines.
 */

type Phase = 'api' | 'project' | 'error' | 'done';
type Step = { label: string; state: 'done' | 'active' | 'todo' };

export interface BootState {
  visible: boolean;
  leaving: boolean;
  phase: Phase;
  message: string;
  detail: string | null;
  steps: Step[];
  retry: () => void;
  home: () => void;
}

const MIN_SHOWN_MS = 500;
const LEAVE_MS = 380;

export function useBootState(): BootState {
  const { boot, projectId, projects, home } = useApp();
  const mission = useMission();
  // The project in the address when the page opened: its first snapshot is part of the boot.
  const initial = useRef(projectId);
  const needProject = initial.current !== null && projectId === initial.current;
  const projectReady = !needProject || mission.data !== undefined;
  const projectError = needProject && mission.data === undefined ? mission.error : null;

  const phase: Phase = !boot.projectsLoaded
    ? boot.error
      ? 'error'
      : 'api'
    : projectError
      ? 'error'
      : !projectReady
        ? 'project'
        : 'done';

  // Stay at least a moment (no flash), fade out, then leave for good.
  const [stage, setStage] = useState<'showing' | 'leaving' | 'gone'>('showing');
  const shownAt = useRef(Date.now());
  // Once the overlay has gone, nothing here needs the time: stop re-rendering every second.
  const now = useNow(stage === 'gone' ? null : 1000);
  const waited = (now - shownAt.current) / 1000;
  useEffect(() => {
    if (stage !== 'showing' || phase !== 'done') return;
    const t = window.setTimeout(
      () => setStage('leaving'),
      Math.max(0, MIN_SHOWN_MS - (Date.now() - shownAt.current)),
    );
    return () => window.clearTimeout(t);
  }, [phase, stage]);
  useEffect(() => {
    if (stage !== 'leaving') return;
    const t = window.setTimeout(() => setStage('gone'), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [stage]);

  const name = projects.find((p) => p.id === projectId)?.name ?? null;
  let message: string;
  let detail: string | null = null;
  if (phase === 'error') {
    message = boot.error ?? projectError?.message ?? 'The Control API could not be reached.';
    detail = boot.error ? 'Retrying every few seconds.' : null;
  } else if (phase === 'api') {
    message =
      waited < 4
        ? 'Waking the Control API…'
        : waited < 12
          ? 'Still waking the Control API. A cold start can take a few seconds.'
          : 'This is taking longer than usual. Retrying every few seconds…';
  } else if (phase === 'project') {
    message = `Opening ${name ?? 'your project'}…`;
  } else {
    message = 'Ready';
  }

  const steps: Step[] = [
    { label: 'Control API', state: boot.projectsLoaded ? 'done' : 'active' },
    ...(needProject
      ? [
          {
            label: 'Project',
            state: (!boot.projectsLoaded
              ? 'todo'
              : projectReady
                ? 'done'
                : 'active') as Step['state'],
          },
        ]
      : []),
  ];

  return {
    visible: stage !== 'gone',
    leaving: stage === 'leaving',
    phase,
    message,
    detail,
    steps,
    retry: () => {
      if (!boot.projectsLoaded) boot.retry();
      else if (projectId) live.refresh(projectId);
    },
    home,
  };
}

export function Boot({ state }: { state: BootState }) {
  const { leaving, phase, message, detail, steps, retry, home } = state;
  return (
    <div
      className={b.boot}
      role="status"
      aria-live="polite"
      data-phase={phase}
      data-leaving={leaving || undefined}
    >
      <div className={b.card}>
        <div className={b.mark} aria-hidden="true">
          <svg className={b.ring} viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="56" />
          </svg>
          <Eye
            state={phase === 'error' ? 'needs-a-word' : 'watching'}
            size={56}
            decorative
            blink={phase !== 'error'}
          />
        </div>
        <p className={`${b.title} type-heading`}>Cypher</p>
        <p className={`${b.line} type-body`}>{message}</p>
        {detail && <p className={`${b.detail} type-meta`}>{detail}</p>}
        <div className={b.steps} aria-hidden="true">
          {steps.map((s) => (
            <span key={s.label} className={b.step} data-state={s.state} title={s.label} />
          ))}
        </div>
        {phase === 'error' && (
          <div className={b.actions}>
            <Button kind="primary" onClick={retry}>
              Try again
            </Button>
            {steps.length > 1 && (
              <Button kind="secondary" onClick={home}>
                Dashboard
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
