# Control Center redesign: audit of the current front end

The starting point for the design and UI refactor of the Control Center (`apps/web`). It records
what exists, what each surface does and reads, how the design system is built today, and what
will break if the refactor isn't careful. The new vision gets built on top of this.

Audited at `65f137b`, the head of the production branch `claude/sharp-pascal-3u2qg0`. Baseline
screenshots of every surface are in [`baseline/`](baseline/README.md).

## 1. Working safely beside the live app

| Fact                                                                                          | What it means for the refactor                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel project `launchworks` deploys production from **`claude/sharp-pascal-3u2qg0`**          | That branch is the live app. The refactor lives on **`claude/bold-euler-i3qm3k`**, branched from its head, and nothing merges back without review                                  |
| Git deployments are **disabled** on the project (`createDeployments: disabled`)                | Pushing the refactor branch builds and deploys nothing. Production changes only when someone deploys it deliberately                                                               |
| Preview environments share production's `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` and secrets    | **Never deploy the `api` service from this branch as a preview.** It would read and write the live database. If we want a hosted preview, deploy `web` alone against the simulator, or give previews their own Neon branch first |
| Sign-in works on the production domain only                                                   | A hosted preview of `web` pointed at production's API would bounce to production's login. Another reason to preview against the simulator                                        |
| The refactor is front end only (`apps/web`)                                                   | The API, contracts, worker and playbooks stay as they are. If the vision needs new data, that becomes a separate, additive backend change                                           |

**Local loop.** The real API on the in-memory simulator, with nothing persisted:

```bash
SIM_PROJECTS=2 SIM_SPEED=5 pnpm --filter @lw/control-api start   # :4000, three scripted projects
pnpm --filter @lw/web dev                                        # :5173, proxies to :4000
```

**Baseline health at `65f137b`:**
- `pnpm --filter @lw/web typecheck` passes.
- `pnpm --filter @lw/web build` passes, but the main chunk is 594 kB (180 kB gzip).
- No console errors on any surface.
- `apps/web` has **zero tests**, so the screenshots and a manual pass are the only regression net today.

## 2. The app at a glance

**Stack:**
- React 19 and Vite 8, written in TypeScript.
- No router library, no UI kit, no CSS framework.
- Two global stylesheets: `prototype.css` (4,039 lines) and `app.css` (2,559 lines).
- About 21k lines in total.
- Runtime dependencies: `@lw/contracts` (zod types shared with the API), `marked` with `dompurify` (Markdown), and `mermaid` (lazy-loaded).
- Brand: Hero New and Carbon icons (an inline sprite), on the Icreon Design System tokens.

**Shell:**
- Sidebar (280 px), with the project switcher, navigation, user chip and theme toggle.
- Status strip (64 px): phase, health, "Waiting on you", clock, budget, connection state.
- Canvas.
- Cypher dock (400 px): the Chief of Staff conversation and the queue of cards waiting on you.
- Inspector drawer, used for agents and tasks.
- Phones get a bottom nav and a More sheet instead of the sidebar.
- Presentation mode hides the operator chrome.

**Routing** is hand-rolled in `state.tsx`, with `pushState` and `popstate`:

| Route                    | Page                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `/`                      | Dashboard: the portfolio grid, with Cypher home in a side column                              |
| `/new`                   | New project wizard                                                                            |
| `/manage/:page`          | `settings`, `connections`, `playbooks`, `rules`, `knowledge`, `diagnostics`                     |
| `/p/:projectId/:surface` | `mission`, `inbox`, `team`, `plan`, `workbench`, `preview`, `activity`, `scorecard`, `settings` |

Only the page itself is in the URL. These are not deep-linkable:
- the inspector, overlays and presentation mode;
- per-project UI state: the expanded card, filters, the open Workbench document, the preview page, the Activity view.

That per-project UI state lives in an in-memory map and is lost on reload.

**Data loading** follows one pattern: load a snapshot, then follow the event stream.
- `lib/live.ts` caches `GET` snapshots per path.
- It opens one SSE stream per project (`/projects/:id/stream?after=seq`) and invalidates the cache on events.
- `run(fn, toast)` in `state.tsx` sends a command, refreshes, and turns a failure into a toast.

Some code doesn't follow the pattern:
- Dashboard polls with its own `usePoll`.
- Rules, Knowledge, NewProject and GithubApp fetch once and never refresh.
- Activity calls `get()` directly and listens to `live.onEvent`.
- Workbench reads artifact content with a raw `fetch`, so it gets no 401 redirect and no `ApiProblem`.
- `/playbooks` is fetched in four places.

**Keyboard:**
- ⌘/Ctrl K opens the palette; ⌘/Ctrl / opens the composer.
- `G` then a letter switches surface.
- `1`–`4`, `D` and `A` act on the open card; `J`/`K` move through Needs you.
- Esc closes layers from the top; `?` shows help.

## 3. Surface inventory

| Surface                      | File (lines)                             | Reads                                                                                 | Key interactions                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                    | `surfaces/Dashboard.tsx` (736)           | `/portfolio` (polled every 10 s), `/playbooks`                                        | Filter chips (Active / Needs me / Completed / All); project cards (health, phase bar, spend, waiting cards, Remix, Source site)                                                            |
| Cypher home                  | `surfaces/CypherHome.tsx` (342)          | `/cypher*` via `lib/cypher.ts`                                                         | Portfolio chat; project proposals turn into "Review and create"; saved conversations in the sidebar rail                                                                                   |
| New project                  | `surfaces/NewProject.tsx` (895)          | `/playbooks`, `POST /intake/verify`, `POST /projects`                                   | Dynamic wizard: Entity, Playbook, Project, Source, the playbook's intake steps, Brief, Review. Live access tests per credential                                                             |
| Manage: Playbooks            | `Dashboard.tsx`                          | `/playbooks`, `/playbooks/:id/scorecard`                                              | Catalog grouped by entity, with roadmap tiles, Compare, and Start a project                                                                                                                |
| Manage: Connections          | `Dashboard.tsx`                          | `/connections`                                                                        | Shared tenant credentials: replace, save from a project                                                                                                                                    |
| Manage: Rules, Knowledge     | `Rules.tsx` (268), `Knowledge.tsx` (527) | `/rules`, `/knowledge`                                                                | Propose, approve, edit, retire, view history; write a lesson; export per platform                                                                                                          |
| Manage: Diagnostics          | `Dashboard.tsx`                          | `/portfolio/diagnostics`                                                              | Services, needs attention, orchestrators                                                                                                                                                   |
| Manage: Settings             | `GithubApp.tsx` (177)                    | `/integrations/github`                                                                | GitHub App manifest flow, install link                                                                                                                                                     |
| Mission Control              | `surfaces/Mission.tsx` (352)             | `/mission-control`, `/scorecard`, `/preview` (presentation only)                      | Waiting on you (top 5), scorecard line, stat tiles, phase stepper, team now, latest from the team; agent floor hero in presentation mode; Ready to start for projects still in intake       |
| Needs you                    | `surfaces/Inbox.tsx` (331)               | `/conversation`, `/plan`, `/mission-control`                                          | Two panes, list and card; J/K; resolve, defer, undo, approve, send back, ask; answer in bulk; export CSV                                                                                   |
| Team                         | `surfaces/Team.tsx` (130)                | `/team`, `/agents/:id`                                                                | Leadership, then workstreams; filter All / Working / Not working; agent inspector (pause/resume, open in Activity)                                                                        |
| Plan                         | `surfaces/Plan.tsx` (795)                | `/schedule`, `/tasks/:id`                                                             | Today lanes, Engagement Gantt, Activity list; zoom (Ctrl+wheel, saved); task inspector (re-run, mark done, roll back, cancel); phone agenda                                                 |
| Workbench                    | `surfaces/Workbench.tsx` (914)           | `/workbench`, `/blueprint`, `/decisions`, `/facts`, artifact content                  | Wiki rail, search, table of contents; Blueprint mapping table; Decision Log with override; Project facts; Lessons; artifact viewer (typed documents, PRs, Markdown with mermaid, JSON)     |
| Site preview                 | `surfaces/Preview.tsx` (184)             | `/preview`                                                                            | Page list with parity, breakpoint switch, source and target screenshots, open in Page builder or on preview                                                                               |
| Activity                     | `surfaces/Activity.tsx` (225)            | `/activity` (paged), live events                                                      | List or agent floor (canvas, replay); severity and agent filters; live tail; export CSV                                                                                                    |
| Scorecard                    | `surfaces/Scorecard.tsx` (268)           | `/scorecard`                                                                          | Four tiles, by category, by phase, recurring questions; playbook comparison                                                                                                                |
| Project settings             | `surfaces/Settings.tsx` (1,262)          | `/settings`, `/playbooks`, `/hosting/deployments/:id`                                 | Source, playbook, brief, build repo, hosting, intake targets, credentials, budgets, gates, autonomy, standing approvals, escalation policy, conventions, capability gaps, danger zone       |

**Shared pieces:**
- **Layout:** `Shell.tsx` (sidebar, strip, mobile nav, toasts, away line), `Inspector.tsx`, `dock/Dock.tsx`.
- **Overlays:** `overlays/` holds dialogs, the typed confirm, the text form, make-a-rule, menus, the palette and the More sheet.
- **Building blocks:** `parts/` holds the escalation `Card`, Markdown `Doc`, JSON `DataDoc`, `Boot`, and the chips and jump links in `bits.tsx`.
- **Agent floor:** `scene/` is a Canvas 2D view of the activity feed, with replay.

## 4. The design system as it stands

**Tokens.** `:root` in `prototype.css` holds the Icreon Design System tokens copied verbatim:

| Token family      | Tokens                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Brand             | `--icreon-blue` `#386aff`, deep, soft, tint                                                                                  |
| Neutrals          | `--neutral-50` to `--neutral-950`                                                                                            |
| Semantic surfaces | `--web-bg`, `--web-surface-1..3`, `--web-fg-1..3`, `--web-accent*`, `--web-border*`                                          |
| Status            | `--success`, `--warning`, `--danger`, `--info`, each with a `-bg` variant                                                    |
| Motion            | Durations and easings                                                                                                        |
| Elevation         | `--elev-3..5`                                                                                                                |
| Focus             | `--ring-focus`                                                                                                               |
| Radii             | `--web-radius-1/2/pill`, at 2, 4 and 999 px                                                                                  |
| Layout            | `--side` 280, `--dock` 400, `--top` 64                                                                                       |
| Aliases           | `--blue`, `--amber`, `--red`, `--ink-2` and others, kept "for inline styles written by the prototype script". Only `--font` is still used |

Dark mode redefines the semantic tokens under `prefers-color-scheme`, and again under `[data-theme='dark']`.

**What is missing:**

| Gap                         | Today                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No type scale**           | 26 distinct `font-size` values, 10 px to 40 px, including 10.5, 11.5, 12.5, 13.5, 14.5 and 16.5                                                               |
| **No spacing scale**        | 92 distinct `padding` values, and no spacing tokens at all                                                                                                     |
| **No breakpoint tokens**    | CSS uses 640, 860, 900, 1100, 1280 and 1599 px. JS repeats 640, 900 and 1280 in `matchMedia`, partly at render time, so those checks don't react to a resize    |
| **No z-index scale**        | 11 distinct values, from 0 to 40                                                                                                                              |
| **Hard-coded colours**      | 45 hex and 33 `rgb()` literals in `prototype.css`. `scene/Floor.tsx` reads the token names at runtime with hex fallbacks                                       |
| **Inline styles**           | About 110 `style={{}}` across 23 files. The worst are Plan (24), Workbench (13), Inspector (11) and DataDoc (8)                                                |
| **Focus states**            | Only 6 `:focus-visible` rules                                                                                                                                 |

**Cascade.**
- `prototype.css` was layered as the prototype grew. "Plan" and "Workbench" each have two sections, and there is a "Chief of Staff dock, polished" section that overrides the first dock section.
- `app.css` then overrides `prototype.css` where real data didn't fit.
- 93 selectors are defined more than once (`.surface`, `.dock`, `.inspector`, `.convo`, `.statgrid`, `.np`, `.bp*` three times each), and there are 19 `!important`.
- The result is predictable only by reading both files in order.

**Component primitives exist only as class names, never as React components:**
- **Controls:** `.btn` (`primary`, `danger`, `sm`), `.iconbtn`, `.link-btn`, `.seg`, `.filters`, `.select`, `.input`, `.toggle`.
- **Status and labels:** `.chip.<state>`, `.type.<kind>`, `.dot.good|warn|bad|idle`, `.badge`.
- **Containers:** `.panel` and `.panel-head`, `.kv`, `.page-head`.

Every surface hand-assembles them. That is where the drift comes from:
- There are two filter-chip patterns. `.seg` and `.filters` set `aria-pressed`; `.dash-chip.on` shows the selected state by class only.
- Stat tiles are built separately in Mission and Scorecard.
- `RuleCard` and `KnowledgeCard` are near copies.
- The brief form and the credential form are each written two or three times.
- Mission control builds its own form inputs.

## 5. Findings

### 5a. Bugs in the live app

These need fixing on the production branch on their own, not just in the redesign.

| #   | Finding                                                                                                                                                                                                                                                                     | Where                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Card shortcuts `1`–`4`, `D` and `A` act on whichever card `ui.expanded` names, on **any** surface. Needs you sets `expanded` automatically, so after visiting it, pressing `1` on Plan or Team resolves a card                                                              | `App.tsx:156`                                           |
| 2   | The palette's shortcut hints are wrong. They come from `G` plus the surface's first letter: Needs you shows `G I` (the chord is `G N`), Site preview `G P`, Scorecard `G S`, and Settings shows a chord it doesn't have                                                     | `overlays/Palette.tsx:49`                               |
| 3   | The palette's "Approve the waiting review" skips the typed confirmation that a final gate needs. The workflow rejects the approval, so this is safe, but the Director gets an error instead of the confirm dialog                                                          | `overlays/Palette.tsx:76`                               |
| 4   | Rules and Knowledge **Save** closes the editor even when the save failed, because `act` swallows the error                                                                                                                                                                 | `Rules.tsx:153`, `Knowledge.tsx:151`                    |
| 5   | Answer in bulk: when a resolve fails, `busy` never resets and the dialog closes anyway                                                                                                                                                                                     | `Inbox.tsx:280`                                         |
| 6   | Inspector's close button uses the class `.icon-btn`, which has no CSS. Every other icon button uses `.iconbtn`                                                                                                                                                             | `Inspector.tsx:58`                                      |
| 7   | Workbench artifact content: the raw `fetch` skips the 401 redirect, and an error persists after you switch version                                                                                                                                                         | `Workbench.tsx:645`                                     |
| 8   | Activity `load()` has no catch, so failures become unhandled rejections                                                                                                                                                                                                    | `Activity.tsx:42`                                       |
| 9   | Needs you binds J/K and the arrow keys on `document`. They stay active under dialogs and stop arrow-key scrolling                                                                                                                                                          | `Inbox.tsx:80`                                          |
| 10  | Team silently drops agents whose workstream isn't in the hard-coded list of six                                                                                                                                                                                            | `Team.tsx`                                              |
| 11  | The agent floor clamps its scene to at least 640×480 while the canvas is 100% wide. Below 640 px the drawing squashes and hover and click positions no longer line up (inferred from the code, not reproduced)                                                              | `scene/model.ts:120`, `app.css:2320`                    |

### 5b. Hazards for the refactor

Renaming or restyling any of these breaks behaviour, not just the look:

- **Agent floor colours.** `scene/Floor.tsx` reads `--web-*`, `--icreon-blue*`, `--success`, `--warning`, `--danger` and `--font-sans` at runtime. If a token is renamed, the canvas silently falls back to the old hex values.
- **Workbench table of contents.** It queries `.wiki-doc h2/h3`, excludes `.viewer-head` and `.vh`, writes ids into the DOM and watches with a `MutationObserver`. Renaming those classes breaks the table of contents.
- **Inspector focus.** The Inspector focuses `.icon-btn` by selector.
- **Plan geometry.** Plan's lane geometry is shared between TSX magic numbers (200, 224, `1400*zoom-300`, 300 px, the 8 AM–8 PM and 8–18 axes) and CSS (`--zoom`, `--cells`). Both sides must change together.
- **Layout in JS.** Layout state is applied as `.app` modifier classes (`dock-collapsed`, `side-open`, `present`, `home`, …). Breakpoints are tested in JS too (Shell, Dock, Plan), so a CSS-only breakpoint change leaves the JS behind.
- **New project wizard.** It keeps three arrays indexed by step position (`TITLES`, `valid`, `pages`) that must stay in sync.
- **Overlays.** Overlays are React nodes stored in state, so their props freeze when they open.
- **Re-renders.** The app context `value` is rebuilt on every render. Every `useApp()` consumer re-renders on each composer keystroke, toast and layout change. A redesign that adds more animated chrome will feel this.
- **Dead code.** The `compact` and `queue` modes of `Card` are never used; only `full` is. Clean them up or delete them rather than restyle them.

### 5c. Accessibility

- **Status by colour alone:** `.dot` health indicators on the Dashboard, menus and Diagnostics; the phase stepper; Plan bars (the state is only in `title`); Activity row severity; floor figures.
- **Dialogs:** `Scrim` has no focus trap and no focus return. `TypedConfirm` has no `aria-modal` and uses a static id. The Inspector isn't modal but also doesn't return focus.
- **Missing roles and keyboard support:**
  - The palette has no `role=option` and no `aria-activedescendant`, and the selection doesn't scroll into view.
  - The project menu has no menu role.
  - The radio tiles in New project have no arrow-key support.
  - `MoreSheet` renders `aria-current="false"`.
- **Links that should be buttons:** evidence chips and "Latest from the team" items are `<a href="#">`.
- **The agent floor isn't keyboard reachable.** Its replay slider reports raw epoch milliseconds, with no `aria-valuetext`.
- **Toasts** disappear after 4 s (10 s with an action) and don't pause on hover or focus.

### 5d. Layout and visual (from the baseline screenshots)

- **Narrow canvas.** At 1440 px the canvas gets about 760 px between the 280 px sidebar and the 400 px dock.
  - Workbench puts three columns into that space, so file names break mid-word ("HazardRoute.t / sx").
  - Plan Today shows only 5–8 PM at default zoom.
  - The dock is the largest element on every project surface.
- **The dock repeats Mission Control.** Its "Needs you" strip repeats the strip's "Waiting on you" and Mission's own panel. The same three cards appear in three places on one screen.
- **The sidebar repeats Manage.** Its Manage section shows only Settings and Demo scenarios, while the header menu holds the six Manage pages. There are two homes for "manage".
- **Inconsistent density.** Type sizes jump between 11 and 15 px on one card. Panels use different internal padding on each surface.
- **Phone.** The strip truncates the phase name. Needs you is reachable only through More or the Cypher badge, though it is the Director's main job.

## 6. Recommended approach

Build foundation first, so every surface inherits the new look rather than being restyled by hand. Each step lands as its own reviewable commit on `claude/bold-euler-i3qm3k`, with typecheck, build and a screenshot comparison against `baseline/`:

1. **Tokens.**
   - Add the missing scales: type, spacing, breakpoints, z-index, radii, elevation.
   - Map the new vision's palette onto semantic tokens.
   - Keep the old token names as aliases until nothing reads them, the agent floor included.
2. **Primitives as components.**
   - `Button`, `IconButton`, `Segmented`/`FilterChips` (one accessible pattern), `Chip`/`Status` (colour plus text or icon), `Panel`, `Stat`, `Field` (input, select, textarea with label, hint and error), `Dialog` (focus trap, return, `aria-modal`), `Menu`, `Table`, `EmptyState`/`ErrorState`.
   - Retire inline styles as each surface moves onto these.
3. **Stylesheets.**
   - Split by component and surface: CSS modules, or one file per family.
   - Retire `prototype.css` section by section, so there is one definition per selector and no `!important`.
4. **Shell.**
   - Sidebar, strip, dock, inspector and mobile nav in the new design.
   - One breakpoint source shared by CSS and JS.
5. **Surfaces**, one at a time and highest-traffic first: Mission Control, Needs you, Plan, Workbench, Dashboard, then the rest.
   - Split the very large files (Settings, Workbench, NewProject, Plan, Floor) into view parts and logic hooks before restyling them.
6. **Safety net.**
   - Add Playwright smoke tests over the simulator: every route renders, the keyboard shortcuts work, a card resolves.
   - Add a screenshot script that regenerates `baseline/` for before/after comparison.

The live bugs in 5a are small, and most are one-line fixes. I recommend fixing them on the production branch as a separate change, so the live app benefits now and the redesign doesn't carry them.

## 7. What the vision needs to settle

- **Visual direction.**
  - Does this stay on the Icreon Design System, evolving tokens and density, or move to a new look?
  - Mockups, Figma or a reference artifact to build from (the prototype artifact `MTMcAyYAJXnp8siunR8a1L` is the spec for the current version).
- **Information architecture.**
  - Keep the three-column shell (sidebar, canvas, dock)?
  - Should Cypher stay a permanent dock, or become a summonable panel?
  - Merge or retire any surfaces?
- **Scope.** Are Manage pages, New project and presentation mode in this refactor, or later?
- **Mobile.** Is the phone a first-class operator surface, or read-and-respond only?
- **Libraries.** Is a router (for deep links to cards, documents and inspector state), a headless component library (Radix or React Aria, for dialogs, menus and focus) or CSS modules acceptable, or should it stay dependency-light as today?
