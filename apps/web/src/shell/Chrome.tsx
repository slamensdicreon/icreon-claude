/*
 * The shell's phone bar and toasts, and the "since you were away" summary. On a phone the rail and
 * sidebar give way to a bottom bar: Mission, Team, Plan, then what is the Director's (Bliss) or
 * Cypher (Everything), then More.
 */
import type { SinceSummary } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { get } from '../lib/api';
import { useMode } from '../mode/mode';
import { MoreSheet } from '../overlays/Menus';
import { useApp, useMission, type Surface } from '../state';
import { Icon, type IconName } from '../theme/icons';
import { Eye } from '../ui/Eye';
import { useEyeState } from '../voice/eye';
import c from './chrome.module.css';

export function MobileNav() {
  const { surface, go, layout, setLayout, openOverlay, projects, projectId } = useApp();
  const bliss = useMode().mode === 'bliss';
  const eye = useEyeState();
  const waiting = projects.find((p) => p.id === projectId)?.waitingCount ?? 0;
  // The Dashboard has no project surfaces to switch between.
  if (!projectId || layout.present) return null;
  const item = (s: Surface, icon: IconName, label: string) => (
    <button
      type="button"
      className={c.item}
      aria-current={surface === s && !layout.dockOpen ? 'page' : undefined}
      onClick={() => go(s)}
    >
      <Icon name={icon} size={22} />
      <span className="type-rail-label">{label}</span>
    </button>
  );
  return (
    <nav className={c.mnav} aria-label="Sections">
      {item('mission', 'home', 'Mission')}
      {item('team', 'team', 'Team')}
      {item('plan', 'plan', 'Plan')}
      {/* Bliss has no chat: what is yours is the fourth place instead. */}
      {bliss ? (
        <button
          type="button"
          className={c.item}
          aria-current={surface === 'inbox' ? 'page' : undefined}
          onClick={() => go('inbox')}
        >
          <Icon name="inbox" size={22} />
          <span className="type-rail-label">Yours</span>
          {waiting > 0 && <span className={`${c.badge} type-label`}>{waiting}</span>}
        </button>
      ) : (
        <button
          type="button"
          className={c.item}
          aria-current={layout.dockOpen ? 'page' : undefined}
          onClick={() => setLayout({ dockOpen: !layout.dockOpen })}
        >
          <Eye state={eye.state} size={22} decorative />
          <span className="type-rail-label">Cypher</span>
          {waiting > 0 && <span className={`${c.badge} type-label`}>{waiting}</span>}
        </button>
      )}
      <button type="button" className={c.item} onClick={() => openOverlay(<MoreSheet />)}>
        <Icon name="more" size={22} />
        <span className="type-rail-label">More</span>
      </button>
    </nav>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className={c.toasts} aria-live="polite">
      {toasts.map((t) => (
        <div className={`${c.toast} type-body-small`} key={t.id}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="type-button"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * "Since you were away": when the page comes back after a while, or opens on a project seen
 * before, sum up what changed since the last event the Director saw.
 */
export function useAwayLine() {
  const { projectId, setUi } = useApp();
  const seq = useMission().data?.seq ?? null;
  const seqRef = useRef(seq);
  seqRef.current = seq;

  useEffect(() => {
    if (!projectId || seq === null) return;
    const key = `lw-seen-${projectId}`;
    let seen: number | null = null;
    try {
      seen = Number(localStorage.getItem(key)) || null;
    } catch {
      /* no storage: no away line on reload */
    }
    const summarize = (from: number, label?: string) =>
      get<SinceSummary>(`/projects/${projectId}/since?seq=${from}`)
        .then((s) => {
          if (!s.events) return;
          const parts = [
            `${s.raised} escalation${s.raised === 1 ? '' : 's'} raised, ${s.resolved} resolved.`,
            s.phase ? `${s.phase.name} moved to ${s.phase.percent}%.` : '',
            s.usd ? `$${s.usd} consumed.` : '',
          ];
          setUi({
            awayLine: `Since you were away (${label ?? `${s.minutes} min`}): ${parts.filter(Boolean).join(' ')}`,
          });
        })
        .catch(() => {});
    if (seen !== null && seen < seq - 20) void summarize(seen);
    let hiddenAt: { t: number; seq: number } | null = null;
    const onVis = () => {
      if (document.hidden) hiddenAt = { t: Date.now(), seq: seqRef.current ?? 0 };
      else if (hiddenAt && Date.now() - hiddenAt.t > 20_000) {
        void summarize(hiddenAt.seq, `${Math.round((Date.now() - hiddenAt.t) / 60_000)} min`);
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // Only when the project changes: later snapshots just move the bookmark below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId || seq === null) return;
    try {
      localStorage.setItem(`lw-seen-${projectId}`, String(seq));
    } catch {
      /* no storage */
    }
  }, [projectId, seq]);
}
