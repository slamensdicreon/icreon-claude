import { describe, expect, it } from 'vitest';
import { hostAllowed } from '../src';

describe('hostAllowed', () => {
  const policy = {
    allowedHosts: ['anscollc.com', 'dycom-ansco-associates-s*.vercel.app'],
  };
  it("matches exact hosts and the project's provider addresses, nothing else", () => {
    expect(hostAllowed('anscollc.com', policy)).toBe(true);
    expect(hostAllowed('ANSCOLLC.com', policy)).toBe(true);
    for (const h of [
      'dycom-ansco-associates-sitecoreai-v.vercel.app',
      'dycom-ansco-associates-sitecoreai-v2-editing.vercel.app',
      'dycom-ansco-associates-sitecoreai-v2-stevetestings-projects.vercel.app',
    ])
      expect(hostAllowed(h, policy)).toBe(true);
    for (const h of [
      'evil.com',
      'dycom-ansco-associates-s.vercel.app.evil.com',
      'x.dycom-ansco-associates-sitecoreai.vercel.app',
      'dycom-ansco-associates-s.evil.vercel.app',
      'other-project.vercel.app',
    ])
      expect(hostAllowed(h, policy)).toBe(false);
    // A wildcard needs a real prefix.
    expect(hostAllowed('anything.vercel.app', { allowedHosts: ['a*.vercel.app'] })).toBe(false);
  });
});
