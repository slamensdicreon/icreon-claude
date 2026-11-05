/*
 * What the admin pages share: a resource that loads (and, for some, polls) with a way to refetch
 * it now, the loading and failure lines, a group of entries that can fold, and names for the
 * platforms, playbooks and roles the catalog declares.
 */
import type { PlaybookSummary, PortfolioItem } from '@lw/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { get, messageOf } from '../../lib/api';
import { Icon } from '../../theme/icons';
import { Notice } from '../intake/shared';
import s from './manage.module.css';

/**
 * GET a JSON resource while the page is open, every `everyMs` when given. `reload` refetches now,
 * so a page sees its own change without waiting for the next poll.
 */
export function useResource<T>(path: string | null, everyMs: number | null, fallback: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    return get<T>(path)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        if (alive.current) setError(messageOf(err, fallback));
      });
  }, [path, fallback]);
  useEffect(() => {
    alive.current = true;
    void load();
    const t = everyMs ? window.setInterval(() => void load(), everyMs) : null;
    return () => {
      alive.current = false;
      if (t) window.clearInterval(t);
    };
  }, [load, everyMs]);
  return { data, error, reload: load };
}

/** Every project and where it stands; the pages that name projects poll it as the old ones did. */
export const usePortfolio = (on: boolean) =>
  useResource<PortfolioItem[]>(on ? '/portfolio' : null, 10_000, 'Projects could not be loaded.')
    .data ?? [];

/** The loading line, or the failure in the API's words, before a page has its data. */
export function Pending({ error, loading }: { error: string | null; loading: string }) {
  return error ? (
    <Notice tone="bad">{error}</Notice>
  ) : (
    <p className={`${s.quiet} type-body-small`}>{loading}</p>
  );
}

/** The plain sentence that says what a page or panel is for. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className={`${s.lead} type-body-small`}>{children}</p>;
}

/**
 * A panel that folds: the retired entries, kept for the record and closed by default. It reads
 * as a Panel; its header is the summary.
 */
export function FoldPanel({
  title,
  meta,
  children,
}: {
  title: string;
  meta: string;
  children: ReactNode;
}) {
  return (
    <details className={s.fold}>
      <summary className={s.foldHead}>
        <span className="type-section">{title}</span>
        <span className={`${s.foldMeta} type-meta`}>{meta}</span>
        <Icon name="chevron" size={20} className={s.foldChev} />
      </summary>
      {children}
    </details>
  );
}

/** "1 rule", "4 rules". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Names from the playbook catalog: a platform's ("SitecoreAI"), a playbook's and a role's. An id
 * the catalog doesn't know reads as itself.
 */
export function catalogNames(playbooks: PlaybookSummary[] | null) {
  const platforms = new Map<string, string>();
  const books = new Map<string, string>();
  const roles = new Map<string, string>();
  for (const pb of playbooks ?? []) {
    if (!platforms.has(pb.platform.id)) platforms.set(pb.platform.id, pb.platform.name);
    books.set(pb.id, pb.name);
    for (const r of pb.roles) if (!roles.has(r.role)) roles.set(r.role, r.name);
  }
  return {
    platforms,
    platform: (id: string) => platforms.get(id) ?? id,
    playbook: (id: string) => books.get(id) ?? id,
    role: (id: string) => roles.get(id) ?? id,
  };
}
export type CatalogNames = ReturnType<typeof catalogNames>;
