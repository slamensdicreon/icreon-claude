/*
 * Every project, made to hold 30 to 50 (the Projects at Scale design). Views across the top
 * (Active, Needs you, Running…), then the platform and the playbook, then how to group; search
 * matches the name, the client and the playbook. Groups fold, and their heads carry the count,
 * the spend and what's yours. The choices stay for this browser; the search doesn't.
 */
import type { PortfolioOverview, PortfolioProject } from '@lw/contracts';
import { useMemo, useState } from 'react';
import { clock, localDate, usd } from '../../lib/fmt';
import { useApp } from '../../state';
import { Icon } from '../../theme/icons';
import { Bar, Button, Chips, hueOf, Panel } from '../../ui/cypher/parts';
import s from './dashboard.module.css';
import { DeletedProjects } from './DeletedProjects';

export type View = 'active' | 'yours' | 'running' | 'intake' | 'paused' | 'archived' | 'all';
type Group = 'playbook' | 'platform' | 'state' | 'none';
interface Prefs {
  view: View;
  platform: string;
  playbook: string;
  group: Group;
}

const VIEWS: { value: View; label: string; test: (p: PortfolioProject) => boolean }[] = [
  { value: 'active', label: 'Active', test: (p) => !p.archived },
  { value: 'yours', label: 'Needs you', test: (p) => p.yours > 0 },
  { value: 'running', label: 'Running', test: (p) => p.status === 'running' },
  { value: 'intake', label: 'Not started', test: (p) => p.status === 'intake' },
  { value: 'paused', label: 'Paused', test: (p) => p.status === 'paused' },
  { value: 'archived', label: 'Archived', test: (p) => p.archived },
  { value: 'all', label: 'All', test: () => true },
];
const GROUPS: { value: Group; label: string }[] = [
  { value: 'playbook', label: 'Playbook' },
  { value: 'platform', label: 'Platform' },
  { value: 'state', label: 'State' },
  { value: 'none', label: 'None' },
];
/** State groups, in the order they read: what's yours first, what's over last. */
const STATES = [
  'Needs you',
  'Running',
  'Not started',
  'Paused',
  'Accepted',
  'Cancelled',
  'Archived',
] as const;

const HEALTH_TONE: Record<string, string> = {
  Healthy: 'var(--green)',
  Attention: 'var(--gold)',
  Blocked: 'var(--coral-text)',
};

const KEY = 'lw-projects';
const DEFAULTS: Prefs = { view: 'active', platform: 'all', playbook: 'all', group: 'playbook' };
function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      view: VIEWS.some((v) => v.value === saved.view) ? saved.view! : DEFAULTS.view,
      platform: typeof saved.platform === 'string' ? saved.platform : DEFAULTS.platform,
      playbook: typeof saved.playbook === 'string' ? saved.playbook : DEFAULTS.playbook,
      group: GROUPS.some((g) => g.value === saved.group) ? saved.group! : DEFAULTS.group,
    };
  } catch {
    return DEFAULTS;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: the choices just don't stay */
  }
}

/**
 * "Build a SitecoreAI website" → "Website": the platform sits beside it, so the playbook is named
 * by what it builds.
 */
export function playbookShort(p: PortfolioProject): string {
  if (!p.playbook) return 'No playbook';
  let name = p.playbook.name.replace(/^build an? /i, '');
  if (p.platform && name.toLowerCase().startsWith(`${p.platform.name.toLowerCase()} `))
    name = name.slice(p.platform.name.length + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
const platformOf = (p: PortfolioProject) => p.platform?.name ?? 'Other';
const stateOf = (p: PortfolioProject): (typeof STATES)[number] =>
  p.yours > 0
    ? 'Needs you'
    : p.status === 'running'
      ? 'Running'
      : p.status === 'intake'
        ? 'Not started'
        : p.status === 'paused'
          ? 'Paused'
          : p.status === 'cancelled'
            ? 'Cancelled'
            : p.status === 'archived'
              ? 'Archived'
              : 'Accepted';

export function ProjectsTable({ o }: { o: PortfolioOverview }) {
  const { switchProject, newProject } = useApp();
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...patch };
      savePrefs(next);
      return next;
    });
  const tz = o.timezone;
  const hm = (at: string) => clock(at, tz).replace(/\s?[AP]M$/, '');

  const model = useMemo(() => {
    const q = query.trim().toLowerCase();
    const viewTest = VIEWS.find((v) => v.value === prefs.view)!.test;
    const matches = (p: PortfolioProject) =>
      !q ||
      [p.name, p.client, p.playbook?.name ?? '', p.platform?.name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q);
    const inView = o.projects.filter((p) => viewTest(p) && matches(p));

    // Platforms and playbooks known across every project, so a chip doesn't vanish when its count
    // drops to nothing; counted within the view (and, for playbooks, the platform chosen).
    // The platform with the most projects first.
    const tally = new Map<string, number>();
    for (const p of o.projects) tally.set(platformOf(p), (tally.get(platformOf(p)) ?? 0) + 1);
    const platforms = [...tally.keys()].sort(
      (a, b) => tally.get(b)! - tally.get(a)! || a.localeCompare(b),
    );
    const platformKey = platforms.includes(prefs.platform) ? prefs.platform : 'all';
    const onPlatform = inView.filter((p) => platformKey === 'all' || platformOf(p) === platformKey);
    const playbookIds = new Map<string, string>();
    for (const p of o.projects)
      if (platformKey === 'all' || platformOf(p) === platformKey)
        playbookIds.set(p.playbook?.id ?? 'none', playbookShort(p));
    // Two platforms' "Website" playbooks, side by side: name them in full.
    const labels = [...playbookIds.values()];
    const playbooks = [...playbookIds.entries()].map(([id, short]) => {
      const full = o.projects.find((p) => (p.playbook?.id ?? 'none') === id);
      return {
        id,
        label:
          labels.filter((l) => l === short).length > 1 && full?.playbook
            ? full.playbook.name
            : short,
      };
    });
    const playbookKey = playbookIds.has(prefs.playbook) ? prefs.playbook : 'all';
    const rows = onPlatform.filter(
      (p) => playbookKey === 'all' || (p.playbook?.id ?? 'none') === playbookKey,
    );

    const keyOf = (p: PortfolioProject) =>
      prefs.group === 'platform'
        ? platformOf(p)
        : prefs.group === 'playbook'
          ? (playbooks.find((b) => b.id === (p.playbook?.id ?? 'none'))?.label ?? playbookShort(p))
          : prefs.group === 'state'
            ? stateOf(p)
            : 'All';
    const groups = new Map<string, PortfolioProject[]>();
    for (const p of rows) {
      const k = keyOf(p);
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    const ordered = [...groups.entries()].sort(([a], [b]) =>
      prefs.group === 'state'
        ? STATES.indexOf(a as (typeof STATES)[number]) -
          STATES.indexOf(b as (typeof STATES)[number])
        : 0,
    );
    return {
      views: VIEWS.map((v) => ({
        value: v.value,
        label: v.label,
        count: o.projects.filter((p) => v.test(p) && matches(p)).length,
      })).filter(
        (v) =>
          v.count > 0 || v.value === prefs.view || ['active', 'archived', 'all'].includes(v.value),
      ),
      platforms: platforms.map((name) => ({
        value: name,
        label: name,
        count: inView.filter((p) => platformOf(p) === name).length,
      })),
      platformKey,
      inViewCount: inView.length,
      onPlatformCount: onPlatform.length,
      playbooks: playbooks.map((b) => ({
        value: b.id,
        label: b.label,
        count: onPlatform.filter((p) => (p.playbook?.id ?? 'none') === b.id).length,
      })),
      playbookKey,
      groups: ordered,
      shown: rows.length,
    };
  }, [o.projects, prefs, query]);

  const filtered = model.platformKey !== 'all' || model.playbookKey !== 'all' || !!query.trim();
  const clear = () => {
    setPrefs({ platform: 'all', playbook: 'all' });
    setQuery('');
  };

  return (
    <div id="projects">
      <Panel
        title="Projects"
        chips={
          <Chips<View>
            label="Show projects"
            value={prefs.view}
            onChange={(view) => setPrefs({ view })}
            options={model.views}
          />
        }
        meta={
          <span className={s.headRight}>
            <Button kind="secondary" onClick={() => newProject()}>
              New project
            </Button>
          </span>
        }
      >
        <div className={s.filters}>
          <label className={s.search}>
            <Icon name="search" size={18} />
            <input
              className="type-body-small"
              type="search"
              placeholder="Search projects, clients, playbooks"
              aria-label="Search projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className={s.filterRow}>
            <span className={`${s.filterLabel} type-label`}>Platform</span>
            <Chips<string>
              label="Platform"
              value={model.platformKey}
              onChange={(platform) => setPrefs({ platform, playbook: 'all' })}
              options={[
                { value: 'all', label: 'All', count: model.inViewCount },
                ...model.platforms,
              ]}
            />
          </div>
          <div className={s.filterRow}>
            <span className={`${s.filterLabel} type-label`}>Playbook</span>
            <Chips<string>
              label="Playbook"
              value={model.playbookKey}
              onChange={(playbook) => setPrefs({ playbook })}
              options={[
                { value: 'all', label: 'All', count: model.onPlatformCount },
                ...model.playbooks,
              ]}
            />
          </div>
          <div className={s.filterRow}>
            <span className={`${s.filterLabel} type-label`}>Group by</span>
            <Chips<Group>
              label="Group by"
              value={prefs.group}
              onChange={(group) => setPrefs({ group })}
              options={GROUPS}
            />
            {filtered && (
              <Button kind="secondary" onClick={clear}>
                Clear filters
              </Button>
            )}
          </div>
        </div>

        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Project</th>
                <th>Platform · playbook</th>
                <th>Phase</th>
                <th className={s.progressCol}>Progress</th>
                <th className={s.num}>Spend</th>
                <th>Last event</th>
              </tr>
            </thead>
            {model.groups.map(([key, ps]) => {
              const open = !closed[key];
              const yours = ps.reduce((n, p) => n + p.yours, 0);
              const spent = ps.reduce((n, p) => n + p.spentUsd, 0);
              return (
                <tbody key={key}>
                  {prefs.group !== 'none' && (
                    <tr className={s.groupRow}>
                      <th colSpan={6} scope="rowgroup">
                        <button
                          type="button"
                          className={s.groupHead}
                          aria-expanded={open}
                          onClick={() => setClosed((c) => ({ ...c, [key]: open }))}
                        >
                          <span className={s.groupChev} data-open={open || undefined}>
                            <Icon name="chevron" size={16} />
                          </span>
                          <span className={s.groupName}>{key}</span>
                          <span className={`${s.groupMeta} type-meta`}>
                            {ps.length} {ps.length === 1 ? 'project' : 'projects'} · {usd(spent)}{' '}
                            spent
                          </span>
                          {yours > 0 && (
                            <span className={`${s.yoursBadge} type-label`}>{yours} yours</span>
                          )}
                        </button>
                      </th>
                    </tr>
                  )}
                  {open &&
                    ps.map((p) => (
                      <ProjectRow
                        key={p.projectId}
                        p={p}
                        hm={hm}
                        tz={tz}
                        onOpen={() => switchProject(p.projectId)}
                      />
                    ))}
                </tbody>
              );
            })}
            {model.shown === 0 && (
              <tbody>
                <tr>
                  <td colSpan={6} className={s.empty}>
                    No project matches.{' '}
                    {filtered && (
                      <button type="button" className={s.linkButton} onClick={clear}>
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </div>
        <p className={`${s.tableFoot} type-meta`}>
          Showing {model.shown} of {o.projects.length} projects · what needs you first
        </p>
      </Panel>
      {prefs.view === 'archived' && <DeletedProjects />}
    </div>
  );
}

function ProjectRow({
  p,
  hm,
  tz,
  onOpen,
}: {
  p: PortfolioProject;
  hm: (at: string) => string;
  tz: string;
  onOpen: () => void;
}) {
  const today = p.lastEvent && localDate(p.lastEvent.at, tz) === localDate(Date.now(), tz);
  return (
    <tr data-yours={p.yours > 0 || undefined} className={s.projectRow}>
      <td>
        <button type="button" className={s.projectCell} onClick={onOpen}>
          <span
            className={`${s.tile} type-label`}
            style={{ background: p.archived ? 'var(--text-3)' : hueOf(p.hue) }}
            aria-hidden="true"
          >
            {p.initials}
          </span>
          <span className={s.projectName}>
            <b>
              {p.name}
              {p.yours > 0 && <span className={`${s.yoursBadge} type-label`}>{p.yours} yours</span>}
            </b>
            <span className="type-meta">
              <span style={{ color: HEALTH_TONE[p.healthWord] ?? 'var(--text-3)' }}>
                {p.healthWord}
              </span>
              {p.client && <span className={s.quiet}> · {p.client}</span>}
            </span>
          </span>
        </button>
      </td>
      <td className={s.secondary}>
        <span className={s.stack}>
          <span>{platformOf(p)}</span>
          <span className={`${s.quiet} type-meta`}>{playbookShort(p)}</span>
        </span>
      </td>
      <td className={`${s.secondary} ${s.nowrap}`}>{p.phaseLabel}</td>
      <td>
        <Bar percent={p.percent} hue={p.archived ? 'var(--text-3)' : hueOf(p.hue)} />
      </td>
      <td className={`${s.num} ${s.secondary}`}>
        <span className={s.stack}>
          <span>{usd(p.spentUsd)}</span>
          {p.budgetUsd > 0 && <span className={`${s.quiet} type-meta`}>of {usd(p.budgetUsd)}</span>}
        </span>
      </td>
      <td className={s.last}>
        {p.lastEvent && (
          <>
            <b>{today ? hm(p.lastEvent.at) : shortDate(p.lastEvent.at, tz)}</b> {p.lastEvent.text}
          </>
        )}
      </td>
    </tr>
  );
}

function shortDate(at: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(
    new Date(at),
  );
}
