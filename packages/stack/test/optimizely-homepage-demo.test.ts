import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
import { loadPlaybook, loadRolePrompts } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const DEMO = dir('optimizely-homepage-demo');
const PLATFORM_KNOWLEDGE = fileURLToPath(
  new URL('../../../platforms/optimizely/knowledge', import.meta.url),
);

describe('optimizely-homepage-demo playbook', () => {
  it('loads, with the Blueprint gate and the Visual Builder gate', async () => {
    const pb = await loadPlaybook(DEMO);
    expect(pb.manifest).toMatchObject({ platform: 'optimizely', version: '0.1.2' });
    expect(pb.manifest.phases).toHaveLength(10);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 9,
    ]);
    expect(pb.manifest.charter.outcomes.map((o) => o.id)).toEqual([
      'compose-and-edit',
      'shared-chrome',
      'homepage-parity',
      'deployed',
      'real-audit',
    ]);
    // The slice is the pilot: no pilot block, no canaries on one page's worth of items.
    expect(pb.plan.pilot).toBeUndefined();
    for (const t of pb.plan.templates.filter((t) => t.forEach)) expect(t.canary).toBe(0);
    expect(pb.plan.templates.find((t) => t.id === 'draft-blueprint')?.acceptance).toContain(
      'validator:blueprint.demo-slice',
    );
    // Always our demo instance and the demo's own application: every release is approved once,
    // in the playbook. The Director's cards are the two gates and the two steps by hand.
    for (const t of pb.plan.templates.filter((t) => t.release))
      expect(t.release?.standing, t.id).toBe(true);
    // The API key's content rights are confirmed before Gate 1, unless the key's earlier
    // content proves them (the platform reads that as the project starts).
    expect(pb.plan.templates.find((t) => t.id === 'confirm-content-rights')).toMatchObject({
      phase: 0,
      unless: 'content-rights-proven',
      manual: expect.stringContaining('Set Access Rights'),
    });
    expect(pb.plan.templates.find((t) => t.id === 'visual-builder-check')).toMatchObject({
      phase: 9,
      dependsOn: ['demo-summary'],
      manual: expect.stringContaining('add a section'),
    });
  });

  it('plans exactly the slice of the example Blueprint, in the order the platform sets', async () => {
    const pb = await loadPlaybook(DEMO);
    const { blueprint } = await loadFixtures(DEMO);
    const plan = compilePlan(pb, blueprint, { skipMerged: true });
    const keys = (prefix: string) =>
      plan.tasks
        .filter((t) => t.taskId.startsWith(prefix))
        .map((t) => t.taskId.slice(prefix.length));
    expect(keys('port-')).toEqual([
      'site-header',
      'main-navigation',
      'site-footer',
      'announcement-banner',
      'hero-with-tabs',
      'promo-card-carousel',
      'quick-links',
      'featured-banner',
      'feature-card-grid',
      'horizontal-card',
      'social-follow',
    ]);
    expect(keys('define-type-')).toEqual(['experience']);
    expect(keys('migrate-pages-')).toEqual(['home']);
    expect(keys('upload-media-')).toEqual([
      'logo-header',
      'hero-background',
      'promo-card-1',
      'feature-card-1',
      'social-icon-1',
    ]);
    expect(plan.tasks.map((t) => t.taskId)).not.toContain('pilot-checkpoint');
    expect(plan.tasks.at(-1)?.taskId).toBe('visual-builder-check');
    const task = (id: string) => plan.tasks.find((t) => t.taskId === id)!;
    // The experience type references the shared blocks' types: it waits on those alone.
    expect(task('push-type-experience').dependsOn.sort()).toEqual([
      'define-type-experience',
      'integrate-head',
      'integrate-main-navigation',
      'integrate-site-footer',
      'integrate-site-header',
    ]);
    // An application can't exist without its start page, of the type just pushed.
    expect(task('approve-provision-application').dependsOn).toEqual(['push-type-experience']);
    expect(task('approve-migrate-shared-chrome').dependsOn).toEqual(['provision-application']);
    expect(task('approve-migrate-pages-home').dependsOn).toEqual(['migrate-shared-chrome']);
  });

  it('passes its own Blueprint check', async () => {
    const { blueprint } = await loadFixtures(DEMO);
    const result = await CHECKS['blueprint.demo-slice']!({
      projectId: 'p1',
      state: { playbook: { id: 'optimizely-homepage-demo', version: '0.1.2' } },
      library: {
        read: async (_p: string, id: string) =>
          id === 'blueprint' ? { content: JSON.stringify(blueprint) } : null,
      },
    } as never);
    expect(result).toMatchObject({
      status: 'pass',
      detail: 'The demo builds 1 page, 1 template, 11 components and 5 media.',
    });
  });

  it('grants every tool a role prompt tells the agent to use, and finds its knowledge', async () => {
    const pb = await loadPlaybook(DEMO);
    const prompts = await loadRolePrompts(DEMO, pb, [PLATFORM_KNOWLEDGE]);
    expect(prompts['handover-writer']).toContain('`demo-summary`');
    expect(prompts['handover-writer']).toContain('Definition of Done (homepage demo)');
    const servers = new Set(pb.roles.flatMap((r) => Object.keys(r.tools)));
    const missing: string[] = [];
    for (const role of pb.roles) {
      let prompt: string;
      try {
        prompt = await readFile(join(DEMO, 'prompts', `${role.role}.md`), 'utf8');
      } catch {
        continue;
      }
      for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
        if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
          missing.push(`${role.role}: ${server}.${op}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names no other platform', async () => {
    const found: string[] = [];
    for (const folder of ['.', 'roles', 'prompts', 'knowledge', 'fixtures'])
      for (const f of await readdir(join(DEMO, folder), { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const text = await readFile(join(DEMO, folder, f.name), 'utf8');
        const m = /sitecore|page builder|experience edge|partial design|datasource/i.exec(text);
        if (m) found.push(`${folder}/${f.name}: ${m[0]}`);
      }
    expect(found).toEqual([]);
  });
});
