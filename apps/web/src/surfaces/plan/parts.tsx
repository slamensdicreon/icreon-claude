/*
 * Plan's small pieces: the glyph and word every task state carries (so a state reads without
 * color), the owner cell, the Director's gate mark and the legend.
 */
import type { AgentView, TaskState } from '@lw/contracts';
import type { ReactNode } from 'react';
import { useApp } from '../../state';
import { Avatar } from '../../ui/cypher/parts';
import { Eye } from '../../ui/Eye';
import { useEyeState } from '../../voice/eye';
import { at, faceOf, LOOKS, roleOf, stateOf, type Look } from './model';
import s from './plan.module.css';

const GLYPH: Record<Look, ReactNode> = {
  done: <path d="m5 12 5 5L20 7" />,
  running: <circle cx="12" cy="12" r="5" fill="currentColor" />,
  ready: <path d="M9 6.5v11l8.5-5.5z" />,
  planned: <circle cx="12" cy="12" r="6.5" />,
  waiting: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v5M12 16v.5" />
    </>
  ),
};

/** The state's shape, drawn in the current text color; decoration beside a word or a name. */
export function Glyph({ look }: { look: Look }) {
  return (
    <svg
      className={s.glyph}
      data-look={look}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPH[look]}
    </svg>
  );
}

/** The state as a word with its glyph: "Waiting", or "Done with gaps" for a task finished with them. */
export function StateWord({ state, gaps }: { state: TaskState; gaps?: string | null }) {
  const withGaps = state === 'done' && !!gaps;
  const { word, look } = withGaps
    ? { word: 'Done with gaps', look: 'waiting' as const }
    : stateOf(state);
  return (
    <span
      className={s.stateWord}
      data-look={look}
      title={withGaps ? (gaps ?? undefined) : undefined}
    >
      <Glyph look={look} />
      {word}
    </span>
  );
}

/** A person's face in their team's hue; the Chief of Staff is Cypher, so the eye (§3). */
export function Who({
  agent,
  id,
  size = 'sm',
}: {
  agent: AgentView | undefined;
  id: string;
  size?: 'xs' | 'sm';
}) {
  const eye = useEyeState();
  if (agent?.tier === 'chief_of_staff')
    return (
      <span className={s.eyeFace} data-size={size}>
        <Eye state={eye.state} size={EYE_PX[size]} decorative />
      </span>
    );
  return <Avatar face={faceOf(agent, id, true)} size={size} />;
}
/** The eye's drawing size, matching the avatar sizes in ui/cypher/parts.module.css. */
const EYE_PX = { xs: 28, sm: 28 } as const;

/** Who owns the work: the face in their team's hue, the name, the role; opens the agent. */
export function Owner({
  agent,
  id,
  compact,
}: {
  agent: AgentView | undefined;
  id: string;
  compact?: boolean;
}) {
  const { inspect } = useApp();
  return (
    <button type="button" className={s.owner} onClick={() => inspect('agent', id)}>
      <Who agent={agent} id={id} size={compact ? 'xs' : 'sm'} />
      <span className={s.ownerText}>
        <span>{agent?.persona ?? agent?.name ?? id}</span>
        {!compact && <span className="type-meta">{roleOf(agent)}</span>}
      </span>
    </button>
  );
}

/** The Director's gate: a coral diamond, because the gate is the Director's. */
export function GateMark({ label, x }: { label: string; x?: number }) {
  return (
    <span
      className={s.gate}
      role="img"
      aria-label={label}
      title={label}
      style={x === undefined ? undefined : at(x)}
    />
  );
}

export function Legend({ gate = true, now = true }: { gate?: boolean; now?: boolean }) {
  return (
    <ul className={`${s.legend} type-meta`} aria-label="Legend">
      {LOOKS.map(({ look, word }) => (
        <li key={look}>
          <span className={s.swatch} data-look={look} aria-hidden="true">
            <Glyph look={look} />
          </span>
          {word}
        </li>
      ))}
      {gate && (
        <li>
          <span className={s.gateKey} aria-hidden="true" />
          Director gate
        </li>
      )}
      {now && (
        <li>
          <span className={s.nowKey} aria-hidden="true" />
          Now
        </li>
      )}
    </ul>
  );
}
