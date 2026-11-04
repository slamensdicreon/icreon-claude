import type { EscalationType } from '@lw/contracts';
import type { OperatorNotice } from './operator';

/**
 * The Operator's notices as email, on the Icreon Design System: Hero New, Icreon black and blue
 * on the neutral ramp, the Icreon lockup in a black header. Table layout with inline styles, so
 * Gmail and Outlook render it as Apple Mail does; Hero New loads where the client allows web
 * fonts and falls back to Helvetica Neue elsewhere.
 */

/** Icreon Design System tokens (apps/web/src/styles/prototype.css, brand core). */
const T = {
  black: '#000000',
  white: '#ffffff',
  blue: '#386aff',
  blueDeep: '#2752e0',
  blueTint: '#e7ecff',
  n950: '#0a0a0a',
  n700: '#474747',
  n500: '#7a7a7a',
  n400: '#a3a3a3',
  n200: '#e6e6e6',
  n50: '#f8f8f7',
  warning: '#b26a00',
  warningBg: '#fbf0dd',
  danger: '#c8372d',
  dangerBg: '#fbe9e7',
  success: '#1e8e5a',
  successBg: '#e7f5ee',
  font: "'Hero New', 'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const;

const KIND: Record<OperatorNotice['kind'], { chip: string; fg: string; bg: string }> = {
  attention: { chip: 'Needs you', fg: T.blueDeep, bg: T.blueTint },
  stalled: { chip: 'Stalled', fg: T.warning, bg: T.warningBg },
  review: { chip: 'To review', fg: T.blueDeep, bg: T.blueTint },
  down: { chip: 'Worker down', fg: T.danger, bg: T.dangerBg },
  up: { chip: 'Back up', fg: T.success, bg: T.successBg },
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
  if (n.kind === 'attention') return { href: `${project}/inbox`, label: 'Answer in Launchworks' };
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
    ? (
        [
          ['Light', 300],
          ['Regular', 400],
          ['Medium', 500],
        ] as const
      )
        .map(
          ([file, weight]) =>
            `@font-face{font-family:'Hero New';src:url('${base}/fonts/HeroNew-${file}.otf') format('opentype');font-weight:${weight};font-style:normal;}`,
        )
        .join('')
    : '';

  const brand = base
    ? `<img src="${esc(base)}/email/icreon-lockup.png" width="104" height="22" alt="Icreon" style="display:block;border:0;outline:none;width:104px;height:22px;">`
    : `<span style="font-family:${T.font};font-size:18px;font-weight:500;letter-spacing:0.12em;color:${T.white};">ICREON</span>`;

  const cards = needs.length
    ? `<tr><td style="padding:8px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          ${needs
            .map(
              (c) => `<tr><td style="border-top:1px solid ${T.n200};padding:14px 0;">
                <div style="font-family:${T.font};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${T.n500};">${esc(TYPE_LABEL[c.type] ?? c.type)}</div>
                <div style="font-family:${T.font};font-size:15px;line-height:22px;font-weight:400;color:${T.n950};padding-top:2px;">${esc(c.title)}</div>
              </td></tr>`,
            )
            .join('')}
          <tr><td style="border-top:1px solid ${T.n200};font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>`
    : '';

  const button = go
    ? `<tr><td style="padding:28px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="${T.blue}" style="background:${T.blue};border-radius:4px;">
            <a href="${esc(go.href)}" style="display:inline-block;padding:13px 22px;font-family:${T.font};font-size:14px;line-height:20px;font-weight:500;color:${T.white};text-decoration:none;border-radius:4px;">${esc(go.label)}&nbsp;&rarr;</a>
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
<body style="margin:0;padding:0;background:${T.n50};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${T.n50};">${esc(text)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.n50}" style="background:${T.n50};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" class="lw-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${T.white};border:1px solid ${T.n200};border-collapse:separate;">
    <tr><td class="lw-pad" bgcolor="${T.black}" style="background:${T.black};padding:22px 36px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">${brand}</td>
        <td valign="middle" align="right" style="font-family:${T.font};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${T.n400};">Launchworks&nbsp;&middot;&nbsp;Operator</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="${k.fg}" style="background:${k.fg};height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td class="lw-pad" style="padding:36px 36px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td>
          <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${k.bg};font-family:${T.font};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${k.fg};">${k.chip}</span>
        </td></tr>
        <tr><td style="padding:20px 0 0;font-family:${T.font};font-size:13px;line-height:18px;font-weight:500;color:${T.n500};">${esc(n.project)}</td></tr>
        <tr><td style="padding:6px 0 0;font-family:${T.font};font-size:30px;line-height:36px;font-weight:300;letter-spacing:-0.01em;color:${T.black};">${esc(n.title)}</td></tr>
        <tr><td style="padding:16px 0 ${needs.length ? '8px' : '0'};font-family:${T.font};font-size:15px;line-height:24px;font-weight:400;color:${T.n700};">${esc(text)}</td></tr>
        ${cards}
        ${button}
      </table>
    </td></tr>
    <tr><td class="lw-pad" bgcolor="${T.n50}" style="background:${T.n50};border-top:1px solid ${T.n200};padding:20px 36px;font-family:${T.font};font-size:12px;line-height:18px;color:${T.n500};">
      The Operator watches running projects in Launchworks and writes once per card or stall. Nothing is decided by email: answer in Launchworks.
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
    'Launchworks Operator. It writes once per card or stall; nothing is decided by email.',
  ].join('\n');

  return { subject: `${test ? '[Test] ' : ''}${n.project}: ${n.title}`, html, text: plain };
}

export interface ResendConfig {
  /** The Resend API key. */
  apiKey: string;
  to: string[];
  /** A sender on a domain verified in Resend. */
  from: string;
  /** The Control Center's public URL, for links, the lockup and Hero New. */
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
