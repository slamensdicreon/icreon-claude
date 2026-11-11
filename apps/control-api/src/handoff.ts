import { randomBytes } from 'node:crypto';
import type { IntakeCredentialSpec } from '@lw/contracts';
import { CommandError, type ProjectState } from '@lw/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { signValue, verifyValue } from './auth';
import type { IntakeService } from './intake';
import { escapeHtml, htmlPage } from './pages';

/** How long a hand-off link works. */
export const HANDOFF_DAYS = 7;

export interface HandoffDeps {
  /** Signs the links. Without sign-in (a local run) a key for this process only. */
  secret?: string;
  /** The API's public address, for the link; otherwise the request's own. */
  publicUrl?: string;
  intake?: IntakeService;
  project: (id: string) => ProjectState | null;
  catchUp: (id: string) => Promise<void>;
  now: () => number;
}

interface Ticket {
  /** Project, credential, issued at, expires at (ms). */
  p: string;
  c: string;
  iat: number;
  exp: number;
}

/**
 * A credential handed to the client's own administrator: a marketer often can't create the
 * platform's credentials, so the Director sends a link instead. Whoever has the link can enter
 * that one credential for that one project, once, for 7 days; it is checked against the live
 * service and sealed exactly as if the Director had entered it, and nobody sees it afterwards.
 */
export function registerHandoff(app: FastifyInstance, deps: HandoffDeps): void {
  const secret = `handoff:${deps.secret ?? randomBytes(32).toString('hex')}`;
  const specOf = (s: ProjectState, credentialId: string): IntakeCredentialSpec | undefined =>
    deps.intake
      ?.playbooks()
      .find((p) => p.id === s.playbook?.id)
      ?.intake.steps.flatMap((st) => st.credentials)
      .find((c) => c.credentialId === credentialId);

  // HTML forms post urlencoded; nothing else in the API does.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded'))
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16_384 },
      (_req, body, done) =>
        done(null, Object.fromEntries(new URLSearchParams(String(body)).entries())),
    );

  app.post<{ Params: { id: string; credentialId: string } }>(
    '/projects/:id/credentials/:credentialId/handoff',
    async (req) => {
      const s = deps.project(req.params.id);
      if (!s) throw new CommandError(404, 'unknown_project', `No project "${req.params.id}".`);
      if (s.mode !== 'live' || !s.intake)
        throw new CommandError(409, 'not_live', 'Only real projects keep credentials.');
      if (!specOf(s, req.params.credentialId))
        throw new CommandError(
          404,
          'unknown_credential',
          'This playbook takes no such credential.',
        );
      const now = deps.now();
      const ticket: Ticket = {
        p: s.projectId,
        c: req.params.credentialId,
        iat: now,
        exp: now + HANDOFF_DAYS * 86_400_000,
      };
      const token = signValue(JSON.stringify(ticket), secret);
      return {
        url: `${base(req)}/handoff/${encodeURIComponent(token)}`,
        expiresAt: new Date(ticket.exp).toISOString(),
      };
    },
  );

  const base = (req: FastifyRequest) =>
    deps.publicUrl ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`;

  /** The ticket's project and credential, or why the link no longer works. */
  const open = async (token: string) => {
    const raw = verifyValue(token, secret);
    let t: Ticket | null = null;
    try {
      t = raw ? (JSON.parse(raw) as Ticket) : null;
    } catch {
      t = null;
    }
    if (!t) return { problem: 'This link is not valid. Ask for a new one.' } as const;
    if (t.exp < deps.now())
      return { problem: 'This link has expired. Ask for a new one.' } as const;
    await deps.catchUp(t.p);
    const s = deps.project(t.p);
    const spec = s ? specOf(s, t.c) : undefined;
    if (!s || !spec) return { problem: 'This project no longer needs it.' } as const;
    const saved = s.credentials[t.c]?.verifiedAt;
    if (saved && Date.parse(saved) > t.iat)
      return { problem: `${spec.system} is already saved for ${s.name}. Thank you.` } as const;
    return { s, spec } as const;
  };

  const form = (s: ProjectState, spec: IntakeCredentialSpec, token: string, problem?: string) => `
<h1>${escapeHtml(spec.system)} for ${escapeHtml(s.name)}</h1>
<p class="muted">${escapeHtml(s.client)}'s team on Launchworks needs this to build the site. It is
checked against ${escapeHtml(spec.system)} the moment you save it, then sealed: nobody, at Icreon or
elsewhere, sees it again.</p>
${spec.description ? `<p class="muted">${escapeHtml(spec.description)}</p>` : ''}
${problem ? `<p class="bad">${escapeHtml(problem)}</p>` : ''}
<form method="post" action="/handoff/${encodeURIComponent(token)}" autocomplete="off">
${spec.fields
  .map(
    (f) =>
      `<label for="f-${escapeHtml(f.key)}">${escapeHtml(f.label)}</label><input id="f-${escapeHtml(f.key)}" name="${escapeHtml(f.key)}" type="${f.secret ? 'password' : 'text'}" required maxlength="4000">`,
  )
  .join('\n')}
<button type="submit">Check and save</button>
</form>`;

  app.get<{ Params: { token: string } }>('/handoff/:token', async (req, reply) => {
    const o = await open(req.params.token);
    if ('problem' in o) return htmlPage(reply, 410, 'Link', `<p>${escapeHtml(o.problem!)}</p>`);
    return htmlPage(reply, 200, o.spec.system, form(o.s, o.spec, req.params.token));
  });

  app.post<{ Params: { token: string } }>('/handoff/:token', async (req, reply) => {
    const o = await open(req.params.token);
    if ('problem' in o) return htmlPage(reply, 410, 'Link', `<p>${escapeHtml(o.problem!)}</p>`);
    if (!deps.intake) return htmlPage(reply, 501, 'Link', '<p>Not available here.</p>');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const values = Object.fromEntries(
      o.spec.fields.map((f) => [
        f.key,
        typeof body[f.key] === 'string' ? (body[f.key] as string).trim() : '',
      ]),
    );
    try {
      await deps.intake.setCredential(o.s, o.spec.credentialId, values);
    } catch (err) {
      const message =
        err instanceof CommandError ? err.message : 'It could not be checked. Try again.';
      return htmlPage(reply, 422, o.spec.system, form(o.s, o.spec, req.params.token, message));
    }
    return htmlPage(
      reply,
      200,
      'Saved',
      `<h1>Saved. Thank you.</h1><p>${escapeHtml(o.spec.system)} works and is sealed for ${escapeHtml(o.s.name)}. You can close this page.</p>`,
    );
  });
}
