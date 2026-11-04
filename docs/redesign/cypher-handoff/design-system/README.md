# Cypher Design System

Cypher is Icreon's chief of staff for SitecoreAI builds: a team of agents runs the engagement, and Cypher tells the Director only what matters. The product's line is **Ignorance is bliss**, and this system exists to make that line true on every screen. Cypher is its own brand. It does not inherit the Icreon design system; where the two meet (a deck, a proposal), Icreon's system frames Cypher's screens as pictures.

This document is the source of truth. `tokens.json` holds every value named here; nothing in the product uses a color, size or radius that is not a token. The page generates `tokens.css` from it, and the application imports that file as its theme.

## 1. What Cypher is, in one breath

Calm. Discreet. Decisive. Says less than it knows. Never surprises you. The visual language follows from the character: one typeface, one quiet ground, a small set of colors that each mean one thing, and a mark that is an eye because Cypher watches so you don't have to.

## 2. The two modes

Every screen has two faces and a dial between them. The dial lives in the top bar of every screen and remembers the Director's choice per screen.

**Bliss** is the default. It opens with a sentence from Cypher, shows at most three things that are the Director's, and reduces everything else to one line per project or person. The shell shrinks to a labelled rail (`rail`, 96px); search is hidden; Cypher does not chat. Its judgment is embedded: every card that is yours carries Cypher's recommendation inline, and the primary button is Cypher's pick, labelled as such. The eye leads the page.

**Everything** is the full console: the open sidebar (`sidebar`, 240px), search, tables, metrics, the activity log, and Cypher as a chat you open from the eye button fixed at the bottom right (`launcher`, 64px; the sheet it opens, `sheet`, 420px). Nothing docks beside the content; it takes the full width. It is one gesture away and never forced on anyone. Nothing in Everything is a different product; every number there sits behind a sentence in Bliss.

Rules that hold in both modes: nothing under 13px; a row is `row` (56px); a sentence before a table; three is the limit for what is yours; a number appears only when it changes a decision, otherwise it is a word ("on pace"); agents are people with a face, a name and one line; nothing moves while you read.

## 3. The eye

The mark is a circle in `ink` with an eye inside it. It has three states and they are the product's presence indicator everywhere it appears: the top of the rail and sidebar, the top bar's presence pill, the hero of a Bliss page, the label on every card that is yours, and inside each project's progress ring.

| State | Drawing | Meaning |
| --- | --- | --- |
| Resting | `ink` disc, a closed lid: a downward curve in `on-ink` | Nothing needs you. |
| Watching | `ink` disc, an open almond outline in `on-ink`, a small `on-ink` pupil | Agents are working; Cypher is reading along. |
| Needs a word | `coral` disc, a white almond, an `ink` pupil | A decision is the Director's. It blinks once on arrival, then holds still. |

The hero eye in Bliss sits in a halo (`coral-halo` when something is yours, `mist-2` otherwise) that breathes on a 4.5 second cycle; nothing else on the page animates while the person reads. The marks are in **Assets › Marks** as SVG; the wordmark is the word *cypher* in lowercase, `display` style, tracked −0.045em. Never redraw the eye by hand; never put a second face, mascot or emoji anywhere in the product.

## 4. Voice

Cypher speaks in the first person and in sentences, never in labels. Counts under thirteen are words. It names people by first name after the first mention. It says what it would do and why, in one line. It never apologises and never narrates its own process.

| Says | Not |
| --- | --- |
| Three things moved. One needs you before 2:24. | 2 escalations raised, 1 resolved, 11 cards settled by leads. |
| Emily is waiting on you. Everyone else is fine. | Engineering: 4 active, 1 blocked. Quality: 2 active, 1 waiting. |
| I'd pick one. Say the word. | Option A (recommended, 84% confidence). Proceeds with default action A at 14:24. |
| Handled. I'll say nothing until five. | Resolved. Daily digest scheduled for 17:00 project time. |

Where the voice appears: the one `voice` line at the top of every Bliss screen (light weight, with the clause that is the Director's set in `voice-emphasis`); the inline recommendation in every card that is yours (`body-small`, the verdict in bold); the one-line read on each project tile; a closing line at the bottom of a Bliss page; and the chat bubbles in the Everything panel. The backend supplies these strings (see §10); the UI never composes Cypher's sentences from templates.

## 5. Color

Color is information. Hue says which team. `coral` says it is yours. `green` says it is done. Everything else is `ink` on `bliss`. If a color appears, it means something; nothing is colored for warmth.

- **Ground and surfaces.** `bliss` is the page. `surface` is a card or panel on it. `surface-quiet` is a well inside a card. `mist` draws every line; `mist-2` the quieter ones (table rows, tracks).
- **Ink.** `ink` is text, the shell and primary controls. `ink-2` and `ink-3` are raised surfaces and lines inside the shell. `on-ink`, `on-ink-muted` and `on-ink-quiet` are the three text levels on ink.
- **Text levels on light.** `ink` for titles and body, `text-2` for secondary body, `text-3` for labels and metadata. `text-3` is the lightest text allowed anywhere and it is never set under 13px.
- **Yours.** `coral` is a graphic color: the eye, the halo, dots. As text or as a filled control it becomes `coral-text`, which passes contrast on white; `coral-tint` tints a tile or row that has something yours in it.
- **Done.** `green` for checks, pass chips, the live dot. It is never a background.
- **Teams.** `iris` Discovery, `blue` Engineering, `teal` Content, `gold` Quality. They appear on avatars, phase segments, type pills (colored by the team that raised the item), and progress bars on that team's work. All four carry white text at 4.9:1 or better. `gold` doubles as the waiting state and `gold-tint` as a warning row.

There is one theme. A dark theme is a later decision, not a token flip: the shell is already ink, and Bliss on a dark ground would need the eye redrawn.

## 6. Type

One family, **Plus Jakarta Sans**, hosted from Google Fonts at weights 300 to 800. No serif, no monospace anywhere, including tables and logs; numbers align through `font-variant-numeric: tabular-nums` on the root.

The scale has four steps and a number:

| Style | Size / line / weight | Where |
| --- | --- | --- |
| `voice` | 44 / 1.12 / 300, −0.025em | Cypher's sentence at the top of a Bliss page; the clause that is yours in `voice-emphasis` (600). Mission Control uses `voice-small` (42). |
| `heading` | 24 / 1.2 / 700 | Section headings in Bliss ("Everyone else is fine."). |
| `title` and `card-title` | 22 and 20 / 700 | The question on a card that is yours; a project name. |
| `section` | 17 / 700 | Panel titles in Everything. |
| `body` and `body-small` | 16 and 15 / 400 | Body in Bliss and Everything respectively. |
| `table` | 14.5 / 400 | Table and list cells in Everything, on `row` height. |
| `meta` | 13.5 / 400 | Who, when, where under a title. |
| `label` | 13 / 700, +0.06em, uppercase | The small caps label above a card or tile, in `text-3` or `coral-text`. |
| `rail-label` | 11.5 / 600 | The one exception to the 13px floor: the word under a rail icon, in `on-ink-muted` on ink, which passes at 9:1. |
| `number` | 32 / 1.05 / 600, −0.03em | KPI and metric numerals, with `number-unit` (16 / 500, `text-3`) for the "of 37". |
| `display` | 64 / 1 / 800, −0.045em | The wordmark only. |

Light weight carries the voice; bold carries what is yours. There is no italic.

## 7. Spacing, radius, elevation

The scale is 4-based: `space-1` to `space-8` (4 to 48). Bliss breathes on the top half of the scale (cards padded `space-5`, sections `space-7` apart, the main padded `space-8`); Everything uses the lower half (panels padded `space-4`, sections `space-4` apart, main padded `space-5`). `row` (56px) is the height of any row a person reads or taps; nothing tappable is under 44px.

Radii grow with calm: `radius-sm` (10) for tiles inside the shell, `radius-md` (14) for nav and wells, `radius-lg` (18) for Everything panels, `radius-xl` (24) for Bliss cards and tiles, `radius-xxl` (28) for the single decision card, `radius-pill` for every control.

Elevation is almost absent. A card that is yours in Bliss carries `shadow-card`; the decision card carries `shadow-decision`. Everything else is a `mist` border on `surface`. No other shadows, no gradients, no left-border accent cards.

## 8. The shell

| Part | Bliss | Everything |
| --- | --- | --- |
| Left | A `rail` of icon-above-word items, `ink`; the eye at the top; the active item a `surface` pill with `ink` icon and word; a `coral` dot on Yours; Settings and the user at the bottom. | A `sidebar` with the eye and wordmark, the project switcher (initials tile in the team hue), icon-beside-word items on `row` rhythm, a `coral-text` count badge on Needs you, Settings, the user chip. |
| Top | No bar. A project switcher pill, the date, and the dial, floating on `bliss`. | A `topbar` on `surface`: page title (`title`) and a one-line subtitle (`meta`), search, the dial, the presence pill with the eye. |
| Right | Nothing. Cypher is in the cards. | Nothing docked. The Cypher button (`launcher`, 64px, `ink`, the eye at 40px in its current state, a `coral-text` badge with the count of what is yours) sits fixed 24px from the bottom and right edges of every Everything screen. It opens the Cypher sheet (`sheet`, 420px, `radius-xl`, anchored above the button, up to 720px tall) with the eye and a one-line presence, a status block, bubbles, quick prompts and the composer. The sheet overlays content, closes with its control or Escape, and never pushes the layout. |

The project switcher reads "All projects" at portfolio level and the project's name with its initials tile inside a project. Section names are the same in both modes: Mission Control, Needs you (Yours in the rail), Team, Plan, Workbench, Site preview, Activity, Scorecard; at portfolio level Dashboard, Needs you, Projects, Team, Workbench, Activity, Scorecard.

## 9. Iconography

Line icons, 20px (22 in the rail), 1.8 stroke, round caps and joins, drawn on a 24 grid, in the current text color. Every nav item is an icon with a word; an icon never stands alone except in a 44px-or-larger button with an accessible label. The set in use: Home (four rounded squares), Needs you (inbox tray), Projects (folder), Team (two people), Plan (three lines with a return arrow), Workbench (document with lines), Site preview (browser window), Activity (pulse), Scorecard (bars), Settings (sliders), Search, Chevron, Check, Send. The eye is never used as an icon for anything but Cypher.

## 10. Components

The application is built on affectUI items where one exists, themed to these tokens, and on components of our own where it doesn't. Every affectUI file is copied into the repository and restyled; nothing is linked at runtime. The table is the handoff for engineering.

| Component | Mode | Built on | Notes |
| --- | --- | --- | --- |
| Eye | both | ours | Three states as SVG; `blink` animation on arrival; the halo in Bliss only. |
| Dial | both | affectUI Segmented Control | Two options, pill, remembered per screen. |
| Rail and Sidebar | both | ours | §8. |
| Top bar | Everything | ours | Title, search, dial, presence pill. |
| Voice line | Bliss | ours | One per screen; a `{text, emphasis}` pair from the API. |
| Yours card | Bliss | affectUI Smart Recommendation | Label with the eye, title, one body line, Cypher's inline verdict, Cypher's pick as the primary button, the alternative beside it, who and when. |
| Decision card | Bliss | affectUI Smart Recommendation | The large form on Mission Control: question and context left, verdict and two choices right, defer and ask beneath, "If you say nothing: A, at 2:24". |
| Project tile | Bliss | ours | Progress ring with the eye inside, name, phase and percent, Cypher's one-line read, faces, `coral-tint` when something is yours. |
| Handled list | Bliss | affectUI Change Summary | Green check, one sentence, a time. |
| Team line | Bliss | ours | Avatar in the team hue, name, team, one line from Cypher, faces of the people working. |
| KPI tile | Everything | affectUI Number Ticker | Label, `number`, one line. Four per row, never six. |
| Table | Everything | ours | Six columns at most, `table` style on `row` height, a hue bar for progress, a health word under the name. |
| Needs-you list | Everything | affectUI Decision Inbox | Type pill in the raiser's hue, title, meta line, clock, one action. |
| Tool call row | Everything | affectUI Tool Call Card | Time, who and tool, what happened, result word. Folds open to arguments and result. |
| Cypher button | Everything | ours | Fixed bottom right, `launcher` 64px on `ink`; the eye at 40px in its current state; a `coral-text` badge with the count of what is yours. Hidden in Bliss, where Cypher does not chat. |
| Cypher sheet | Everything | affectUI Thinking Loader, Message Actions, Comment Thread | Opens from the button: presence, status block, bubbles, the directive-applying well, up next, quick prompts, composer. Overlays content; never docks. |
| Phase strip | both | ours | Ten segments colored by the owning team; Bliss shows only the track, Everything adds labels and percentages. |
| Metric card | Everything | ours, charts as inline SVG | Label, `number`, a small chart. Two by two. |
| Agent tree, handoff, trace, context map | Everything | affectUI Pro | Team and Activity depth views; held until the license is in place. |
| The Floor | Everything | ours (canvas) | The existing canvas renderer reads its colors from `tokens.css`; it is framed by the Dial and Tool call rows. |

What the consumer provides: the strings Cypher says (`voice`, `recommendation`, `read`, `closing`), the eye state, the mode, and the data the row shows. Components never derive Cypher's words from data.

## 11. Motion

Arrivals are marked, then everything holds still. Durations 200ms, ease-out. The eye blinks once (lid closes and opens over 320ms) when a new item that is yours arrives. The hero halo breathes at 4.5 seconds. Shimmer appears only on a Thinking Loader while Cypher is working. Every animation respects `prefers-reduced-motion` and stops.

## 12. Accessibility

Text is 4.5:1 or better on its ground in every component: `text-3` on `bliss` is 4.7:1, `coral-text` on white 4.9:1, each team hue with white text 4.9:1 or better. The only text under 13px is the rail label, which is 11.5px bold on ink at 9:1. Every control is a real button or link with a visible label or an accessible name; the dial is a `role="group"` with `aria-pressed`. The eye carries `role="img"` with its state as the label wherever it conveys state, and `aria-hidden` where it is decoration beside a word. Focus rings are 3px `blue` at 40% outside the control. Colors that must be told apart differ in lightness, never hue alone; the project ring's progress and the eye's state both carry a word beside them.

## 13. Consuming this system

The page generates `tokens.css` from `tokens.json`; the application imports it as `apps/web/src/theme/tokens.css` and reads only `var(--…)` values. The type styles map to CSS classes of the same name in `apps/web/src/theme/type.css`. The marks in Assets › Marks are the only source of the eye and the wordmark; the application inlines them as React components generated from those files. When a value here changes, `tokens.css` is regenerated and nothing else in the application needs to change; when a component's guidance here changes, its README in `components/` says so and engineering follows it.
