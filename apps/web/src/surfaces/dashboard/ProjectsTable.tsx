/*
 * Every project, made to hold 30 to 50 (the Projects at Scale design). Views across the top
 * (Active, Needs you, Running…), then the platform and the playbook, then how to group; search
 * matches the name, the client and the playbook. Groups fold, and their heads carry the count,
 * the spend and what's yours. The choices stay for this browser; the search doesn't.
 */
import { ProjectIcon } from '../../ui/project-icon';
import type { PortfolioOverview, PortfolioProject } from '@lw/contracts';
import { useEffect, useMemo, useState } from 'react';
import { clock, localDate, usd } from '../../lib/fmt';
import { useApp } from '../../state';
import { Icon } from '../../theme/icons';
import { Bar, Button, Chips, hueOf, Panel } from '../../ui/cypher/parts';
import s from './dashboard.module.css';
import { BulkBar } from './BulkActions';
import { DeletedProjects } from './DeletedProjects';
import { platformOf, playbookShort } from './projectNames';

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
 * Opens the table on a view, with the platform and playbook cleared: what Bliss's "See them" lines
 * do before switching to Everything. The table reads its choices when it mounts.
 */
export function showProjectsView(view: View) {
  savePrefs({ ...loadPrefs(), view, platform: 'all', playbook: 'all' });
  // A table already on screen takes the new view too.
  window.dispatchEvent(new Event(VIEW_EVENT));
}
const VIEW_EVENT = 'lw-projects-view';

/**
 * Opens the projects table on the projects that are still going (not accepted, cancelled or
 * archived), whatever view was picked last: "All projects" from the menu or the switcher starts
 * there, as the list grows. All and Archived stay a click away.
 */
export function showActiveProjects() {
  showProjectsView('active');
}

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

export function ProjectsTable({ o, refresh }: { o: PortfolioOverview; refresh: () => void }) {
  const { switchProject, newProject } = useApp();
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // On a phone the filters fold behind a button, so the projects come first.
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    const reload = () => setPrefsState(loadPrefs());
    window.addEventListener(VIEW_EVENT, reload);
    return () => window.removeEventListener(VIEW_EVENT, reload);
  }, []);
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

  // What's ticked, among the projects that still exist; and the rows on show, for "select all".
  const selected = o.projects.filter((p) => picked.has(p.projectId));
  const shownIds = model.groups.flatMap(([, ps]) => ps.map((p) => p.projectId));
  const allPicked = shownIds.length > 0 && shownIds.every((id) => picked.has(id));
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setPicked((cur) => {
      const next = new Set(cur);
      for (const id of shownIds) {
        if (allPicked) next.delete(id);
        else next.add(id);
      }
      return next;
    });

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
          <span className={s.viewChips}>
            <Chips<View>
              label="Show projects"
              value={prefs.view}
              onChange={(view) => setPrefs({ view })}
              options={model.views}
            />
          </span>
        }
        meta={
          <span className={s.headRight}>
            <Button kind="secondary" onClick={() => newProject()}>
              New project
            </Button>
          </span>
        }
      >
        <div className={s.filters} data-open={filtersOpen || undefined}>
          <div className={s.searchRow}>
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
            <button
              type="button"
              className={`${s.filtersToggle} type-button`}
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              Filters
              {(filtered && !query.trim()) || prefs.group !== DEFAULTS.group ? ' •' : ''}
            </button>
          </div>
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

        {selected.length > 0 && (
          <BulkBar selected={selected} onClear={() => setPicked(new Set())} onDone={refresh} />
        )}
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>
                  <span className={s.pickHead}>
                    <input
                      type="checkbox"
                      className={s.pick}
                      aria-label={
                        allPicked ? 'Clear the projects shown' : 'Select every project shown'
                      }
                      checked={allPicked}
                      disabled={shownIds.length === 0}
                      onChange={toggleAll}
                    />
                    Project
                  </span>
                </th>
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
                        picked={picked.has(p.projectId)}
                        onPick={() => toggle(p.projectId)}
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
  picked,
  onPick,
  onOpen,
}: {
  p: PortfolioProject;
  hm: (at: string) => string;
  tz: string;
  picked: boolean;
  onPick: () => void;
  onOpen: () => void;
}) {
  const today = p.lastEvent && localDate(p.lastEvent.at, tz) === localDate(Date.now(), tz);
  return (
    <tr
      data-yours={p.yours > 0 || undefined}
      data-picked={picked || undefined}
      className={s.projectRow}
    >
      <td>
        <span className={s.pickCell}>
          <input
            type="checkbox"
            className={s.pick}
            aria-label={`Select ${p.name}`}
            checked={picked}
            onChange={onPick}
          />
          <button type="button" className={s.projectCell} onClick={onOpen}>
            <span
              className={`${s.tile} type-label`}
              style={{ background: p.archived ? 'var(--text-3)' : hueOf(p.hue) }}
              aria-hidden="true"
            >
              {p.initials}
              <ProjectIcon projectId={p.projectId} />
            </span>
            <span className={s.projectName}>
              <b>
                {p.name}
                {p.yours > 0 && (
                  <span className={`${s.yoursBadge} type-label`}>{p.yours} yours</span>
                )}
              </b>
              <span className="type-meta">
                <span style={{ color: HEALTH_TONE[p.healthWord] ?? 'var(--text-3)' }}>
                  {p.healthWord}
                </span>
                {p.client && <span className={s.quiet}> · {p.client}</span>}
              </span>
            </span>
          </button>
        </span>
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
