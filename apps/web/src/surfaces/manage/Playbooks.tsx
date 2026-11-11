/*
 * What a new project can run: the catalog by entity (lib/showcase.catalogGroups), each playbook
 * that runs today with its charter, phases and gates, team, what intake asks for, how its projects
 * went and Start a project; the roadmap as readable tiles that do nothing. The same data as the
 * old page (Playbooks in surfaces/Dashboard.tsx), on Cypher's parts.
 */
import type { PlaybookScorecard, PlaybookSummary, PortfolioItem } from '@lw/contracts';
import { catalogGroups, readiness, type CatalogGroup } from '../../lib/showcase';
import { useApp } from '../../state';
import { Panel } from '../../ui/cypher/parts';
import { Action, Notice, usePlaybooks } from '../intake/shared';
import { PlaybookComparison } from './PlaybookComparison';
import { count, Lead, Pending, useResource } from './shared';
import s from './manage.module.css';

const ROADMAP = 'On the roadmap: readable now, runnable later';

export function Playbooks({ projects }: { projects: PortfolioItem[] }) {
  const { playbooks, error } = usePlaybooks();
  if (!playbooks) return <Pending error={null} loading="Loading playbooks…" />;
  if (error && !playbooks.length) return <Pending error={error} loading="" />;
  const groups = catalogGroups(playbooks);
  return (
    <div className={s.page}>
      <Lead>
        Each playbook sets the team, its plan, its gates and what intake asks for. Entities and
        playbooks on the roadmap are listed so the catalog reads as a whole; nothing can start on
        them yet.
      </Lead>
      {groups.map((g) => (
        <Entity key={g.entity.id} group={g} projects={projects} />
      ))}
    </div>
  );
}

function Entity({ group, projects }: { group: CatalogGroup; projects: PortfolioItem[] }) {
  const { entity, playbooks } = group;
  const ready = playbooks.filter((p) => p.status !== 'coming' && p.summary);
  const coming = playbooks.filter((p) => p.status === 'coming');
  const headingId = `entity-${entity.id}`;
  return (
    <section className={s.entity} aria-labelledby={headingId}>
      <header className={s.entityHead}>
        <span className={s.entityTitle}>
          <h2 id={headingId} className="type-heading">
            {entity.name}
          </h2>
          {entity.status === 'coming' && <span className={`${s.tag} type-meta`}>Coming soon</span>}
        </span>
        <span className={`${s.entityMeta} type-meta`}>
          {entity.vendor} · {entity.category} · {readiness(group) || ROADMAP}
        </span>
        <p className={`${s.lead} type-body-small`}>{entity.description}</p>
      </header>
      {ready.map((p) => (
        <PlaybookPanel key={p.id} pb={p.summary!} projects={projects} />
      ))}
      {coming.length > 0 && (
        <div className={s.roadmap}>
          <p className={`${s.groupLabel} type-label`}>
            {ready.length ? 'Also on the roadmap' : 'On the roadmap'}
          </p>
          {/* Readable, not actionable: plain list items, so nothing is focusable or clickable. */}
          <ul className={s.tiles}>
            {coming.map((p) => (
              <li key={p.id} className={s.tile}>
                <span className={s.tileTop}>
                  <span className={`${s.eyebrow} type-label`}>{entity.name}</span>
                  <span className={`${s.tag} type-meta`}>Coming soon</span>
                </span>
                <span className={`${s.tileTitle} type-section`}>{p.name}</span>
                <span className={`${s.tileBody} type-body-small`}>{p.description}</span>
                <span className={`${s.tileFoot} type-meta`}>{ROADMAP}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PlaybookPanel({ pb, projects }: { pb: PlaybookSummary; projects: PortfolioItem[] }) {
  const { newProject } = useApp();
  const ran = projects.filter((p) => p.playbook?.id === pb.id);
  const kept = pb.kept ?? [];
  return (
    <Panel
      title={pb.name}
      label={pb.name}
      meta={
        <span className={s.headRight}>
          Version {pb.version}
          <Action kind="primary" onClick={() => newProject({ preset: { playbookId: pb.id } })}>
            Start a project
          </Action>
        </span>
      }
    >
      <div className={s.playbook}>
        <div className={s.playbookMain}>
          <p className={`${s.body} type-body-small`}>{pb.description}</p>
          <p className={`${s.lead} type-body-small`}>{pb.charter.mission}</p>
          <h3 className={`${s.subhead} type-label`}>Outcomes</h3>
          <ul className={s.outcomes}>
            {pb.charter.outcomes.map((o) => (
              <li key={o.id} className="type-body-small">
                <b>{o.title}</b>
                <span className={`${s.muted} type-meta`}>{o.measure}</span>
              </li>
            ))}
          </ul>
        </div>
        {pb.phases.length > 0 && (
          <div className={s.playbookSide}>
            <h3 className={`${s.subhead} type-label`}>Phases</h3>
            <ol className={s.phases}>
              {pb.phases.map((ph) => (
                <li key={ph.number} className="type-body-small">
                  <span className={s.phaseNo}>{ph.number}</span>
                  <span className={s.phaseName}>
                    {ph.name}
                    {ph.gate && <span className={`${s.gate} type-meta`}>{ph.gate}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {ran.some((p) => !p.demo) && <Compare playbookId={pb.id} />}

      <div className={s.disclosures}>
        {pb.roles.length > 0 && (
          <details className={s.disclosure}>
            <summary className="type-body-small">
              The team ({count(pb.roles.length, 'role')})
            </summary>
            <ul className={s.defs}>
              {pb.roles.map((r) => (
                <li key={r.role} className="type-body-small">
                  <b>{r.name}</b>
                  <span className={s.muted}>{r.description}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <details className={s.disclosure}>
          <summary className="type-body-small">What intake asks for</summary>
          <ul className={s.defs}>
            <li className="type-body-small">
              <b>Source</b>
              <span className={s.muted}>
                Source repository: {pb.intake.source.repo}; live site: {pb.intake.source.url}
              </span>
            </li>
            {pb.intake.steps.map((st) => (
              <li key={st.title} className="type-body-small">
                <b>{st.title}</b>
                {st.intro && <span className={s.muted}>{st.intro}</span>}
              </li>
            ))}
            <li className="type-body-small">
              <b>Brief</b>
              <span className={s.muted}>{count(pb.intake.brief.length, 'question')}</span>
            </li>
          </ul>
        </details>
      </div>

      <p className={`${s.panelFoot} type-meta`}>
        {ran.length
          ? `Projects on it: ${ran.map((p) => `${p.name} (${p.playbook?.version})`).join(', ')}.`
          : 'No projects on it yet.'}
        {kept.length > 0 &&
          ` Versions ${kept.join(' and ')} are kept: projects created on them run with their own team.`}
      </p>
    </Panel>
  );
}

/** How the projects run on a playbook went, side by side; shown once a real one has run on it. */
function Compare({ playbookId }: { playbookId: string }) {
  const { data, error } = useResource<PlaybookScorecard>(
    `/playbooks/${encodeURIComponent(playbookId)}/scorecard`,
    60_000,
    'How its projects went could not be loaded.',
  );
  if (error && !data)
    return (
      <div className={s.compare}>
        <Notice tone="bad">{error}</Notice>
      </div>
    );
  if (!data?.projects.length) return null;
  return (
    <div className={s.compare}>
      <h3 className={`${s.subhead} ${s.compareHead} type-label`}>How its projects went</h3>
      <PlaybookComparison data={data} />
    </div>
  );
}
