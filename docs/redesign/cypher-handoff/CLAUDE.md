# Cypher handoff

This package is the brief for refactoring `apps/web` in `slamensdicreon/icreon-claude` into Cypher: a new brand, a two-mode interface (Bliss and Everything), and affectUI as the component base. Read this file, then `PLAN.md`, then `design-system/README.md`. Everything else is reference.

## What is in here

| Path | What it is | Authority |
| --- | --- | --- |
| `PLAN.md` | The refactor plan: thesis, architecture of `apps/web/src`, contract changes, component mapping, six phases with exit criteria, risks, QA matrix, governance | The plan of record |
| `design-system/README.md` | The brand book: modes, the eye, voice, color, type, spacing, shell, iconography, components and their affectUI counterparts, accessibility | The law for anything visual or verbal |
| `design-system/tokens.json` | Every color, type style, spacing, radius and shadow value | The only source of a value |
| `design-system/tokens.css` | Generated from `tokens.json` in this package; copy to `apps/web/src/theme/tokens.css` and regenerate when tokens change | Derived |
| `design-system/components/*` | Guidelines (`README.md`) and static previews (`preview.html`) for Eye, Dial and YoursCard; the Cover is the system's face, not a component | Specs |
| `design-system/assets/Marks/*.svg` | The eye in three states and the wordmark; inline them as React components in `theme/marks.tsx`, never redraw | The only source of the mark |
| `reference/screens/*.dc.html` | The five reference boards: brand sheet, Dashboard and Mission Control in both modes. They are design-canvas artboards (a `<x-dc>` template with `{{holes}}` and `<sc-for>` loops over data in the script at the bottom); read them for layout, sizes, copy and structure. The live, rendered versions are on the canvas linked below | What the screens look like |
| `affectui/README.md` | How to install affectUI into the app and which items the plan uses | Setup |

Live sources, if you have access: the design system at https://claude.ai/artifact/WBunecoMGZxDf12PawJVh4, the canvas at https://claude.ai/artifact/9oQ2L4tPJW1RVXvWvvP1BG, the plan at https://claude.ai/artifact/Tg4Zj7hWKjdQsfzNTPhqQQ. When they disagree with this package, they win; say so.

## The rules that never bend

1. Every color, size and radius in the app is a `var(--…)` from `tokens.css`. A hex or a px value in a component is a bug.
2. Every string Cypher says comes from the API (`voice`, `recommendation`, `read`, `handled`, `summary`) with a rendering fallback. A template string composing Cypher's words in a component is a bug.
3. Every surface renders both faces, `<Mode bliss={…} everything={…}/>`, before it leaves the old shell. Settings and New project are the two Everything-only exceptions.
4. Bliss: no chat, no search, the sidebar is a labelled icon rail, at most three things that are the Director's, Cypher's recommendation inside each card. Everything: the full sidebar, search, tables, and Cypher as a sheet opened from a fixed eye button bottom right. Nothing docks beside the content in either mode.
5. One typeface, Plus Jakarta Sans. No serif, no monospace, nothing under 13px except the rail label. Tabular numerals on the root.
6. Icons are the line set in `design-system/README.md` §9, drawn on a 24 grid at 1.8 stroke, always beside a word in navigation.
7. The eye is only ever Cypher. Its state is derived (needs a word / watching / resting), never set by hand.

## Where things go in the repo

```
apps/web/src/
  theme/     tokens.css (copied), type.css (one class per type style), icons.tsx, marks.tsx
  mode/      useMode(), <Dial/>, <Mode/>; localStorage first, /me/preferences later
  shell/     Rail (Bliss), Sidebar (Everything), TopBar, CypherLauncher + CypherSheet (Everything), ProjectSwitcher, PresencePill
  voice/     <Voice/>, <Recommendation/>, <Read/>, useEyeState()
  ui/        affectUI items (via shadcn CLI) restyled to tokens, plus Eye, YoursCard, ProjectTile, TeamLine, KpiTile, Table, PhaseStrip, MetricCard
  surfaces/  unchanged files that shrink to <Mode bliss everything/> selectors over state.tsx hooks
  scene/     the Floor, untouched; readTheme() already reads CSS variables by name
```

What goes away, per surface at cut-over and whole in phase 5: `styles/prototype.css`, `styles/app.css`, the Carbon sprite in `lib/icons.tsx`, the Hero New fonts in `public/fonts`, `Shell.tsx`, `dock/Dock.tsx`, `parts/Card.tsx`, `parts/bits.tsx`.

Contracts to add in `packages/contracts` (shapes in `PLAN.md` › Backend and contract changes): `voice` on the Mission Control and Portfolio snapshots, `recommendation` on `EscalationView`, `read` on `PortfolioItem` and `TeamNowRow`, `handled[]` on the Mission Control snapshot, `summary` and `attention[]` on `ArtifactDocument`, and `GET/PUT /me/preferences`.

## Start here: phase 0

1. Add `components.json` and the `@/` alias to `apps/web` (Vite + `tsconfig` paths); install affectUI per `affectui/README.md`.
2. Create `theme/`: copy `design-system/tokens.css`, write `type.css` from `tokens.json` › `type.groups`, write `icons.tsx` from §9, generate `marks.tsx` from the four SVGs.
3. Create `mode/` and `shell/`; wrap the existing `App.tsx` surfaces in the new shell with the Dial visible. The old surfaces keep working inside it.
4. Restyle five affectUI items to tokens: Segmented Control (the Dial), Smart Recommendation, Decision Inbox, Tool Call Card, Thinking Loader.
5. Exit: the old app runs inside the new shell; a tokens page lists every token and item; `grep -rn "#[0-9a-f]\{6\}" apps/web/src/theme/consumers` returns nothing.

Then phase 1, Dashboard and Mission Control, both faces, to the reference boards.

## Demo data

The simulator's Ansell project is the reference: phase 4 Components at 62%, three items waiting on the Director (the campaign-slot decision with a 2:24 PM default, the Vercel token, the pilot-slice review), nine of twenty agents working, $286 of $1,200. Every reference board uses the same hour, so a screen can be checked against another.
