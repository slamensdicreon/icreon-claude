import type {
  ArtifactDocument,
  Budgets,
  EscalationType,
  MetricKey,
  ProjectSource,
  ProjectTarget,
  PullRequestDocument,
  StatCard,
  TaskContract,
  TaskState,
  Workstream,
} from '@lw/contracts';
import type { DemoProject } from './engine';

/** A moment in scenario time: [working day index, local hour]. */
export type When = [day: number, hour: number];

/** A jump target in scenario shorthand: "wb:blueprint", "plan", "inspect:solution-architect". */
export type Jump = string;

export interface DemoTask {
  id: string;
  agent: string;
  phase: number;
  title: string;
  /** Engagement-view row. */
  group?: string;
  workstream?: Workstream | null;
  start: When;
  end: When;
  state: TaskState;
  deps?: string[];
  itemKeys?: string[];
  estimateHours?: number;
  contract?: TaskContract;
}

/** A row in Activity (and, for the agent's own calls, its inspector). */
export interface DemoCall {
  at: When;
  /** Agent role id, "director", or "tool-server". */
  agent: string;
  /** Display tool name as the prototype shows it ("Authoring API", "Review", "Planner"). */
  tool: string;
  op: string;
  code: string;
  ms?: string;
  tok?: string;
  sev?: '' | 'warn' | 'bad';
  note?: string;
}

export interface DemoMessage {
  at: When;
  /** "Discovery summary: ansell-main" → a brief with that label and title. */
  brief?: string;
  lines?: string[];
  text?: string;
  note?: string;
  links?: [label: string, jump: Jump][];
}

export interface DemoDecision {
  ref: string;
  q: string;
  a: string;
  by: 'Director' | 'Cypher (convention)';
  at: When;
  scopeKey?: string;
}

export interface BlueprintRowDef {
  src: string;
  target: string;
  key?: string;
  fields: string;
  params: string;
  ph: string;
  variants: string;
  /** Prototype status; build status is derived from tasks, but drop and merge are item states. */
  status: 'registered' | 'in progress' | 'planned' | 'dropped' | 'merged';
  pilot?: boolean;
  was?: string;
}

export interface DemoArtifact {
  id: string;
  kind: 'platform_notes' | 'inventory' | 'report' | 'pull_request' | 'handover_pack';
  title: string;
  short: string;
  producer: string;
  at: When;
  doc: ArtifactDocument | PullRequestDocument;
}

export interface DemoPage {
  key: string;
  name: string;
  path: string;
  template?: string;
  layout?: string;
  pilot?: boolean;
  migrated?: boolean;
  parity?: number;
  visual?: number;
}

export interface DemoEscalation {
  id: string;
  type: EscalationType;
  typeLabel?: string;
  title: string;
  context: string;
  impact: string;
  options?: { label: string; rec?: boolean }[];
  defaultIdx?: number;
  /** Real minutes before the default applies (divided by the simulation speed). */
  deadlineMinutes?: number;
  evidence?: { label: string; go: Jump }[];
  reversible?: boolean;
  waitNote?: string;
  /** What the Lead made of it before it reached the Director (Lead triage). */
  lead?: {
    leadId: string;
    mode: 'shadow' | 'forwarded';
    optionIdx: number | null;
    reasoning: string;
  };
  gate?: { phase: number; artifactId: string; version: number };
  onResolve?: (p: DemoProject, option: number, by: 'director' | 'default') => Promise<void>;
  onUndo?: (p: DemoProject) => Promise<void>;
  onApprove?: (p: DemoProject) => Promise<void>;
  onSendBack?: (p: DemoProject, notes: string) => Promise<void>;
}

export interface DemoScenarioDef {
  key: string;
  label: string;
  run: (p: DemoProject) => Promise<void>;
}

export interface DemoScenario {
  id: string;
  name: string;
  client: string;
  initials: string;
  subtitle: string;
  timezone: string;
  /** Folder of images under the simulator's fixtures. */
  fixtures: string;
  source: ProjectSource;
  target: ProjectTarget;
  budgets: Budgets;
  spent: { usd: number; tokens: number };
  started: When;
  present: When;
  phases: { number: number; entered: When; exited?: When }[];
  stats: StatCard[];
  metrics: Partial<Record<MetricKey, [value: number | null, total: number | null]>>;
  agents: Record<
    string,
    { state?: string; now?: string; task?: string; note?: string; tokens?: number }
  >;
  tasks: DemoTask[];
  calls: DemoCall[];
  messages: DemoMessage[];
  decisions: DemoDecision[];
  blueprint: {
    v1: BlueprintRowDef[];
    /** Rows of the current version when it differs from v1. */
    v2?: BlueprintRowDef[];
    producedAt: When;
    gateRaisedAt?: When;
    approvedAt?: When;
    v2At?: When;
  };
  artifacts: DemoArtifact[];
  pages: DemoPage[];
  preview: { source: string; target: string; targetDeployment?: string };
  credentials: { sys: string; scope: string; verified: When | null; expiresDays?: number }[];
  conventions: [string, string][];
  settings: { pilotReview: boolean; publishReview: boolean };
  live: {
    nowLines: Record<string, string[]>;
    ops: [agent: string, tool: string, op: string, code: string, ms: string, tok: string][];
  };
  escalations: Record<string, () => DemoEscalation>;
  scenarios: DemoScenarioDef[];
  /** Escalations already open when the demo starts: [id, minutes ago]. */
  open: [string, number][];
  /** Scenarios that run on their own, [seconds after start, key]. */
  auto: [number, string][];
}
