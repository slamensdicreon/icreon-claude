import type { EscalationType } from '@lw/contracts';
import { EYE_CID, EYE_PNG_BASE64 } from './operator-email-eye';
import type { OperatorNotice } from './operator';

/**
 * The Operator's notices as email, on the Cypher Design System: the wordmark on the shell's ink
 * header, a white card on the bliss ground, coral for what is the Director's, gold for what has
 * stalled, green for what is back. Set in Plus Jakarta Sans. Table layout with inline styles, so
 * Gmail and Outlook render it as Apple Mail does; the face loads from Google Fonts where the client
 * allows web fonts and falls back to Helvetica Neue elsewhere.
 */

/** Cypher's light-theme tokens (design-system/tokens.json), as literals: email has no CSS variables. */
const T = {
  shell: '#141433',
  onShell: '#ffffff',
  onShellQuiet: '#8f86c4',
  bliss: '#f6f5fc',
  surface: '#ffffff',
  mist: '#e3e0f2',
  mist2: '#eeedf7',
  ink: '#141433',
  text2: '#3b3a5c',
  text3: '#6a6889',
  coral: '#e8553d',
  coralText: '#c8402b',
  coralTint: '#fdf1ee',
  gold: '#9a6b00',
  goldTint: '#fdf8ec',
  green: '#1e8e5a',
  iris: '#6b4ee6',
  irisTint: '#eeeafd',
  font: "'Plus Jakarta Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const;

/** The chip and the band under the header: coral is the Director's, gold waits, green is done. */
const KIND: Record<OperatorNotice['kind'], { chip: string; fg: string; bg: string; band: string }> =
  {
    attention: { chip: 'Yours', fg: T.coralText, bg: T.coralTint, band: T.coral },
    stalled: { chip: 'Stalled', fg: T.gold, bg: T.goldTint, band: T.gold },
    review: { chip: 'To review', fg: T.coralText, bg: T.coralTint, band: T.coral },
    down: { chip: 'Worker down', fg: T.coralText, bg: T.coralTint, band: T.coral },
    up: { chip: 'Back up', fg: T.green, bg: T.mist2, band: T.green },
  };

const TYPE_LABEL: Record<EscalationType, string> = {
  decision: 'Decision',
  gate: 'Gate',
  access: 'Access',
  blocker: 'Blocker',
  budget: 'Budget',
  risk: 'Risk',
};

export interface OperatorEmail {
  subject: string;
  html: string;
  text: string;
  /** Images the HTML embeds by content id (the header's eye), sent as inline attachments. */
  inline: { filename: string; content: string; content_id: string }[];
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Where the email's button goes in the Control Center, and what it says. */
function action(n: OperatorNotice, appUrl: string): { href: string; label: string } {
  if (!n.projectId) return { href: `${appUrl}/`, label: 'Open the Dashboard' };
  const project = `${appUrl}/p/${encodeURIComponent(n.projectId)}`;
  if (n.kind === 'attention') return { href: `${project}/inbox`, label: 'Answer in Cypher' };
  if (n.kind === 'review') return { href: `${appUrl}/manage/rules`, label: 'Review proposals' };
  return { href: project, label: 'Open the project' };
}

/** The notice's own sentence, without the project name it opens with (the email shows it above). */
function lead(n: OperatorNotice, test: boolean): string {
  if (n.kind === 'attention' && !test) {
    const one = (n.needs?.length ?? 0) === 1;
    return `The Leads couldn't settle ${one ? 'this' : 'these'}; ${one ? 'its' : 'their'} work waits until you answer.`;
  }
  const prefix = `${n.project}: `;
  const body = n.body.startsWith(prefix) ? n.body.slice(prefix.length) : n.body;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/**
 * Subject, branded HTML and a plain-text part for one Operator notice. A test (the Director checking
 * that email reaches them) is marked as one and shows its body as written.
 */
export function operatorEmail(
  n: OperatorNotice,
  appUrl?: string | null,
  opts: { test?: boolean } = {},
): OperatorEmail {
  const test = Boolean(opts.test);
  const base = appUrl?.replace(/\/+$/, '') || null;
  const k = test ? { ...KIND[n.kind], chip: 'Test' } : KIND[n.kind];
  const go = base ? action(n, base) : null;
  const text = lead(n, test);
  const needs = n.needs ?? [];

  const faces = base
    ? "@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;600;700&display=swap');"
    : '';

  // The lockup as text beside the embedded eye: legible with images blocked, never a broken image.
  const brand = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="middle" style="padding:0 9px 0 0;line-height:0;"><img src="cid:${EYE_CID}" width="30" height="30" alt="" style="display:block;border:0;outline:none;width:30px;height:30px;"></td>
          <td valign="middle" style="font-family:${T.font};font-size:26px;line-height:30px;font-weight:800;letter-spacing:-0.04em;color:${T.onShell};mso-line-height-rule:exactly;">cypher</td>
        </tr></table>`;

  const cards = needs.length
    ? `<tr><td style="padding:8px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          ${needs
            .map(
              (c) => `<tr><td style="border-top:1px solid ${T.mist};padding:14px 0;">
                <div style="font-family:${T.font};font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${T.text3};">${esc(TYPE_LABEL[c.type] ?? c.type)}</div>
                <div style="font-family:${T.font};font-size:16px;line-height:24px;font-weight:600;color:${T.ink};padding-top:2px;">${esc(c.title)}</div>
              </td></tr>`,
            )
            .join('')}
          <tr><td style="border-top:1px solid ${T.mist};font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>`
    : '';

  const button = go
    ? `<tr><td style="padding:28px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="${T.ink}" style="background:${T.ink};border-radius:999px;">
            <a href="${esc(go.href)}" style="display:inline-block;padding:14px 26px;font-family:${T.font};font-size:15px;line-height:20px;font-weight:600;color:${T.onShell};text-decoration:none;border-radius:999px;">${esc(go.label)}&nbsp;&rarr;</a>
          </td>
        </tr></table>
      </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(n.title)}</title>
<style>${faces}@media (max-width:620px){.lw-card{width:100%!important}.lw-pad{padding-left:24px!important;padding-right:24px!important}}</style>
</head>
<body style="margin:0;padding:0;background:${T.bliss};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${T.bliss};">${esc(text)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bliss}" style="background:${T.bliss};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" class="lw-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${T.surface};border:1px solid ${T.mist};border-radius:24px;border-collapse:separate;overflow:hidden;">
    <tr><td class="lw-pad" bgcolor="${T.shell}" style="background:${T.shell};padding:22px 36px;border-radius:23px 23px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">${brand}</td>
        <td valign="middle" align="right" style="font-family:${T.font};font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${T.onShellQuiet};">Cypher&nbsp;&middot;&nbsp;Operator</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="${k.band}" style="background:${k.band};height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td class="lw-pad" style="padding:36px 36px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td>
          <span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${k.bg};font-family:${T.font};font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${k.fg};">${k.chip}</span>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-family:${T.font};font-size:14px;line-height:20px;font-weight:600;color:${T.text3};">${esc(n.project)}</td></tr>
        <tr><td style="padding:6px 0 0;font-family:${T.font};font-size:30px;line-height:36px;font-weight:700;letter-spacing:-0.02em;color:${T.ink};">${esc(n.title)}</td></tr>
        <tr><td style="padding:16px 0 ${needs.length ? '8px' : '0'};font-family:${T.font};font-size:17px;line-height:26px;font-weight:300;color:${T.text2};">${esc(text)}</td></tr>
        ${cards}
        ${button}
      </table>
    </td></tr>
    <tr><td class="lw-pad" bgcolor="${T.bliss}" style="background:${T.bliss};border-top:1px solid ${T.mist};padding:20px 36px;font-family:${T.font};font-size:13px;line-height:20px;color:${T.text3};border-radius:0 0 23px 23px;">
      I watch the running projects and write once per card or stall. Nothing is decided by email: answer in Cypher.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const plain = [
    `${n.project}: ${n.title}`,
    '',
    text,
    ...(needs.length
      ? ['', ...needs.map((c) => `- ${TYPE_LABEL[c.type] ?? c.type}: ${c.title}`)]
      : []),
    ...(go ? ['', `${go.label}: ${go.href}`] : []),
    '',
    '--',
    'Cypher, the Operator. I write once per card or stall; nothing is decided by email.',
  ].join('\n');

  return {
    subject: `${test ? '[Test] ' : ''}${n.project}: ${n.title}`,
    html,
    text: plain,
    inline: [{ filename: 'cypher-eye.png', content: EYE_PNG_BASE64, content_id: EYE_CID }],
  };
}

export interface ResendConfig {
  /** The Resend API key. */
  apiKey: string;
  to: string[];
  /** A sender on a domain verified in Resend. */
  from: string;
  /** The Control Center's public URL, for links and the wordmark. */
  appUrl?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Sends a notice through Resend. Throws with Resend's own reason (an unverified sender domain, a
 * recipient the test sender can't reach) so the caller can log why nothing arrived.
 */
export function resendNotifier(cfg: ResendConfig) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  return async (n: OperatorNotice, opts: { test?: boolean } = {}): Promise<{ id: string }> => {
    const mail = operatorEmail(n, cfg.appUrl, opts);
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: cfg.from,
        to: cfg.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        // The header's eye travels with the message (cid:cypher-eye).
        attachments: mail.inline,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok)
      throw new Error(
        `Resend refused the email (${res.status}): ${body.message ?? res.statusText}`,
      );
    return { id: body.id ?? '' };
  };
}

/** Recipients from a comma- or space-separated list. */
export const recipients = (list: string | undefined | null) =>
  (list ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+$/.test(s));
