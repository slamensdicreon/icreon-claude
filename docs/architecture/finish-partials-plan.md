# Finishing the partial work without the Director

Status: plan, 2026-10-31. Companion to [agent-intelligence-task-plan.md](agent-intelligence-task-plan.md)
and [entities.md](entities.md).

Seven pieces of planned work are started but not finished. This plan takes each to the point where
nothing is left but the Director's own click, and names that click. Everything below runs with
both live projects paused, as they are now: deploys restart the worker, which is harmless while
nothing runs. Nothing here resumes a project, answers a card, approves a rule or changes an
autonomy level; those stay with the Director and are listed at the end.

## What the evidence says

Production, 2026-10-31, three projects:

| Project | Cards raised | Shadowed and answered | Lead agreed | Rules |
| --- | --- | --- | --- | --- |
| Ansco Associates | 353 (237 media) | 0 (before M2) | – | 0 |
| Lambert's Cable | 156 | 40 | 14 (35%) | 0 |
| Star LLC | 85 | 6 | 3 | 0 |

Lambert's 26 disagreements have one shape. Twenty-plus are "*task*: needs a decision" cards: the
Lead rejected a result, two retries did not satisfy it, the card went to the Director. The Lead's
triage picked **Retry with the Lead feedback** (the card's recommended option); the Director picked
**Accept the current output**, with notes like "Checks pass. I read the branch…", "The cause the
Lead asked about wasn't in code". That is the Lead loop of task 88 and the low agreement of M2.8,
one problem seen from two sides: a result whose acceptance checks all pass is rejected for things
the checks cannot see, retried at full cost, and finally accepted by hand.

The harvest that turns answered cards into proposed rules (M3.6) is built, with its button on the
Rules page, and has never been run: there are no rules on any project.

## 1. Lead loops and triage calibration

Closes the Lead-loop half of task 88 and everything of M2.8 that is not the Director's switch.

| # | What | Where | Proof |
| --- | --- | --- | --- |
| 1.1 | The "needs a decision" card carries the evidence: the final check results (pass, fail, pending, with detail) and the rejection history (how many, the last reason, whether any rejection cited a failed check). Its recommended option follows that evidence: **accept** when every check passes and no rejection names missing work or a write outside the task, **retry** otherwise; the context says which. | `orchestrator/src/workflows/project.ts` (the raiser), `contracts` card input if a field is needed | Workflow test: passing checks recommend accept; a failed check recommends retry |
| 1.2 | Triage sees the same evidence and has one more rule: when every check passes and the rejections were not for failed checks or missing work, answer **accept** and say that the checks are the evidence. The recommendation is no longer taken on faith for this card type. | `agent-runtime/src/triage.ts` (`TriageInput` gains `checks` and `rejections`; prompt) | Fake-client tests: passes → accept; failed check → retry; missing-work rejection → retry |
| 1.3 | The Lead's third review of a result whose checks all pass must either accept or cite the failed check or the step that shows the work missing; a reason that cites neither is treated as accept with the Lead's notes attached. | `agent-runtime/src/review.ts` (structured output gains `cites`), orchestrator applies it | Tests: an uncited third rejection becomes accept with notes; a cited one stands |
| 1.4 | Re-score Lambert's 40 shadowed cards through the new triage offline (a script over the stored cards and their check results, with the model) and record agreement per category here. Target: 85% or better on `retry`. | `scripts/rescore-shadow.ts` (one-off, reads the API with an operator key, writes nothing) | The numbers in this section |
| 1.5 | Deploy. Shadow continues: new cards on Lambert and Star show the agreement live on the Scorecard. | – | Scorecard columns move |

Director's part, later: Settings → Autonomy, switch `retry` (and `naming`, `content` if their
agreement holds) from `shadow` to `lead`. The Lead's accept then applies without a card.

### Result (2026-10-31)

Measured first, from Lambert's recorded validator steps rather than the notes: of the 96
"needs a decision" cards the Director answered, how did the checks stand at the Lead's last
rejection?

| Director's answer | Every check passed | Passed or pending | A check failed | Cards |
| --- | --- | --- | --- | --- |
| Accept the current output | 13 | 3 | 23 | 41 (2 without a review or checks) |
| Retry with the Lead feedback | 1 | 1 | 53 | 55 |

Two findings changed the build. First, the loop the rule can end is the **18 cards on passing
work**: the Director accepted 16 of them (89%), so a third review that may only reject on hard,
cited grounds agrees with the Director there and costs two cards they chose to retry. Second,
**76 of the 96 cards had a failing check**, and the check was `parity.visual` in 64 of them,
`parity.render` in 12, `head.sections` in 5: pages failing because of components and a visual
judge stricter than the Director (who accepted 13 pages it had failed). Those are section 2's
work (component failures) and the 0.7.0 merge of Visual QA into the Parity Auditor, not a
triage problem.

Built:

- The Lead's verdict is structured: `grounds` (failed-check, missing-work, outside-task, report,
  none) and `cites` (the check id, step or document). `report` never rejects: it is recorded as
  an acceptance with the Lead's note. On the third review of a task whose checks all pass, a
  rejection stands only on hard grounds with a citation (`settleVerdict` in the stack, tested).
- Every `review.recorded` event now carries the checks' standing and the grounds, so the next
  measurement reads them directly.
- The "needs a decision" card says how the checks stood on the last attempt (failed, passed,
  pending by id), so the Director, the Lead's triage and a rule can tell a loop on passing work
  from a real failure without opening the log.
- Triage is unchanged on purpose: the orchestrator forwards any Lead answer that would accept work
  the Lead itself rejected ("accepting work its Lead rejected is your call"), and that guard is
  right. The loop ends at the review, where the evidence is.

Not done: an offline re-score with the model (no model key in this environment). The table
above is the measurement instead, and the new event fields make the next one exact.

## 2. Component failures stop costing page retries

The other half of task 88. Lambert's rounds were: fix a component, integrate it, rerun the pages
that used it, answer the QA cards; `retry` is Lambert's biggest category (101 cards) and Star's
(56). A page task fails `head.pages-render` or `parity.render` because a component is wrong, retries
twice at full cost, and raises a card nobody but a component engineer can act on.

| # | What | Where | Proof |
| --- | --- | --- | --- |
| 2.1 | Attribution: when a page check fails because of a component, the check's detail names it. `head.pages-render` reads the rendering name from the prerender error; `parity.render` and `head.sections` already know the section map and name the component whose rendering is missing or wrong. | `stack/src/review.ts`, `tool-servers/validators` where the detail is built | Tests on recorded failures from Lambert (FAQ Accordion, HeroBanner, ServiceCards) name the component |
| 2.2 | A page task whose failed check names a component does not retry and raises no card. It goes to `waiting` with the component as the reason, and the orchestrator reopens the component's `port-{key}` (rework, with the page's evidence as its instruction) and its `integrate-{key}`; when the integration completes, every page waiting on that component goes back to `ready`. One component, one rework, however many pages. | `orchestrator/src/workflows/project.ts` and `task.ts`, behind a workflow patch so running histories replay | Workflow test: three pages fail on one component → one rework, one integration, three pages resume, zero cards |
| 2.3 | Pages that were already done and used a reworked component are re-validated when its integration completes: acceptance checks run again; only a page whose checks now fail is reopened, with the component named. Pages' components come from the layout data `parity.render` reads, recorded on the task result as `usedComponents`. | orchestrator; `stack/src/review.ts` records `usedComponents` | Test: a rework reopens only the pages that break |
| 2.4 | Simulator scenario: a component defect on three pages. | `packages/simulator` | Scenario test: one card at most (the component's, if its own rework fails) |
| 2.5 | Lead review of page tasks: a rejection whose only grounds are a component's behaviour is not a rejection; the reason becomes a note and the page waits on the component as in 2.2. | `agent-runtime/src/review.ts` prompt and `cites` | Test |

## 3. Merged Blueprint items, behind a workflow patch

Task 84. Shipped once as playbook 0.6.2 and reverted because the workflow compiles the plan
itself, so dropping merged items' tasks changed a running history. The revert kept the Solution
Architect's `attrs.mergedInto`.

| # | What | Where | Proof |
| --- | --- | --- | --- |
| 3.1 | The planner skips `status: merge` items again, under `patched('skip-merged')`, so a workflow that started before the patch keeps the old plan and a new one gets the new plan. | `playbook-sdk` plan compiler takes a flag; `orchestrator/src/workflows/project.ts` passes `patched('skip-merged')` | Replay test with Lambert's recorded history stays deterministic; a new project has no tasks for merged items |
| 3.2 | Merged items that already have tasks on Lambert and Star keep them; the Lead's review treats "nothing to build, merged into X" as accept. | `agent-runtime/src/review.ts` | Test |

## 4. Run the harvest; stage the Director's review

M3.6 and the preparation of M3.7. The harvest groups a project's answered cards by category,
problem and answer, drafts one rule per group seen twice or more, and saves them as `proposed`,
scoped to the playbook. Nothing applies until approved.

| # | What | Where | Proof |
| --- | --- | --- | --- |
| 4.1 | Run `POST /projects/:id/rules/harvest` for Ansco, Lambert and Star in production. | API | Proposed rules exist; count per project noted here |
| 4.2 | Read every proposal. Rewrite unclear wording as a new version (the API versions edits); mark the ones that restate a card rather than a rule, and the ones a fix in code has already made moot (the brands-folder casing check, the FAQ before-and-after photos), with a note so the Director can reject them in one pass. Leave approval alone. | Dashboard → Rules, or the API | A short table in this section: rule, evidence count, our recommendation |
| 4.3 | The Lead-loop rule from section 1 ("when every check passes and the Lead's objection is not a failed check or missing work, accept") appears among the proposals with its Lambert cards as evidence; if the grouping splits it, propose it once by hand with the cards attached. | API | Listed |
| 4.4 | Deploy. | – | Proposals visible on the Rules page |

Director's part: approve or reject the proposals (M3.7). About twenty minutes, from the table in
4.2.

### Result (2026-10-31)

The harvest ran on all three projects: 21 proposals (Ansco 10, Lambert 6, Star 5), each a
`playbook` rule for `sitecoreai-migration`. Fifteen were reworded as a second version (general,
no project names, no tool names that belong to one project); three were retired as duplicates or
contradictions; three are left as proposed with a recommendation to reject. One fix to the
harvest itself: a card already behind a rule used to disqualify its whole group, which hid the
largest group of all (Lambert's forty "accept the current output" answers, one of which the
Director had already turned into R-1). Now only the covered card is left out.

| Rule | Category | Cards | Recommendation | What it says |
| --- | --- | --- | --- | --- |
| R-4 | retry | 55 (Lambert) | Approve | A page rejected while a site-wide defect was open: once it is fixed, retry and fix only what belongs to the page |
| R-5 | access | 14 (Lambert) | Approve | No source repository: never wait on GitHub; take copy and structure from a browser snapshot and the inventories |
| R-6 | ownership | 5 (Lambert) | Approve | Prerequisite fix done: restore the held component, snapshot to confirm, remove it again if it fails |
| R-7 | ownership | 4 (Lambert) | Approve | A component renders nothing: check its datasource and parameters, report, never substitute an asset |
| R-8 | retry | 3 (Lambert) | Approve | Upstream integration sent back: wait for its fix, fill content meanwhile |
| R-9 | tool | 2 (Lambert) | Approve | Build repository access fixed: re-verify, retry once |
| R-10 | media | 20 (Ansco) | Approve | Access denied and the Director says it is fixed: re-verify, retry once, ask again only on a second refusal |
| R-11 | retry | 14 (Ansco) | Approve | Rejected for incompleteness with concrete fixes listed: retry and do each |
| R-13 | other | 4 (Ansco) | Approve | Retries lost to a timeout: a run that never finished is not a rejection |
| R-14 | other | 12 (Star) | Approve | Retries lost to the model account's credit: retry once restored, never accept the empty output |
| R-15 | retry | 4 (Ansco) | Approve | Upload blocked on a missing source URL or alt text: look again, never guess |
| R-16 | retry | 10 (Star) | Approve | Page blocked on a component fix its owner owes: look again, don't compensate in content or code |
| R-19 | retry | 9 (Star) | Approve | Page blocked only by missing content while code fixes run separately: fill the content now |
| R-22 | retry | 2 (Ansco) | Approve | Validation blocked on a deliberate datasource or template choice: accept the registration, log the follow-up |
| R-23 | media | 2 (Ansco) | Approve | Page blocked on media not yet uploaded: migrate the copy now, leave the files to their upload task |
| R-12 | retry | 20 (Star) | Reject | Deploy rejected for an unrecorded production URL; moot since the hosting tool records it (`e39ab59`) |
| R-17 | other | 2 (Ansco) | Reject | "Budget used up: retry": budget is the Director's, not a rule |
| R-24 | other | 2 (Ansco) | Reject | "Workflow failed: accept the output": circumstance, not a rule |
| R-18, R-20 | tool | 2 + 2 (Ansco) | Retired | Not-connected QA tasks, answered both ways; moot once those tasks become Director checklist cards (0.7.0) |
| R-21 | content | 5 (Star) | Retired | Duplicate of R-14 |

The Lead-loop rule ("every check passes and the Lead's objection is not a failed check or
missing work: accept") is not among them yet: with the fix above it will be drafted from
Lambert's thirty-nine remaining accept cards on the next harvest, and section 1 gives the card
the evidence the rule needs first.

## 5. What the second and third sites taught (M4.3, M4.4)

| # | What | Where | Proof |
| --- | --- | --- | --- |
| 5.1 | Write "What Lambert and Star taught" into the task plan's M4 section: cards per category against Ansco, the top clusters, the questions agents kept asking (the facts M5 should publish: rendering ids, datasource locations, media paths, which component a page uses) and the lessons M6 should seed. | `docs/architecture/agent-intelligence-task-plan.md` | The section, with card ids as evidence |
| 5.2 | Add the lessons that already hold as rows in the SitecoreAI pitfalls file (partial designs order, rich-text media links, the editing host 500 from a bad registration, parameters templates by ID). | `playbooks/sitecoreai-migration/knowledge/known-pitfalls.md` | Rows cite the card or commit |
| 5.3 | The Dashboard comparison shows all three sites; confirm and screenshot. | – | Screenshot |

M4.3's shadow comparison continues on its own when the projects run again.

## 6. Shared code stops assuming SitecoreAI

The coupling map in [entities.md](entities.md). Each row becomes a pack hook; SitecoreAI keeps
exactly today's behaviour, Optimizely gets an honest "not yet" instead of a Sitecore default.

| # | What | Where | Proof |
| --- | --- | --- | --- |
| 6.1 | `pack.starter` (owner, repo, app path) replaces `STARTER`; the build repository's suffix comes from the platform id (`-sitecoreai` stays as it is for existing projects). An Optimizely project without a starter is refused at intake with a message naming O3. | `connectors/src/github-app.ts`, `control-api/src/intake.ts`, `web/src/surfaces/Settings.tsx`, `platforms/*/pack.ts` | Connector and intake tests for both packs |
| 6.2 | `pack.buildRecipe` (staged scripts, generated folders, read-only paths, the CLI operation) replaces the sandbox's Sitecore recipe; the worker hands the recipe to the sandbox per project. | `tool-servers/sandbox/src/server.ts`, `apps/worker/src/main.ts`, `platforms/sitecoreai/pack.ts` | Sandbox tests run against a recipe fixture; the Sitecore recipe equals today's |
| 6.3 | `pack.servers(deps)` builds the platform's tool servers (`sitecore-authoring`, `sitecore-cli`, `sitecore-deploy`) in place of the three `platform !== 'sitecoreai'` guards; the Optimizely pack returns none until O1 and O2, so its roles block honestly as unconnected. | `apps/worker/src/main.ts`, `platforms/src/index.ts` | Stack compose test with two packs; the worker's startup line still lists 8 servers |
| 6.4 | `pack.checks` contributes the platform's acceptance checks (`serialization.replays`, `head.editing-scripts`, `head.sections`, `rendering-host.set`, `editing-host.*`, `component-map.registered`); the shared ones (`build.green`, `deploy.commit-matches`, `notes.cited`, `inventory.complete`, `credentials.verified`, `blueprint.coverage`) stay in the stack. Plan validation fails loudly on a check no pack provides. | `packages/stack/src/review.ts`, `platforms/sitecoreai/checks.ts` (new) | Existing review tests pass unchanged; the Optimizely plan's missing checks are reported, not silently pending |
| 6.5 | `ProjectSummary.platform { id, name }`, filled by the API from the pack; the nine "SitecoreAI" strings in the web app (status strip, Preview, Mission, Workbench, Dashboard placeholder, the floor's CMS label) read it. | `contracts/src/snapshots.ts`, `control-api`, `apps/web` | An Optimizely intake project shows "on Optimizely" everywhere |
| 6.6 | Comments only: `ProjectTarget` fields and `RuleScope.kind` documented as pack-defined. | `contracts` | Review |

## 7. Sandbox sync: verify and close

Task 89 shipped in `e91c3d5` and `9ab2218` with tests: working copies fetch and fast-forward or
replay, `git.commit` recovers a push an earlier run lost, `fresh: true` restarts from the branch,
builds drop the fetch cache. Nothing remains in code. Close the task; the next resumed run is the
live confirmation (the FAQ Accordion pattern it fixed).

## Order and size

| Order | Section | Size | Why here |
| --- | --- | --- | --- |
| 1 | 4 Harvest | ¼ session | Zero risk, immediate value, gives the Director a review to do while the rest is built |
| 2 | 1 Lead loops and triage | 1 session | The biggest cut in cards on the next run; the re-score proves it before anything runs |
| 3 | 2 Component failures | 1½ sessions | The second biggest cut; builds on 1.3's `cites` |
| 4 | 3 Merged items | ½ session | Small, and it needs the same workflow-patch discipline as 2.2 |
| 5 | 5 Lessons | ½ session | Writing, from data already pulled |
| 6 | 6 Decoupling | 2 sessions | No effect on the live projects; unblocks O1 to O4 |
| 7 | 7 Close task 89 | – | Done |

About six sessions. Sections 1 to 3 change what the live projects do when resumed, so they are
tested against Lambert's recorded history (replay must stay deterministic) and deployed while both
projects are paused; the first resumed phase is watched.

## What stays with the Director

- Resume Lambert's Cable and Star LLC, and re-arm the watchers.
- Approve or reject the harvested rules (section 4; one pass over a prepared table).
- Switch autonomy levels from `shadow` to `lead` where the agreement holds (section 1.5).
- The project punch lists: Lambert's smoke-test card and handover gaps, Star's round 3.
- Decisions the roadmap already names: how the Pages agent signs in (M7.0), the worker's hosting,
  the Optimizely starter and pilot.
