# Projects at scale

One Director running 30 to 50 projects. The Dashboard's projects table and the project switcher
were built for a handful; this is what changed so they hold fifty.

## Built

- **The projects table** (Dashboard, Everything; `apps/web/src/surfaces/dashboard/ProjectsTable.tsx`).
  - Views with counts: Active (the default), Needs you, Running, Not started, Paused, Archived,
    All. Archived still shows *Deleted projects* beneath.
  - Filters: **Platform** (the platform with the most projects first) and **Playbook**
    (narrowed to the platform chosen). A playbook is named by what it builds ("Website",
    "Customer portal"), in full only when two platforms' names would collide.
  - **Group by** playbook (default), platform, state or none. Group heads fold, and carry the
    count, the spend and what's yours.
  - Search across name, client, playbook and platform.
  - Six columns: Project (with *N yours* and the client), Platform · playbook, Phase, Progress,
    Spend (of budget), Last event.
  - The view, filters and grouping stay for this browser (`lw-projects`); the search doesn't.
- **The API**: each project on `GET /portfolio/overview` carries `client`, `platform` and
  `playbook` (`{ id, name }`, from the intake's pack and the catalog).
- **The switcher** (`apps/web/src/overlays/Menus.tsx`). Past six projects it opens on a search
  ("Find a project among 23"), then **Needs you**, **Recent** (the last projects opened from it,
  `lw-recent-projects`) and **Everything else**. Enter opens the first match; the arrow keys move
  between rows. Archived projects stay out, as before.

Tests: `apps/web/e2e/projects-at-scale.e2e.ts`, and the overview case in
`apps/control-api/test/overview.test.ts`.

## Next

- **Bliss**: what's yours as cards, then one line per state ("28 moving, 3 ready to start…")
  instead of a tile per project.
- **Bulk actions**: tick rows, then pause, archive, export or delete several at once (delete-now
  confirmed by typing how many).
