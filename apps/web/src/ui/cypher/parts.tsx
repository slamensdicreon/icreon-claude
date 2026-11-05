/*
 * Cypher's own components (design system §10): the pieces the Dashboard and Mission Control are
 * built from in both modes. They render what the consumer gives them; Cypher's words arrive as
 * strings from the API and are never composed here. Every color, size and radius is a token.
 */
import type { Face, HandledItem, ReadTone, Recommendation, Voice, Workstream } from '@lw/contracts';
import type { ReactNode } from 'react';
import { Icon } from '../../theme/icons';
import { Eye } from '../Eye';
import type { EyeState } from '../../voice/eye';
import s from './parts.module.css';

/* ---------- color by meaning ---------- */

/** The team hue (§5): iris Discovery, blue Engineering, teal Content, gold Quality. */
export const HUE: Record<Workstream, string> = {
  discovery: 'var(--iris)',
  engineering: 'var(--blue)',
  content: 'var(--teal)',
  quality: 'var(--gold)',
};
export const hueOf = (w: Workstream | 'blocked' | 'done' | null | undefined) =>
  w === 'blocked' ? 'var(--coral)' : w === 'done' ? 'var(--text-3)' : w ? HUE[w] : 'var(--text-3)';

export const TONE: Record<ReadTone, string> = {
  yours: 'var(--coral-text)',
  blocked: 'var(--coral-text)',
  normal: 'var(--text-2)',
  quiet: 'var(--text-3)',
};

/* ---------- people ---------- */

export function Avatar({
  face,
  size = 'md',
  ring,
}: {
  face: Face;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  ring?: boolean;
}) {
  return (
    <span
      className={`${s.avatar} ${s[`av-${size}`]} ${ring ? s.avRing : ''}`}
      style={{ background: hueOf(face.workstream) }}
      data-quiet={!face.working || undefined}
      title={face.name}
      aria-hidden="true"
    >
      {face.initials}
    </span>
  );
}

/** Overlapping faces, then a word ("nine working"). */
export function Faces({
  faces,
  word,
  size = 'sm',
}: {
  faces: Face[];
  word?: string;
  size?: 'xs' | 'sm';
}) {
  return (
    <span className={s.faces}>
      <span className={s.faceStack}>
        {faces.map((f) => (
          <Avatar key={f.agentId} face={f} size={size} ring />
        ))}
      </span>
      {word && <span className="type-meta">{word}</span>}
      <span className="sr-only">{faces.map((f) => f.name).join(', ')}</span>
    </span>
  );
}

/* ---------- Cypher's words ---------- */

/** Cypher's sentence, with the clause that is the Director's set in voice-emphasis. */
export function VoiceLine({ voice, small }: { voice: Voice; small?: boolean }) {
  const { text, emphasis } = voice;
  const i = emphasis ? text.indexOf(emphasis) : -1;
  return (
    <p className={`${s.voice} ${small ? 'type-voice-small' : 'type-voice'}`}>
      {i < 0 ? (
        text
      ) : (
        <>
          {text.slice(0, i)}
          <em>{emphasis}</em>
          {text.slice(i + emphasis!.length)}
        </>
      )}
    </p>
  );
}

/** The hero of a Bliss page: the eye in its halo, the sentence, the closing line. */
export function Hero({
  eye,
  blink,
  voice,
  small,
  showClosing = true,
}: {
  eye: EyeState;
  blink?: boolean;
  voice: Voice;
  small?: boolean;
  showClosing?: boolean;
}) {
  return (
    <section className={s.hero} aria-label="Today">
      <Eye state={eye} blink={blink} size={small ? 110 : 130} halo />
      <span className={s.heroText}>
        <VoiceLine voice={voice} small={small} />
        {showClosing && voice.closing && <Closing text={voice.closing} />}
      </span>
    </section>
  );
}

export function Closing({ text }: { text: string }) {
  return (
    <span className={`${s.closing} type-body`}>
      <Eye state="resting" size={20} decorative />
      {text}
    </span>
  );
}

/** Cypher's verdict inside a card: the eye, the verdict in bold, the reason after it. */
export function Verdict({ rec, plain }: { rec: Recommendation; plain?: boolean }) {
  return (
    <span className={plain ? s.verdictPlain : s.verdict}>
      <Eye state="watching" size={22} decorative />
      <span className="type-body-small">
        <b>{rec.verdict}</b> {rec.why}
      </span>
    </span>
  );
}

/* ---------- buttons ---------- */

export function Button({
  children,
  onClick,
  kind = 'primary',
  large,
  trailing,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'quiet';
  large?: boolean;
  trailing?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${s.button} ${s[kind]} ${large ? `${s.large} type-button-large` : 'type-button'}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span>{children}</span>
      {trailing && <span className={s.trailing}>{trailing}</span>}
    </button>
  );
}

/* ---------- the Yours card, three ways ---------- */

export interface CardAction {
  label: string;
  run: () => void;
}

/** A thing that is the Director's (Yours card guideline): label, question, context, verdict, two buttons, who. */
export function YoursCard({
  kind,
  project,
  clock,
  clockYours,
  title,
  body,
  rec,
  primary,
  secondary,
  raiser,
  meta,
}: {
  kind: string;
  project?: string;
  clock: string;
  clockYours: boolean;
  title: string;
  body: string;
  rec: Recommendation | null;
  primary: CardAction;
  secondary: CardAction | null;
  raiser: Face | null;
  meta: string;
}) {
  return (
    <article className={s.yours}>
      <span className={`${s.cardLabel} type-label`}>
        <Eye state="needs-a-word" size={20} decorative />
        <span className={s.labelText}>
          {kind}
          {project && <> · {project}</>}
        </span>
        <span className={s.clock} data-yours={clockYours || undefined}>
          {clock}
        </span>
      </span>
      <h3 className={`${s.yoursTitle} type-card-title-large`}>{title}</h3>
      <p className={`${s.body} type-body-small`}>{body}</p>
      {rec && <Verdict rec={rec} />}
      <span className={s.actions}>
        <Button onClick={primary.run}>{primary.label}</Button>
        {secondary && (
          <Button kind="secondary" onClick={secondary.run}>
            {secondary.label}
          </Button>
        )}
      </span>
      <span className={`${s.who} type-meta`}>
        {raiser && <Avatar face={{ ...raiser, working: true }} size="xs" />}
        {meta}
      </span>
    </article>
  );
}

/** The one decision on Mission Control, in its large form. */
export function DecisionCard({
  label,
  title,
  context,
  raiser,
  meta,
  rec,
  pick,
  other,
  quiet,
  fallback,
}: {
  label: string;
  title: string;
  context: string;
  raiser: Face | null;
  meta: ReactNode;
  rec: Recommendation | null;
  pick: CardAction;
  other: CardAction | null;
  quiet: CardAction[];
  fallback: string | null;
}) {
  return (
    <section className={s.decision} aria-label="Yours now">
      <div className={s.decisionLeft}>
        <span className={`${s.cardLabel} type-label`}>
          <Eye state="needs-a-word" size={20} decorative />
          {label}
        </span>
        <h2 className={`${s.decisionTitle} type-decision-title`}>{title}</h2>
        <p className={`${s.body} type-body`}>{context}</p>
        <span className={`${s.who} type-meta`}>
          {raiser && <Avatar face={{ ...raiser, working: true }} size="xs" />}
          {meta}
        </span>
      </div>
      <div className={s.decisionRight}>
        {rec && <Verdict rec={rec} />}
        <Button large onClick={pick.run} trailing={rec ? "Cypher's pick" : undefined}>
          {pick.label}
        </Button>
        {other && (
          <Button large kind="secondary" onClick={other.run}>
            {other.label}
          </Button>
        )}
        <span className={`${s.decisionFoot} type-meta`}>
          {quiet.map((q) => (
            <button key={q.label} type="button" className={s.link} onClick={q.run}>
              {q.label}
            </button>
          ))}
          {fallback && <span className={s.fallback}>{fallback}</span>}
        </span>
      </div>
    </section>
  );
}

/** A quieter card that is also yours (Mission Control, under the decision). */
export function QuietCard({
  label,
  title,
  rec,
  primary,
  secondary,
}: {
  label: string;
  title: string;
  rec: Recommendation | null;
  primary: CardAction;
  secondary: CardAction | null;
}) {
  return (
    <article className={s.quietCard}>
      <span className={`${s.quietLabel} type-label`}>{label}</span>
      <span className="type-card-title">{title}</span>
      {rec && <Verdict rec={rec} plain />}
      <span className={s.actions}>
        <Button onClick={primary.run}>{primary.label}</Button>
        {secondary && (
          <Button kind="secondary" onClick={secondary.run}>
            {secondary.label}
          </Button>
        )}
      </span>
    </article>
  );
}

/* ---------- projects and people in one line ---------- */

/** The progress ring with the eye inside. */
export function Ring({
  percent,
  hue,
  eye,
  track,
}: {
  percent: number;
  hue: string;
  eye: EyeState;
  track?: string;
}) {
  const r = 37;
  const c = 2 * Math.PI * r;
  return (
    <span className={s.ring}>
      <svg viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
        <circle
          cx="42"
          cy="42"
          r={r}
          fill="none"
          strokeWidth="6"
          style={{ stroke: track ?? 'var(--mist-2)' }}
        />
        <circle
          cx="42"
          cy="42"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(c * percent) / 100} ${c}`}
          transform="rotate(-90 42 42)"
          style={{ stroke: hue }}
        />
      </svg>
      <span className={s.ringEye}>
        <Eye state={eye} size={44} decorative />
      </span>
    </span>
  );
}

export function ProjectTile({
  name,
  phase,
  percent,
  hue,
  eye,
  read,
  tone,
  faces,
  word,
  yours,
  onOpen,
}: {
  name: string;
  phase: string;
  percent: number;
  hue: string;
  eye: EyeState;
  read: string;
  tone: ReadTone;
  faces: Face[];
  word: string;
  yours: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={s.tile} data-yours={yours || undefined} onClick={onOpen}>
      <Ring percent={percent} hue={hue} eye={eye} track={yours ? 'var(--surface)' : undefined} />
      <span className={s.tileName}>
        <span className="type-card-title">{name}</span>
        <span className="type-meta">
          {phase} · {percent}%
        </span>
      </span>
      <span className={`${s.tileRead} type-read`} style={{ color: TONE[tone] }}>
        {read}
      </span>
      <span className={s.tileFoot}>
        <Faces faces={faces} word={word} />
      </span>
    </button>
  );
}

export function TeamLine({
  face,
  team,
  read,
  tone,
  reports,
  onOpen,
}: {
  face: Face;
  team: string;
  read: string;
  tone: ReadTone;
  reports: Face[];
  onOpen: () => void;
}) {
  return (
    <button type="button" className={s.teamLine} onClick={onOpen}>
      <Avatar face={{ ...face, working: true }} size="lg" />
      <span className={s.teamText}>
        <span className={s.teamName}>
          <b>{face.name}</b> <span>{team}</span>
        </span>
        <span className={`${s.teamRead} type-read`} style={{ color: TONE[tone] }}>
          {read}
        </span>
      </span>
      <span className={s.faceStack}>
        {reports.slice(0, 5).map((f) => (
          <Avatar key={f.agentId} face={f} size="xs" ring />
        ))}
      </span>
    </button>
  );
}

/** Handled without you: a green check, one sentence, a time. */
export function Handled({
  items,
  timeOf,
  columns = 2,
}: {
  items: HandledItem[];
  timeOf: (at: string) => string;
  columns?: 1 | 2;
}) {
  return (
    <ul className={s.handled} data-columns={columns}>
      {items.map((h, i) => (
        <li key={`${h.text}-${i}`} className={s.handledRow}>
          <span className={s.check}>
            <Icon name="check" size={18} />
          </span>
          <span className={`${s.handledText} type-read`}>{h.text}</span>
          <span className="type-meta">{h.at ? timeOf(h.at) : (h.when ?? '')}</span>
        </li>
      ))}
    </ul>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className={`${s.sectionHeading} type-heading`}>{children}</h2>;
}

/* ---------- Everything: panels, numbers, lists ---------- */

export function Panel({
  title,
  count,
  chips,
  meta,
  children,
  padded,
  label,
}: {
  title: string;
  count?: number;
  chips?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  label?: string;
}) {
  return (
    <section className={s.panel} aria-label={label ?? title}>
      <div className={s.panelHead}>
        <h2 className="type-section">{title}</h2>
        {count !== undefined && count > 0 && (
          <span className={`${s.countBadge} type-label`}>{count}</span>
        )}
        {chips}
        {meta && <span className={`${s.panelMeta} type-meta`}>{meta}</span>}
      </div>
      <div className={padded ? s.panelBody : undefined}>{children}</div>
    </section>
  );
}

export function Chips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className={s.chips} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={s.chip}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span> {o.count}</span>}
        </button>
      ))}
    </span>
  );
}

export function Kpi({
  label,
  value,
  note,
  yours,
}: {
  label: string;
  value: string;
  note: string;
  yours?: boolean;
}) {
  return (
    <div className={s.kpi} data-yours={yours || undefined}>
      <span className={`${s.kpiLabel} type-label`}>{label}</span>
      <span className={`${s.kpiValue} type-number`}>{value}</span>
      <span className={`${s.kpiNote} type-meta`}>{note}</span>
    </div>
  );
}

/** A Needs-you row: type pill in the raiser's hue, title, meta, clock, one action. */
export function NeedsRow({
  type,
  hue,
  title,
  meta,
  clock,
  clockYours,
  action,
}: {
  type: string;
  hue: string;
  title: string;
  meta: string;
  clock: string;
  clockYours: boolean;
  action: CardAction;
}) {
  return (
    <div className={s.needsRow}>
      <span className={`${s.typePill} type-label`} style={{ background: hue }}>
        {type}
      </span>
      <span className={s.needsText}>
        <span className={s.needsTitle}>{title}</span>
        <span className="type-meta">{meta}</span>
      </span>
      <span className={`${s.needsClock} type-button`} data-yours={clockYours || undefined}>
        {clock}
      </span>
      <Button onClick={action.run}>{action.label}</Button>
    </div>
  );
}

/** A progress bar in a hue, with the percent beside it. */
export function Bar({
  percent,
  hue,
  label = true,
}: {
  percent: number;
  hue: string;
  label?: boolean;
}) {
  return (
    <span className={s.barWrap}>
      <span className={s.bar} aria-hidden="true">
        <i style={{ width: `${percent}%`, background: hue }} />
      </span>
      {label && <span className={s.barPct}>{percent}%</span>}
    </span>
  );
}

/** Ten segments colored by the team that owns each phase; Everything adds names and a line under. */
export function PhaseStrip({
  phases,
  labelled,
}: {
  phases: {
    key: string;
    name: string;
    percent: number;
    hue: string;
    sub?: string;
    current?: boolean;
    future?: boolean;
  }[];
  labelled?: boolean;
}) {
  return (
    <div className={labelled ? s.stripLabelled : s.strip} aria-label="Phases" role="list">
      {phases.map((p) => (
        <span
          key={p.key}
          className={s.stripItem}
          role="listitem"
          title={`${p.name}: ${p.percent}%`}
        >
          <span className={s.stripTrack} aria-hidden="true">
            <i style={{ width: `${p.percent}%`, background: p.hue }} />
          </span>
          {labelled && (
            <>
              <span
                className={`${s.stripName} type-meta`}
                data-current={p.current || undefined}
                data-future={p.future || undefined}
              >
                {p.name}
              </span>
              <span className={`${s.stripSub} type-meta`}>{p.sub ?? ''}</span>
            </>
          )}
          {!labelled && <span className="sr-only">{`${p.name}, ${p.percent}%`}</span>}
        </span>
      ))}
    </div>
  );
}
