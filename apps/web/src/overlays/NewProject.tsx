import { useState } from 'react';
import { ApiProblem, API } from '../lib/api';
import { useApp } from '../state';
import { Scrim } from './Dialogs';

/**
 * Intake: the form behind "New project". The prototype starts from projects that already exist;
 * this is how they come to exist. Credentials are registered by reference afterwards and
 * verified in phase 0, so none are asked for here.
 */
export function NewProject() {
  const { closeOverlay, switchProject, toast } = useApp();
  const [f, setF] = useState({ name: '', client: '', sourceUrl: '', repo: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });
  const urlOk = !f.sourceUrl || /^https?:\/\/[^\s]+\.[^\s]+/.test(f.sourceUrl);
  const repoOk = !f.repo || /^[\w.-]+\/[\w.-]+$/.test(f.repo.trim());
  const ok = f.name.trim() && f.client.trim() && urlOk && repoOk && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/projects`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: f.name.trim(),
          client: f.client.trim(),
          ...(f.sourceUrl ? { sourceUrl: f.sourceUrl.trim() } : {}),
          ...(f.repo ? { repo: f.repo.trim() } : {}),
        }),
      });
      const body = (await res.json()) as { projectId?: string; error?: { message: string } };
      if (!res.ok || !body.projectId)
        throw new ApiProblem(res.status, 'intake', body.error?.message ?? 'Intake failed.');
      closeOverlay();
      toast(`${f.name.trim()} created. Cypher starts with intake and access checks.`);
      // The project list refreshes within seconds; switch as soon as it is there.
      window.setTimeout(() => switchProject(body.projectId!), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Intake failed.');
      setBusy(false);
    }
  };

  const field = (label: string, k: keyof typeof f, placeholder: string, hint?: string) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="eyebrow" style={{ display: 'block', marginBottom: 6 }}>
        {label}
      </span>
      <input
        className="input"
        style={{ width: '100%' }}
        value={f[k]}
        placeholder={placeholder}
        onChange={set(k)}
      />
      {hint && (
        <span className="muted" style={{ fontSize: 12.5, display: 'block', marginTop: 4 }}>
          {hint}
        </span>
      )}
    </label>
  );

  return (
    <Scrim>
      <form
        className="dialog"
        role="dialog"
        aria-labelledby="np-t"
        onSubmit={submit}
        style={{ width: 520 }}
      >
        <h2 id="np-t">New project</h2>
        <p>
          Cypher runs intake and access checks first, then discovery. You see the Blueprint at Gate
          1 before anything is created on the tenant.
        </p>
        {field('Project name', 'name', 'Acme corporate site')}
        {field('Client', 'client', 'Acme Corp')}
        {field(
          'Live source site',
          'sourceUrl',
          'https://www.acme.com',
          'Optional. The crawler reaches this host only.',
        )}
        {field(
          'Source repository',
          'repo',
          'org/repo',
          'Optional. Connected through the GitHub App after intake.',
        )}
        {!urlOk && (
          <p style={{ color: 'var(--danger)', marginTop: -6 }}>
            The source site must be an http or https address.
          </p>
        )}
        {!repoOk && (
          <p style={{ color: 'var(--danger)', marginTop: -6 }}>
            Write the repository as owner/name.
          </p>
        )}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={closeOverlay}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!ok}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </form>
    </Scrim>
  );
}
