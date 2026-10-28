import { describe, expect, it } from 'vitest';
import { projectHosts } from '../src/compose';

describe('projectHosts', () => {
  it("lists the new site's production, editing and provider addresses", () => {
    expect(
      projectHosts({
        project: 'dycom-ansco-associates-sitecoreai-v2',
        url: 'https://dycom-ansco-associates-sitecoreai-v.vercel.app',
      }),
    ).toEqual([
      'dycom-ansco-associates-sitecoreai-v.vercel.app',
      'dycom-ansco-associates-sitecoreai-v2-editing.vercel.app',
      'dycom-ansco-associates-s*.vercel.app',
    ]);
    expect(projectHosts(null)).toEqual([]);
  });
});
