# Cypher: design system handoff and refactor plan

Nov 4, 2026 · @Steven Lamesdorf

## What we are building

Cypher gets its own brand, a two-mode interface, and a rebuilt web app on affectUI, delivered in six phases over roughly 14 weeks by two engineers with design support. The current control center (`apps/web`) stays in service while the new shell is built beside it on the same contracts and API; surfaces move over one at a time behind the Bliss/Everything dial.

**The product thesis.** Cypher knows everything about an engagement so the Director only has to know what matters. The line is "Ignorance is bliss", and it is a structural choice, not a tagline: every screen has a **Bliss** face (Cypher's sentence, at most three things that are yours, one line per project or person, no chat, Cypher's recommendation inside each card) and an **Everything** face (the full console with search, tables, the activity log and a Cypher panel you talk to). A dial in the top bar switches them and remembers the choice per screen.

**The brand.** Cypher is not an Icreon-system product. One typeface (Plus Jakarta Sans), one quiet ground, colors that each mean one thing (hue = team, coral = yours, green = done), and a mark that is an eye with three states. Nothing under 13px; no serif, no monospace.

**Done means** every surface in `apps/web` renders both modes from the new theme; the old stylesheet (`prototype.css`, 4,039 lines, and `app.css`, 2,559) is deleted; every token, type style, icon and component comes from the Cypher Design System; the backend supplies Cypher's words; and the Director can run four engagements from Bliss alone.

## Sources of truth

Four things define the work, in this order of authority. When two disagree, the one higher in the table wins and the lower one is corrected.

| Source | What it owns | Where |
| --- | --- | --- |
| Cypher Design System | Brand law, tokens, type scale, the marks, voice rules, component guidelines; `tokens.css` is generated from it | [Cypher Design System](https://claude.ai/artifact/WBunecoMGZxDf12PawJVh4) |
| Cypher canvas | The reference screens: Dashboard and Mission Control in both modes, the brand sheet; the look engineering matches | [Cypher canvas](https://claude.ai/artifact/9oQ2L4tPJW1RVXvWvvP1BG) |
| The codebase | Contracts (`packages/contracts`), the API and SSE stream (`apps/control-api`), the simulator, and the current app's behaviour (`apps/web`): keyboard, replay, live tail, the Floor | `slamensdicreon/icreon-claude` |
| affectUI | The component source for agent UI: one `.tsx` per item, React 19, no Tailwind; 40 items MIT, the agent set (Agent Tree, Agent Inbox, Trace Waterfall, Context Map, Agent Handoff) Pro | affectui.com, `flohoeller/affectui` |

The exploration canvas from this week (five directions, color studies, the first shell) is reference only; nothing is built from it.

## Target architecture of apps/web

The app keeps its state model, API client, live stream and keyboard layer, and gets a new presentation layer in five pieces. Each piece is a folder under `apps/web/src`; nothing else in the monorepo changes except the contracts named in the next section.

| Piece | What it is | Replaces |
| --- | --- | --- |
| `theme/` | `tokens.css` generated from the design system, `type.css` with one class per type style, `icons.tsx` (the line icon set, 24 grid, 1.8 stroke), `marks.tsx` (the eye in three states and the wordmark, generated from the system's SVGs) | `styles/prototype.css`, `styles/app.css`, the Carbon sprite in `lib/icons.tsx`, the Hero New fonts |
| `mode/` | `useMode()` reads and sets `'bliss' \| 'everything'` per surface, persisted in `localStorage` first and in the user record later; `<Dial/>`; a `<Mode bliss={…} everything={…}/>` switch each surface uses to render one of two faces | nothing today: `layout.present` (presentation mode) is folded into Bliss |
| `shell/` | `Rail` (Bliss), `Sidebar` (Everything), `TopBar`, `Cypher`Launcher and CypherSheet (Everything only: a fixed eye button bottom right that opens the chat as a sheet; nothing docks beside the content), the project switcher, the presence pill. Section lists are data, shared by Rail and Sidebar | `Shell.tsx` (Sidebar, Strip, MobileNav), `dock/Dock.tsx` |
| `voice/` | `<Voice/>` for the sentence, `<Recommendation/>` for the inline verdict, `<Read/>` for a one-line project or person read, `useEyeState()` derived from the Mission Control snapshot. Strings come from the API; the components never compose them | prose scattered through `surfaces/*.tsx` and `lib/fmt.ts` |
| `ui/` | affectUI items copied in by the shadcn CLI (`components.json`, `@/` alias) and restyled to tokens, plus our own components: Eye, YoursCard, ProjectTile, TeamLine, KpiTile, Table, PhaseStrip, MetricCard | `parts/Card.tsx`, `parts/bits.tsx`, `parts/Boot.tsx`, the overlays |

Surfaces (`surfaces/*.tsx`) stay where they are and shrink: each becomes a thin file that selects data from the snapshot hooks in `state.tsx` and renders `<Mode bliss={<X.Bliss/>} everything={<X.Everything/>}/>`. The Floor (`scene/`) is untouched except that `readTheme()` reads the new variables, which it already does by name.

Three rules keep it coherent. Every color, size and radius in the app is a `var(--…)` from `tokens.css`; a hex in a component is a bug. Every string Cypher says comes from the API; a template string in a component is a bug. Every surface has both faces before it ships; a surface with one face stays on the old shell until it has two.

## Backend and contract changes

Bliss depends on words the backend does not produce today. Six additions to `packages/contracts` and the projector, each small, each needed before the surface that reads it can ship in Bliss. The orchestrator posts them the way it already posts briefs and the dock's status embed; where Claude is configured they are written by the Chief of Staff role with the existing templates as the fallback, so Bliss never shows an empty sentence.

| Addition | Shape | Read by |
| --- | --- | --- |
| `MissionControlSnapshot.voice` and `PortfolioSnapshot.voice` | `{ text, emphasis, closing }`: the sentence, the clause that is the Director's, the closing line ("I'll say nothing until five") | the Voice line at the top of every Bliss screen |
| `EscalationView.recommendation` | `{ verdict, why, pick }`: one line each, `pick` an option id | YoursCard and the decision card; the primary button |
| `PortfolioItem.read` and `TeamNowRow.read` | one sentence in Cypher's voice for a project tile or a lead's line | project tiles and the team list in Bliss |
| `MissionControlSnapshot.handled[]` | `{ text, at }`, the last five things settled without the Director | the Handled list in both modes; replaces the dock's "since you were away" prose |
| `ArtifactDocument.summary` and `attention[]` | a plain-words paragraph and up to three `{ label, target }` pointers, written by the producing agent at save | the Workbench's "in plain words" block |
| `GET/PUT /me/preferences` | `{ mode: { [surface]: 'bliss' \| 'everything' } }`, with `localStorage` as the first store | the dial |

The eye's state is derived in the client from data the snapshot already carries: needs-a-word when `waitingOnYou` has an open item, watching when any phase has `tasksRunning > 0`, resting otherwise; a new open item triggers the blink. No contract change is needed for it.

Everything mode reads the existing contracts unchanged. The one behavioural change is that `postMessage` intent routing (status, needs, next, pause, approve) gains the three quick prompts the panel shows, which already exist as slash commands.

## Component mapping

Every surface in the current app, what it becomes in each mode, and what it is built on. "Ours" means a component in `ui/` written to the design system's guideline; affectUI items are copied into `ui/` and restyled. Pro items are held behind our own implementation until the license is in place.

| Surface today | Bliss face | Everything face | Built on |
| --- | --- | --- | --- |
| Dashboard (`Dashboard.tsx`, `CypherHome.tsx`) | Eye hero, Voice line, three YoursCards, four ProjectTiles, Handled list | Four KpiTiles, Projects Table (6 columns), Needs-you list, Deploys, Agents under load, two charts, the Cypher button | Smart Recommendation, Change Summary, Number Ticker, Decision Inbox; Table, ProjectTile, KpiTile ours |
| Mission Control (`Mission.tsx`) | PhaseStrip, Voice line, the decision card, two quiet YoursCards, TeamLines, Handled | PhaseStrip with labels, four MetricCards, Needs-you list, Tasks Table, Team list, Activity log, the Cypher button and sheet | Smart Recommendation, Decision Inbox, Tool Call Card; the rest ours |
| Needs you (`Inbox.tsx`, `parts/Card.tsx`) | One decision card at a time, the others as a short stack beneath | Decision Inbox with every open item, fold-open to options, evidence and the resolved/undo line | Decision Inbox, Smart Recommendation, Notification Stack |
| Team (`Team.tsx`, `Inspector.tsx`) | TeamLines by lead with faces; tap a face for a one-line read | Agent Tree with costs rolling up, Agent Handoff per task, the Inspector as a Trace Waterfall and Context Map | Agent Tree, Agent Handoff, Trace Waterfall, Context Map (Pro); TeamLine ours |
| Plan (`Plan.tsx`) | "What happens next" as a short timeline of the next five activities | Today lanes, Engagement weeks, the activity list, the task inspector with re-run and roll back | ours; Progress Tracker for the phase checklist |
| Workbench (`Workbench.tsx`, `parts/Doc.tsx`, `DataDoc.tsx`) | The document's plain-words summary and its "what to look at" pointers | The document rail with status tags, Change Summary since the approved version, Filter Menu, fold-open Blueprint rows, Comment Thread, completeness tracker | Change Summary, Filter Menu, Comment Thread, Progress Tracker |
| Site preview (`Preview.tsx`) | One page: source beside target at one breakpoint, parity as a word | Page list with parity, three breakpoints, open in Page builder | ours |
| Activity (`Activity.tsx`, `scene/Floor.tsx`) | The Floor, framed by the Dial and a Live/Replay control, with the last beat as one Tool Call Card | The Floor beside the Tool Call Card stream; the full log with filters and live tail | Tool Call Card, Segmented Control; the Floor ours |
| Scorecard (`Scorecard.tsx`) | Three numbers in sentences | Category table, playbook comparison | ours |
| Settings (`Settings.tsx`), New project (`NewProject.tsx`) | Everything only (no Bliss face; the dial is hidden) | Credentials, budgets, gates, escalation policy, conventions, danger zone; the intake wizard | affectUI Button, OTP Input, Profile Menu; forms ours |
| Shell (`Shell.tsx`, `Dock.tsx`, `Palette.tsx`) | Rail, floating switcher and Dial | Sidebar, TopBar with search (the palette's commands behind it), the Cypher button and sheet | Segmented Control, Thinking Loader, Message Actions, Profile Menu |

Two surfaces are deliberately Everything-only, because a Bliss face would hide what the person came to do: Settings and New project.

## Delivery plan

Six phases, about 14 weeks, two front-end engineers plus one backend engineer for the contract work in phases 1 and 2, with design review at each exit. Each phase ships behind the dial to the demo projects first, then to live engagements. Estimates are engineering weeks for the pair, not calendar promises; the first two phases set the pace for the rest.

| Phase | Weeks | Scope | Exit criteria |
| --- | --- | --- | --- |
| 0 Foundations | 1–2 | `theme/` from the design system; Plus Jakarta Sans; `icons.tsx` and `marks.tsx`; `mode/` with the Dial and `localStorage`; `shell/` Rail, Sidebar, TopBar; affectUI installed (`components.json`, `@/` alias) and five items restyled to tokens | The old app runs inside the new shell with the Dial visible; no hex values in `theme/` consumers; Storybook-style page lists every token and item |
| 1 Dashboard and Mission Control | 3–5 | Both faces of both surfaces to the canvas; Voice, YoursCard, ProjectTile, TeamLine, KpiTile, Table, PhaseStrip, MetricCard; backend `voice`, `recommendation`, `read`, `handled` | Matches the canvas on the demo projects; eye state and blink correct against the simulator's scripted days; Director can act on every yours item from Bliss |
| 2 Needs you and the Cypher panel | 6–7 | Decision Inbox and Smart Recommendation replace `parts/Card.tsx`; the Cypher button and sheet with status, since-you-were-away, bubbles, quick prompts; `/me/preferences` | Every escalation type and the gates work in both modes; keyboard shortcuts (1–4, D, A, J/K) preserved; undo and defer preserved |
| 3 Team and Activity | 8–9 | TeamLines; Agent Tree, Handoff, Trace, Context Map (Pro, or our own if unlicensed); Tool Call Card stream; the Floor reframed with the Dial and Live/Replay | Replay, scrub and live tail unchanged in behaviour; Inspector feature-complete in Everything |
| 4 Workbench, Plan, Preview, Scorecard | 10–12 | Document rail, plain-words summary (`summary`, `attention[]`), Change Summary, Filter Menu, Comment Thread; Plan's three views; Preview; Scorecard | Blueprint, inventories, reports, PRs and the decision log all render; the Director reads a Blueprint in under a minute in the usability check |
| 5 Settings, intake, polish, cut-over | 13–14 | Settings and New project in Everything; motion and reduced-motion; phone layouts; delete `prototype.css` and `app.css`; remove Hero New and the Carbon sprite | QA matrix green; accessibility audit passed; old stylesheet gone; demo day on the four live projects |

Two tracks run in parallel from week 1: the backend contract work (one engineer, phases 1 and 2, then on call), and the design system's component guidelines, which design writes one surface ahead of engineering so that each phase starts with its READMEs in place.

The cut-over is per surface, not big-bang: a surface moves to the new shell the day it has both faces and passes the QA matrix, and the old surface component is deleted the same day. There is no feature flag beyond the dial.

## Risks and open decisions

Four risks carry real schedule weight; three decisions are yours and should be made before phase 1 starts.

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| affectUI Pro license not in hand | The Team and Activity depth views (Agent Tree, Handoff, Trace, Context Map) are Pro; phase 3 would build them by hand | Buy before phase 3 (week 8); until then our own versions, scoped to the canvas, which stay as fallbacks |
| Cypher's words depend on the model | A bad `voice` line is worse than none: it is the first thing the Director reads | Templated fallbacks for every string; a voice review on the simulator's scripted days before each phase ships; the "Says / Not" table in the design system as the test |
| Two faces doubles the QA surface | Every change is tested twice | The QA matrix (next section) is the definition of done per surface; surfaces cut over one at a time |
| The old stylesheet is load-bearing | 6,600 lines of CSS carry layout the surfaces depend on; deleting early breaks the old app we keep running | The new shell wraps the old surfaces in phase 0; old CSS is removed per surface at cut-over, deleted whole only in phase 5 |

Decisions to make before phase 1:

- [ ] Name the modes for customers: Bliss / Everything as drawn, or Quiet / Full if "Bliss" reads glib in a client room. The dial, the design system and the voice copy change together.
- [ ] Plus Jakarta Sans stays, or one more look at Figtree and Albert Sans before the type scale is frozen in `tokens.json`.
- [ ] Dark theme: out of scope for this plan, or a phase 6. The shell is already ink; Bliss on a dark ground needs the eye and the halo redrawn.

## Quality bar

A surface is done when it passes the matrix below in both modes on the two demo projects and one live project. The matrix is the acceptance test; design review signs the look, engineering signs the behaviour.

| Check | Bliss | Everything |
| --- | --- | --- |
| Matches the canvas at 1440 | Yes, to the pixel on layout and type | Yes, to the layout; data may differ |
| Nothing under 13px except the rail label | Yes | Yes |
| Every color, size, radius is a token | Yes | Yes |
| Every Cypher string comes from the API, with a fallback that renders | Voice, recommendation, read, closing | Status block, bubbles |
| Three is the limit; a fourth item waits and Cypher says so | Yes | not applicable |
| Keyboard: ⌘K, G-chords, 1–4, D, A, J/K, Esc | Yes | Yes |
| Screen reader: the eye announces its state; every control has a name; the dial is a group | Yes | Yes |
| Contrast 4.5:1 for all text on its ground | Yes | Yes |
| Reduced motion: no halo, no blink, no shimmer | Yes | Yes |
| Phone (390): the rail becomes a bottom bar; cards stack; tables scroll in a box | Yes | Yes |
| Live stream: a new event updates the surface within one second; the eye blinks on a new yours item | Yes | Yes |
| The Floor keeps replay, scrub and live tail | Activity only | Activity only |
| Performance: first render under 1.5 s on the demo project; no layout shift when voice strings arrive | Yes | Yes |

The usability check in phase 4 is a single task: a Director who has never seen the product reads a Blueprint in Bliss and says what changed since approval, in under a minute.

## Governance

The design system is the only place a brand value lives, and the app reads it rather than copies it. Three practices keep that true after launch.

1. **Tokens flow one way.** A color, size or radius changes in the design system's `tokens.json`; the page regenerates `tokens.css`; a pull request copies that file into `apps/web/src/theme/`. A value added by hand in the app is reverted in review. The marks are regenerated the same way from Assets › Marks.
2. **Guidelines travel with components.** A component's README in the design system is its spec; when it changes, the matching file in `ui/` changes in the same week, and the component's README in the repo links back to the system. New components start as a README and a preview in the system before code.
3. **Voice has an owner.** The "Says / Not" table is the test for every string Cypher produces. Product owns it; engineering adds a scripted day to the simulator whenever a new kind of sentence is introduced, so the fallbacks and the model output are reviewed on the same data.

The canvas is retired once phase 1 ships: from then on, the design system and the running app are the references, and new surfaces are designed as components in the system, not as screens on a canvas.
