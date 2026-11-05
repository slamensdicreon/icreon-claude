import { z } from 'zod';
import {
  ActivityItem,
  AgentView,
  LeadRow,
  PortfolioProject,
  ScorecardCategory,
  ScorecardTotals,
} from './snapshots';
import { DecisionCategory, ProjectStatus } from './enums';
import { Voice } from './voice';

/*
 * The portfolio's own sections (design system §8: Dashboard, Needs you, Projects, Team, Workbench,
 * Activity, Scorecard), each the project page's data across every project, with Cypher's line on top.
 */

/** A project as a portfolio page names it: who it is and its team color. */
export const PortfolioRef = PortfolioProject.pick({
  projectId: true,
  name: true,
  initials: true,
  hue: true,
  archived: true,
  demo: true,
});
export type PortfolioRef = z.infer<typeof PortfolioRef>;

/** GET /portfolio/team — every project's people: the Leads in Cypher's words, and everyone. */
export const PortfolioTeam = z.object({
  at: z.iso.datetime(),
  voice: Voice,
  /** Agents working now, across every live project. */
  working: z.number().int(),
  /** Agents blocked or waiting, across every live project. */
  stuck: z.number().int(),
  projects: z.array(
    PortfolioRef.extend({
      leads: z.array(LeadRow),
      agents: z.array(AgentView),
    }),
  ),
});
export type PortfolioTeam = z.infer<typeof PortfolioTeam>;

export const PortfolioActivityItem = ActivityItem.extend({
  projectId: z.string(),
  project: z.string(),
  initials: z.string(),
  /** Who acted, in words: the agent's name, "Cypher", "You" or "Tool server". */
  who: z.string(),
});
export type PortfolioActivityItem = z.infer<typeof PortfolioActivityItem>;

export const PortfolioActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(100),
  severity: z.string().optional(),
  project: z.string().optional(),
});
export type PortfolioActivityQuery = z.infer<typeof PortfolioActivityQuery>;

/** GET /portfolio/activity — the newest log rows across every project, merged by time. */
export const PortfolioActivity = z.object({
  at: z.iso.datetime(),
  voice: Voice,
  /** In the last hour, across every project. */
  lastHour: z.object({ steps: z.number().int(), failures: z.number().int() }),
  items: z.array(PortfolioActivityItem),
});
export type PortfolioActivity = z.infer<typeof PortfolioActivity>;

export const PortfolioDocument = z.object({
  projectId: z.string(),
  project: z.string(),
  initials: z.string(),
  hue: PortfolioProject.shape.hue,
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  latest: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  /** The newest version a Director gate approved. */
  approved: z
    .object({ version: z.number().int(), at: z.iso.datetime(), gate: z.string() })
    .nullable(),
});
export type PortfolioDocument = z.infer<typeof PortfolioDocument>;

/** GET /portfolio/workbench — every project's documents, newest first. */
export const PortfolioWorkbench = z.object({
  at: z.iso.datetime(),
  voice: Voice,
  documents: z.array(PortfolioDocument),
});
export type PortfolioWorkbench = z.infer<typeof PortfolioWorkbench>;

/** GET /portfolio/scorecard — how the work went, every project together and side by side. */
export const PortfolioScorecard = z.object({
  at: z.iso.datetime(),
  voice: Voice,
  totals: ScorecardTotals,
  projects: z.array(PortfolioRef.extend({ status: ProjectStatus, totals: ScorecardTotals })),
  categories: z.array(ScorecardCategory),
  repeats: z.array(
    z.object({
      projectId: z.string(),
      project: z.string(),
      category: DecisionCategory,
      title: z.string(),
      count: z.number().int(),
    }),
  ),
});
export type PortfolioScorecard = z.infer<typeof PortfolioScorecard>;
