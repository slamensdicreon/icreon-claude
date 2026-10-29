import type { EscalationView } from '@lw/contracts';
import { useState } from 'react';
import { post } from '../lib/api';
import { age, clock, zoneLabel } from '../lib/fmt';
import { Icon } from '../lib/icons';
import { TypedConfirm } from '../overlays/Dialogs';
import { MakeRule } from '../overlays/MakeRule';
import { useApp, useNow, useRoster, useTz } from '../state';
import { useJump, Who } from './bits';

export const TYPE_LABEL: Record<string, string> = {
  decision: 'Decision',
  blocker: 'Blocker',
  access: 'Access',
  budget: 'Budget',
  risk: 'Risk',
  gate: 'Review',
};

export const keyOf = (x: EscalationView, i: number) =>
  x.options[i]?.key ?? String.fromCharCode(65 + i);

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Time left in words a glance can read: "18:42" under an hour, "1 h 05" above. */
function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600)
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function useCardActions(x: EscalationView) {
  const { projectId, run, go, setLayout, setComposer, openOverlay, closeOverlay } = useApp();
  const base = `/projects/${projectId}`;
  return {
    /** Opens the card in Needs you, where decisions are made one at a time. */
    expand: () => go('inbox', { expanded: x.escalationId }),
    choose: (optionId: string, notes?: string) =>
      run(() =>
        post(`${base}/escalations/${x.escalationId}/resolve`, {
          optionId,
          ...(notes?.trim() ? { notes: notes.trim() } : {}),
          // A grouped card stands for its siblings: one answer for all of them.
          ...(x.group ? { all: true } : {}),
        }),
      ),
    defer: () =>
      run(() =>
        post(`${base}/escalations/${x.escalationId}/defer`, {
          until: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      ),
    resume: () => run(() => post(`${base}/escalations/${x.escalationId}/resume`)),
    undo: () => run(() => post(`${base}/escalations/${x.escalationId}/undo`)),
    approve: (name: string) => {
      if (x.gate?.requiresConfirmation) {
        openOverlay(
          <TypedConfirm
            title={`Approve ${x.title}?`}
            body="This gate closes the engagement. Approval is final and cannot be undone."
            confirmLabel="Approve"
            typed={name}
            danger={false}
            onConfirm={() => {
              closeOverlay();
              void run(() =>
                post(`${base}/gates/${x.escalationId}/approve`, { confirmation: name }),
              );
            }}
          />,
        );
        return;
      }
      void run(() => post(`${base}/gates/${x.escalationId}/approve`, {}));
    },
    sendBack: (notes: string) =>
      run(() => post(`${base}/gates/${x.escalationId}/send-back`, { notes })),
    ask: () => {
      setComposer({ text: `About ${x.title}: `, about: x.escalationId, focus: true });
      setLayout({ dockOpen: true });
    },
  };
}

function resolutionText(x: EscalationView): string {
  const r = x.resolution;
  if (!r) return '';
  if (x.type === 'gate') return r.optionId === 'approve' ? 'Approved' : 'Sent back with notes';
  const i = x.options.findIndex((o) => o.id === r.optionId);
  const key = i >= 0 ? keyOf(x, i) : '';
  if (r.by === 'default') return `Proceeded with option ${key} (default)`;
  return `Chose ${key}: ${x.options[i]?.label ?? ''}`;
}

/**
 * An escalation card. `compact` on Mission Control, `queue` in the dock (compact until expanded),
 * `full` when open. Resolved cards keep an Undo while their window is open.
 */
export function Card({
  x,
  mode,
  projectName,
  about,
}: {
  x: EscalationView;
  mode: 'compact' | 'queue' | 'full';
  projectName: string;
  /** Who raised it and the task it holds up, when known. */
  about?: { task: string | null; who: string | null };
}) {
  const { ui, projectId, openOverlay } = useApp();
  const tz = useTz();
  const now = useNow();
  const jump = useJump();
  const act = useCardActions(x);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const type = <span className={`type ${x.type}`}>{x.typeLabel ?? TYPE_LABEL[x.type]}</span>;

  if (x.status === 'resolved' || x.status === 'expired') {
    const canUndo = x.undoUntil && Date.parse(x.undoUntil) > now;
    const by = {
      director: 'You',
      default: 'Default action',
      chief_of_staff: 'Cypher',
      lead: 'The Lead',
      rule: 'A rule, applied by the Lead',
    }[x.resolution?.by ?? 'chief_of_staff'];
    return (
      <div className="card resolved">
        <div className="resolved-line">
          {type}
          <b>{x.title}</b>
          {canUndo && (
            <button className="link-btn undo" onClick={act.undo}>
              Undo
            </button>
          )}
        </div>
        <div className="resolved-sub">
          {resolutionText(x)}. {by}, {x.resolvedAt ? clock(x.resolvedAt, tz) : ''} {zoneLabel(tz)}.
          {x.type !== 'gate' && !canUndo && projectId && (
            <button
              className="link-btn make-rule"
              onClick={() =>
                openOverlay(<MakeRule projectId={projectId} escalationId={x.escalationId} />)
              }
            >
              Make this a rule
            </button>
          )}
        </div>
      </div>
    );
  }

  if (x.status === 'deferred') {
    return (
      <div className="card resolved">
        <div className="resolved-line">
          {type}
          <b>{x.title}</b>
          <button className="link-btn undo" onClick={act.resume}>
            Resume now
          </button>
        </div>
        <div className="resolved-sub">
          Deferred until {x.deferredUntil ? clock(x.deferredUntil, tz) : ''} {zoneLabel(tz)}.
        </div>
      </div>
    );
  }

  const rec = x.type === 'gate' ? null : (x.options.find((o) => o.recommended) ?? null);
  const compact = mode === 'compact' || (mode === 'queue' && ui.expanded !== x.escalationId);
  if (compact) {
    return (
      <div
        className={`card ${x.type} compact`}
        role="button"
        tabIndex={0}
        onClick={act.expand}
        onKeyDown={(e) => e.key === 'Enter' && act.expand()}
      >
        <div className="compact-line">
          {type}
          <span className="age">{age(x.raisedAt, now)}</span>
        </div>
        <div className="card-title">{x.title}</div>
        {rec ? (
          <div className="card-rec">Recommended: {lower(rec.label)}</div>
        ) : x.type === 'gate' ? (
          <div className="card-rec">{x.waitNote ?? 'Waits for you.'}</div>
        ) : null}
      </div>
    );
  }

  const defaultIdx = x.options.findIndex((o) => o.id === x.defaultOptionId);
  const remaining = x.deadline ? Date.parse(x.deadline) - now : null;
  return (
    <div className={`card ${x.type} full`}>
      <div className="card-top">
        {type}
        <span className="age">{age(x.raisedAt, now)}</span>
      </div>
      <h4 className="card-h">{x.title}</h4>
      {about && (about.who || about.task) && (
        <p className="card-about">
          {about.who && <span>From {about.who}</span>}
          {about.task && <span>About {about.task}</span>}
        </p>
      )}
      <p className="ctx">
        <Who text={x.context} />
      </p>
      {x.group && (
        <p className="card-group">
          The same problem on {x.group.taskIds.length} tasks:{' '}
          {x.group.taskTitles.slice(0, 4).join('; ')}
          {x.group.taskTitles.length > 4 ? `; and ${x.group.taskTitles.length - 4} more` : ''}. Your
          answer applies to all of them.
        </p>
      )}
      {x.triage && <LeadNote x={x} />}
      <div className="impact">
        <span>Impact</span>
        <p>
          <Who text={x.impact} />
        </p>
      </div>
      {x.type !== 'gate' && (
        <div className="opts">
          <label className="opt-note-label" htmlFor={`note-${x.escalationId}`}>
            Details for the team (optional)
          </label>
          <textarea
            id={`note-${x.escalationId}`}
            className="notes opt-note"
            rows={2}
            placeholder="A URL, a name, a correction. Sent with the option you choose."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {x.options.map((o, i) => (
            <button
              key={o.id}
              className={`opt ${o.recommended ? 'recommended' : ''}`}
              onClick={() => act.choose(o.id, notes)}
            >
              <span className="key">{keyOf(x, i)}</span>
              <span className="otext">{o.label}</span>
              {o.recommended && <span className="rec">Recommended</span>}
            </button>
          ))}
        </div>
      )}
      {x.deadline && defaultIdx >= 0 ? (
        <div className="deadline">
          <Icon name="time" sm />
          <span>
            Proceeds with {keyOf(x, defaultIdx)} at{' '}
            <b>
              {clock(x.deadline, tz)} {zoneLabel(tz)}
            </b>{' '}
            unless you choose
          </span>
          <b className="left">{left(remaining ?? 0)}</b>
        </div>
      ) : x.type === 'gate' ? (
        <div className="deadline" style={{ marginTop: 12 }}>
          <Icon name="information" sm />
          <span>Waits for you. No default action.</span>
        </div>
      ) : null}
      {x.evidence.length > 0 && (
        <div className="evidence">
          {x.evidence.map((ev) => (
            <a
              key={ev.label}
              href="#"
              className="evchip"
              onClick={(e) => {
                e.preventDefault();
                jump(ev);
              }}
            >
              <Icon name="link" sm />
              {ev.label}
            </a>
          ))}
        </div>
      )}
      {x.type === 'gate' ? (
        <>
          <div className="card-actions">
            <button className="btn primary sm" onClick={() => act.approve(projectName)}>
              Approve
            </button>
            <button className="btn sm" onClick={() => setNotesOpen(true)}>
              Send back with notes
            </button>
            <button className="btn sm" onClick={act.ask}>
              Ask a question
            </button>
          </div>
          {notesOpen && (
            <>
              <textarea
                className="notes"
                autoFocus
                placeholder="What should change before approval?"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="card-actions" style={{ borderTop: 0, paddingTop: 0 }}>
                <button
                  className="btn sm primary"
                  disabled={!notes.trim()}
                  onClick={() => void act.sendBack(notes.trim())}
                >
                  Send back
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="card-actions">
          <button className="btn sm" onClick={act.ask}>
            Ask a question
          </button>
          <button className="btn sm" onClick={act.defer}>
            Defer 30 min
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * What the Lead made of the question before it came here: in shadow, the answer it would have
 * given (the Director's choice is compared with it on the scorecard); forwarded, why it's yours.
 */
function LeadNote({ x }: { x: EscalationView }) {
  const { byId } = useRoster();
  const t = x.triage!;
  const lead = byId(t.leadId)?.name ?? 'The Lead';
  const option = x.options.find((o) => o.id === t.optionId);
  return (
    <p className={`card-lead ${t.mode}`}>
      {t.mode === 'shadow' && option ? (
        <>
          <b>{lead} would answer:</b> {option.label}. {t.reasoning}
        </>
      ) : (
        <>
          <b>{lead} passed this to you:</b> {t.reasoning}
        </>
      )}
    </p>
  );
}
