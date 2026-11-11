import type { FastifyReply } from 'fastify';

export const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;
min-height:100vh;background:#f6f5f2;color:#1d1c1a}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem}
a.b,button{display:block;width:100%;box-sizing:border-box;margin:.75rem 0;padding:.75rem 1rem;border:0;
border-radius:999px;background:#1d1c1a;color:#fff;font:inherit;text-align:center;text-decoration:none;cursor:pointer}
a.b.s{background:transparent;color:inherit;border:1px solid #c9c7c1}
label{display:block;margin:1rem 0 .25rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.6rem .75rem;
border:1px solid #c9c7c1;border-radius:.5rem;font:inherit;background:#fff;color:inherit}
.muted{color:#6b6963;font-size:.9rem}.bad{color:#b3261e}
@media (prefers-color-scheme:dark){body{background:#161614;color:#ecebe7}a.b,button{background:#ecebe7;color:#161614}
a.b.s{background:transparent;color:inherit;border-color:#4a4945}input{background:#1f1f1d;border-color:#4a4945}
.muted{color:#a5a39d}.bad{color:#f2b8b5}}`;

/**
 * A small page of the API's own (sign-in, a credential hand-off): its inline style allowed and
 * forms posting back to the API, nothing else.
 */
export function htmlPage(reply: FastifyReply, status: number, title: string, inner: string) {
  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'",
    )
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Launchworks</title><style>${STYLE}</style></head><body><main>${inner}</main></body></html>`,
    );
}
