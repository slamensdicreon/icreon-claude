# The surfaces, rebuilt to the boards

Phase 0 put the old Control Center inside the Cypher shell. This round rebuilds the pages themselves.
Each now renders its own Bliss face and Everything face, built from Cypher components on the design
system's tokens and fed real data from the API. The screenshots in this folder were captured at
1440×900 against the simulator (`SIM_PROJECTS=2`). They show the rebuilt surfaces in both modes, plus
the Dashboard and Mission Control in dark.

## Where each surface stands

| Surface         | Bliss                                                                                                                     | Everything                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard       | Eye hero, Cypher's sentence, three Yours cards with Cypher's verdict and pick, one ring tile per project, Handled          | Four KPI tiles, projects table with filters, Needs-you list, Deploys, Agents under load, Spend by day, Escalations over 24 hours    |
| Mission Control | Phase track, Cypher's sentence, the decision card, two quieter cards, the team in one line each, Handled                  | Labelled phase strip, metric cards, Needs-you list, Tasks table with filters, Team, live Activity                                   |
| Needs you       | One decision at a time in the large card; the rest as a short stack; Deferred                                             | Decision inbox: rows fold open to context, verdict, options and actions; Deferred; Just decided with Undo; J/K, 1–4, D, A           |
| Team            | Team lines in Cypher's words, with faces                                                                                  | The team as a tree: Chief of Staff (the eye), then each Lead with their people; tokens roll up; filter; inspector                   |
| Activity        | The Floor, with the last beat as a Tool Call Card (affectUI)                                                              | The log with filters, agent picker, live tail, CSV and paging; the Floor as a tab                                                   |
| Scorecard       | Three numbers, and what kept coming back                                                                                  | KPI tiles, by category, by phase, repeats                                                                                          |
| Site preview    | One page: source beside target, parity as a word, next and previous                                                       | Page list with parity, three breakpoints, open in Page builder or on preview                                                        |
| Plan            | What happens next: the next five activities and what each waits on                                                        | Rebuilt: Today lanes, Engagement weeks, activity list with groups and re-run, zoom (Ctrl+wheel, saved), up next, phone agenda; bars are buttons, states carry a glyph and a word |
| Workbench       | The documents, newest first; one opens in Everything                                                                      | Rebuilt: document rail with status tags, Blueprint with Filter Menu, completeness and Change Summary (affectUI), Decision Log with override, Project facts, Lessons, every document type, a scoped table of contents |
| Settings        | (Everything only)                                                                                                         | Rebuilt in groups (the project, access, budgets, who decides, the record, danger zone), a sentence before each table               |
| New project     | (Everything only)                                                                                                         | Rebuilt: one list of steps, a rail with checks, a live summary, radio tiles with arrow keys; validation and request bodies in typed modules shared with Settings |
| Manage pages    | (Everything only)                                                                                                         | Rebuilt: Global settings (GitHub App), Connections, Playbooks with comparison, Rules, Knowledge with export, Diagnostics; one shared card for rules, lessons and proposals |

Every page is now rebuilt on Cypher components, and so is everything around them: the palette, menus
and dialogs, the inspector drawer, the Cypher sheet's conversation (in a project and at portfolio
level), Mission Control's presentation mode and Ready to start, the phone's bottom bar, toasts, the
first-load screen and the Workbench's document type. The old stylesheet (`prototype.css`, `app.css`),
the bridge and the Carbon icon sprite are deleted. The app loads `theme/tokens.css`, `theme/base.css`
(resets on tokens) and `theme/type.css`; every component styles itself in a CSS Module. The favicon is
the eye, and operator email is set in Plus Jakarta Sans.

## Cypher's words come from the API

The contract (`packages/contracts/src/voice.ts` and the end of `snapshots.ts`) adds:
- `voice`, `handled`, `recommendation`, `raisedBy`, and the Lead rows' `face`, `read`, `readTone` and `reports` on Mission Control;
- `GET /portfolio/overview` for the Dashboard.

`apps/control-api/src/voice.ts` writes every sentence from templates in Cypher's voice: counts under
thirteen in words, first names, verdicts that start with "I'd", no apologies. A model can take this
over later without the UI changing. The UI renders these strings. A sentence the UI writes itself only
stands in where the API has no field yet, such as a Lead line on a snapshot without `read`.

What the API couldn't fill truthfully, and does instead:
- **Spend this week:** there is no weekly budget, so the note reads "$X of $Y overall".
- **"On pace":** this means healthy (no open blocker, no repeated retries, spend under 80%), not measured
  against the forecast.
- **Raiser:** a card with neither a source task nor a triage Lead has no `raisedBy`, so its card says
  "Raised 4 min ago" with no name.
- **Handled:** lists cards settled without the Director only. Send-backs and deploys aren't listed yet.
- **The Dashboard's poll:** the overview reads each project's recent log; the API keeps those facts
  per project until its log moves (at most a minute), so polling doesn't re-read the event store.

## Open for design

- The boards' 23px and 29px card titles, 15.5px body and 9px initials in faces have no type token. The
  build uses the nearest token, or a size derived from the spacing tokens; adding type tokens for them
  would settle it.
- Portfolio-level Team, Workbench, Activity and Scorecard pages (§8) don't exist yet. The portfolio nav
  shows Home or Dashboard, Needs you and Projects. The last two jump to their Dashboard sections.
