# Lead triage replay, 4 November 2026

Proof, before a project runs unattended, that the Leads can settle the cards they are given.
`POST /projects/:id/triage/replay` asked today's Lead every card the Director answered with one
of its options on the five live projects, and compared the Lead's choice with the one taken.

The Lead saw only what was known when each card was raised:

- the project's decisions recorded before the card;
- rules and lessons made before the card, or learned on other projects (seed lessons always).

Nothing a card taught reached the Lead answering it.

Not replayed:

- deadline defaults;
- gates;
- release and scope cards;
- answers given as a note only;
- cards raised outside a task.

518 cards, $12.08.

## By project

| Project | Playbook | Cards | Agree | Differ | Forwarded |
|---|---|---|---|---|---|
| Ansco | 0.3 | 246 | 52 | 21 | 173 |
| Lambert's Cable | 0.5 | 143 | 20 | 11 | 112 |
| Star LLC | 0.6 | 77 | 29 | 26 | 22 |
| Ervin Cable | 0.10 | 46 | 36 | 0 | 10 |
| icreon | 0.10 | 6 | 2 | 0 | 4 |

Ervin Cable, the most recent project on the current playbook, is the best guide to what happens
next. The Lead matched the Director on all 36 cards it answered and forwarded 10. Seven of those
10 were the Director's to decide: creating the site in SitecoreAI Sites, the 157 MB hero video,
the Form built in SitecoreAI Forms, and accepting parity gaps for UAT.

## By category (all projects)

| Category | Cards | Agree | Differ | Forwarded | Right when it answered | Answered | Level now |
|---|---|---|---|---|---|---|---|
| Retry | 192 | 59 | 28 | 105 | 68% | 45% | lead |
| Media | 166 | 22 | 8 | 136 | 73% | 18% | lead |
| Tool | 49 | 9 | 8 | 32 | 53% | 35% | lead |
| Other | 32 | 18 | 5 | 9 | 78% | 72% | ask |
| Ownership | 28 | 16 | 4 | 8 | 80% | 71% | lead |
| Access | 22 | 2 | 0 | 20 | 100% | 9% | ask |
| Content | 15 | 9 | 1 | 5 | 90% | 67% | lead |
| Naming | 14 | 4 | 4 | 6 | 50% | 57% | lead |

## What the 58 differences were

- **30 were wording, not judgment.** The "what it needs is missing" card offers "Retry: look for it
  again" and "Retry, and work around what is missing". The Director's real instruction was in the
  note: "do the page's own fixes now, don't wait on the components". The Lead wrote the same
  instruction in its reasoning but picked the other label. When a Lead settles a card, its
  reasoning goes to the task as the instruction, so these would have run the same way.
- **7 were integration conflicts** (tool; Star, Lambert, Ansco). The Director's answer was always to
  integrate the clean branches now and rebuild the conflicting port on top of
  `launchworks/integration`. The Lead preferred to send the branch back, or to retry once other
  integrations finished. No lesson covered it, so one does now: **K-195**, for the Head
  Integrator, Engineering Lead and Component Engineer, platform-wide. The replay can't measure it,
  since it was written after those cards, but the next project gets it.
- **7 were Ansco media sourcing** (playbook 0.3). The Lead used the Director's later rule (use the
  source page's `og:image` when the Blueprint URL fails) on cards the Director had answered before
  making that rule. These are defensible either way.
- **The other 14** are spread across Ansco and Lambert, both on old playbooks, and are mostly
  conservative alternatives: rebase before committing, check the layout before rebuilding.

## What it means

- Leave every Lead-level category on `lead`. None showed a pattern of wrong answers on the
  current playbook, and Ervin had none.
- Keep `access` and `other` on `ask`. The Lead forwarded 91% of access cards, which is right:
  they need a person or a permission.
- Media and retry are forwarded most often, because many need something only the Director has
  (an asset, a site created in Sites). That is the remaining human load: roughly 7 of Ervin's 46
  cards.
- Run `POST /projects/:id/triage/replay` again after a project finishes, to see whether new rules
  and lessons moved the numbers. `GET` reads the stored results.
