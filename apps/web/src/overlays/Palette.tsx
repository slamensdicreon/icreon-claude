import type { WorkbenchSnapshot } from '@lw/contracts';
import { useMemo, useState } from 'react';
import { post } from '../lib/api';
import { Icon } from '../theme/icons';
import {
  SURFACE_LABEL,
  SURFACES,
  useApp,
  useMission,
  useProjectResource,
  useRoster,
} from '../state';
import { Scrim } from './Dialogs';
import s from './overlays.module.css';

interface Item {
  label: string;
  k: string;
  run: () => void;
}

export function Palette() {
  const app = useApp();
  const {
    go,
    inspect,
    closeOverlay,
    projects,
    projectId,
    switchProject,
    layout,
    setLayout,
    theme,
    setTheme,
    run,
  } = app;
  const mc = useMission().data;
  const { agents } = useRoster();
  const wb = useProjectResource<WorkbenchSnapshot>('/workbench').data;
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const paused = mc?.project.status === 'paused';
  const gate = mc?.waitingOnYou.find((x) => x.type === 'gate' && x.status === 'open');
  const running = mc?.phases.reduce((n, p) => n + p.tasksRunning, 0) ?? 0;

  const items: Item[] = useMemo(
    () => [
      ...SURFACES.map((x) => ({
        label: `Go to ${SURFACE_LABEL[x]}`,
        k: `G ${x[0]!.toUpperCase()}`,
        run: () => go(x),
      })),
      ...agents
        .filter((a) => a.tier !== 'chief_of_staff')
        .map((a) => ({
          label: `Inspect ${a.persona ?? a.name}, ${a.name}`,
          k: 'agent',
          run: () => {
            go('team');
            inspect('agent', a.agentId);
          },
        })),
      {
        label: paused ? 'Resume project' : `Pause project (${running} tasks hold at checkpoints)`,
        k: 'verb',
        run: () =>
          void run(() =>
            post(`/projects/${projectId}/control`, {
              verb: paused ? 'resume' : 'pause',
              scope: { kind: 'project', id: projectId },
            }),
          ),
      },
      {
        label: 'Approve the waiting review',
        k: 'verb',
        run: () =>
          gate
            ? void run(() => post(`/projects/${projectId}/gates/${gate.escalationId}/approve`, {}))
            : app.toast('Nothing is waiting for approval'),
      },
      {
        label: layout.present ? 'Exit presentation mode' : 'Presentation mode',
        k: 'verb',
        run: () => {
          setLayout({ present: !layout.present });
          go('mission');
        },
      },
      ...(
        [
          [null, 'Theme: follow the system'],
          ['light', 'Theme: light'],
          ['dark', 'Theme: dark'],
        ] as const
      )
        .filter(([t]) => t !== theme)
        .map(([t, label]) => ({ label, k: 'verb', run: () => setTheme(t) })),
      { label: 'New project', k: 'verb', run: () => app.newProject() },
      ...projects
        .filter((p) => p.id !== projectId)
        .map((p) => ({
          label: `Switch to ${p.name}`,
          k: 'project',
          run: () => switchProject(p.id),
        })),
      ...(wb?.artifacts ?? []).map((a) => ({
        label: `Open ${a.title}${a.kind === 'blueprint' ? ` v${a.latest}` : ''}`,
        k: 'artifact',
        run: () => go('workbench', { wbArtifact: a.artifactId }),
      })),
      {
        label: 'Open Decision Log',
        k: 'artifact',
        run: () => go('workbench', { wbArtifact: 'decisions' }),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, projects, projectId, wb, paused, gate, layout.present, theme],
  );
  const list = items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));
  const pick = (i: Item | undefined) => {
    if (!i) return;
    closeOverlay();
    i.run();
  };
  return (
    <Scrim>
      <div
        className={`${s.float} ${s.palette}`}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className={s.palIn}>
          <Icon name="search" />
          <input
            className="type-body"
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={list[sel] ? `pal-${sel}` : undefined}
            aria-label="Search or run a command"
            placeholder="Search surfaces, agents and artifacts, or run a command"
            autoComplete="off"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                setSel((v) => Math.min(list.length - 1, v + 1));
                e.preventDefault();
              } else if (e.key === 'ArrowUp') {
                setSel((v) => Math.max(0, v - 1));
                e.preventDefault();
              } else if (e.key === 'Enter') pick(list[sel]);
              else if (e.key === 'Escape') closeOverlay();
            }}
          />
        </div>
        <ul role="listbox" id="palette-list" aria-label="Results" className={s.palList}>
          {list.length ? (
            list.map((i, idx) => (
              <li
                key={i.label}
                id={`pal-${idx}`}
                role="option"
                className={`${s.palItem} type-body-small`}
                aria-selected={idx === sel}
                ref={idx === sel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseEnter={() => setSel(idx)}
                onClick={() => pick(i)}
              >
                {i.label}
                <span className={`${s.palKind} type-label`}>{i.k}</span>
              </li>
            ))
          ) : (
            <li className={`${s.palEmpty} type-body-small`}>No matches</li>
          )}
        </ul>
      </div>
    </Scrim>
  );
}
