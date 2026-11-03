# Ervin Cable: triage log

Ervin Cable (`prj-7fe62178`) is a no-repo remix on the shared SitecoreAI tenant, run on
sitecoreai-migration 0.10.1. The goal is a fully autonomous implementation, so every card that
reaches the Director is logged here: what the Lead would have answered in shadow, what was
decided, the root cause, and the fix that keeps the next project from raising it.

**Autonomy question for each card:** could the Lead (or a rule) have answered it alone? And what
change removes the card entirely?

| # | Raised | Card (task) | Category | Lead's shadow answer | Decided | Agree | Root cause | Fix that removes it |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 19:53 | How to point ervin-cable at its editing host? (switch-editing-host) | tool | opt-1: re-register the editing host at ervin-cable-editing | Director, opt-1 | Yes | Phase 3 registered the production URL as a Deploy editing host under the key `ervin-cable` (no `xmcloud.build.json`, so the agent used the site name). Deploy then manages the rendering host item of that name, so the Authoring API's update to it never sticks (409 read-back), and the editing alias can't be registered until a preview of `launchworks/integration` is recorded. Lambert and Star registered under the starter's key and never collided. | Fixed (below) |
| 2 | 19:57 | Rendering host item won't take the editing URL (switch-editing-host) | tool | opt-1: engineering fixes rendering-host.set (capability gap) | Director (Claude), opt-1 | Yes | Same cause as card 1, one step on: re-registering the Deploy host `ervin-cable` at the editing address succeeded in Deploy, but the CM item Deploy manages still read the production URL, and the Authoring API can't change it. | Same fix |
| 3 | 20:31 | By hand: Prove the pilot slice end to end (prove-pilot-slice) | manual | (none: a Director checklist step) | Waiting on the Director | n/a | Not a fault: the playbook keeps one Page builder check mid-build, by hand, because agents have no Pages sign-in. It is the only human stop between Blueprint and UAT, so it decides whether the build runs unattended. | Director: automate it. Marked done on the checks that exist; playbook changed (below) |
| 4 | 20:35 | Hero reel video is 157 MB, over the 50 MB Edge limit (upload-media-hero-reel-video) | tool | Forwarded: no rule; every option changes the client's asset | Director (Claude), opt-3: still image in the hero, reel in known gaps | n/a (forwarded) | The source's only video files are 157 MB (MP4) and 87 MB (WebM); `media.upload` takes up to 25 MB and Edge serves up to 50 MB; no tool transcodes. | Rule R-25 (platform, tool): over-size media uses the source's still, logged as a known gap with a hosting recommendation, so the Lead decides it next time. Capability gap noted: a transcode tool would keep the video. |
| 5 | 20:48 | Site Header conflicts with integration (integrate-site-header) | other | None (category "other" goes straight to the Director) | Director (Claude), opt-3: send port-site-header back for the fix | n/a | A page asked for a header change (transparent on Home, dropdown chevrons). The Head Integrator wrote it on its own branch, which then conflicted with the component's branch in SiteHeader.tsx and SiteHeader.module.css. Component code belongs to the port task. | Lesson K-170 (head-integrator) now, and the head-integrator prompt (next deploy): never change a component's code on the integration side; send it back to its port task. |
| 6 | 21:08 | Migrate Home: what it needs is missing (migrate-pages-home) | retry | opt-1: look again, do the content fixes now (rules R-8, R-19) | Director (Claude), opt-1 | Yes | The page waited on Hero Banner and Site Footer code, and the Hero port had used its two automatic send-backs. But the Hero fix had already landed and been integrated at 21:05 (the integrator sent it back to the port task, per K-170), and nearly everything else on the list was content: images, the Contact section's fields, the footer's links and logo. | None new: the Lead's rule-based answer was right. This card would close itself once "retry" moves from shadow to Lead-decided. |
| 7 | 21:11 | Migrate Home: what it needs is missing, again (migrate-pages-home) | retry | opt-1: look again; footer link fields as a gap (R-8, R-15) | Director (Claude): re-ran the Hero port with the two measured fixes, added the footer's social and Privacy Policy fields (template and code), then opt-1 | Partly: same option, but the Lead's "footer links as a gap" would have shipped a footer without its social icons | The content was done; what remained was code in five components. The Hero port had used its two automatic send-backs (two from the Home page and one from the integrator, which now sends component changes back as K-170 asks), so the whole page escalated instead of sending the other four components back. | Shipped with cards 8–11 (below): send-backs counted per asking task. Missing template fields (the footer's social links) belong to the registrar: the migrator should send them there, not list them as a gap. |
| 8–11 | 21:15–21:25 | Migrate Privacy Policy, Life at ECC, Opportunities, Subcontractor Request: what it needs is missing | retry | opt-1 on all four: look again and do the content fixes now (R-8, R-19, R-11, R-15) | Director (Claude): opt-1 on all four, after the fix below shipped | Yes (4 of 4) | The same cause as card 7, spreading: each page needed some Hero Banner change, and the Hero port had spent the single shared allowance of two send-backs. So every page escalated, and none did its own content fixes. Star LLC ran into the same storm. | Shipped: send-backs are counted per asking task (`patched('send-back-per-requester')`), so each page has its own two asks per component and an integrator's don't spend them. Tested: three asks of one component from two tasks raise no card (the old counting raised one). |
| 12 | 21:28 | Migrate Home: what it needs is missing (third wait) | ownership | opt-1: look again once the fix lands (R-8) | Director (Claude), opt-1 | Yes | Home's content was complete; it had waited three times (the wait limit) on component fixes that were being redone at that moment. | See card 13. |
| 13 | 21:39 | Migrate Home: what it needs is missing (again, at its very next wait) | ownership | opt-1 | Director (Claude), opt-1, after the fix below | Yes | The wait count never reset: once a page had waited three times, every later wait raised a card at once, even right after the Director told it to go on. | Shipped: an answered card renews the task's waits (`patched('answer-renews-waits')`). Tested: five waits with one answer raise one card (the old code raised two). |
| 14 | 21:45 | (no card) The project stopped taking commands: "orchestrator is stuck on a failed step" | system | n/a | Claude: engineering fix, deployed 22:08 | n/a | Pausing the project to deploy signalled every task workflow. One had just finished, so Temporal answered "external workflow not found", and that unhandled rejection failed every workflow task from then on: no task started or finished, and resume and card answers returned 503 for about 25 minutes. | Shipped: pause, resume and cancel signals ignore a task workflow that has already finished. Erwin's stalled history replayed on the new worker and carried on with nothing lost. |
| 15–17 | 22:05–22:21 | Migrate Home, Migrate Benefits, Migrate Privacy Policy: what it needs is missing | ownership | opt-1 on both: wait for the owed component fixes, don't work around them (R-8); check images meanwhile (R-7, R-19). On Benefits, undo the Carousel workaround | Director (Claude), opt-1 on all three (Privacy Policy had no shadow answer: raised while the project was paused for the deploy) | Yes (2 of 2 with an answer) | Both pages had waited three times, and every wait was on work under way: integrate-site-header was running, and port-site-footer and port-image-text were queued, partly because of the 25-minute stall (card 14). The wait limit counted those waits as if nothing could end them. | Shipped (next deploy): a wait counts toward the limit only when nothing under way can end it. Waiting on a queued or running fix, or sending finished work back, is progress; send-backs keep their own limit of two per asker. Tested: four waits, each on a fix under way, raise no card (the old counting raised one). |

## Fixes

- **Cards 1 and 2: a Deploy editing host collided with the site's own rendering host.**
  - Playbook (migration 0.10.2, portal 0.2.2): phase 3 no longer registers a SitecoreAI Deploy
    editing host. Deploy's editing hosts belong to the whole environment (a shared tenant: each
    project re-registered the starter's `basic-nextjs` host at its own production URL, last one
    wins), and Page builder renders each site through its own rendering host, set in phase 4.
  - `sitecore-deploy.editing-host.register` refuses the site's own name, and refuses to repoint a
    host that serves another head, so projects pinned to older playbooks can't do it either.
  - `sitecore-authoring.rendering-host.set`: when the host item named after the site won't take
    the write (Deploy manages it), the site gets its own `<site>-editing` host item and its Site
    Grouping points there; the Deploy item is left alone.
  - Autonomy: the Lead's shadow answers matched both times. This category ("tool") needed an
    engineering fix, not a decision; with the fix, the task completes without a card.
- **Card 3: the pilot proof was a hand step, and its two Page builder checks had never existed.**
  `editor.component-enabled` and `editor.new-datasource` answered "no automated check exists
  for this yet", so until today only a person ever proved them.
  - New SitecoreAI checks: `editor.component-enabled` (each rendering exists once, is offered in
    Available Renderings, has the head's `componentName`, and a Datasource Template that exists
    when the Blueprint gives it fields) and `editor.new-datasource` (a Datasource Location is set
    and, when a path, exists, so Page builder can create content).
  - Playbook (migration 0.10.3, portal 0.2.3): `prove-pilot-slice` is no longer by hand. The
    Structural Validator runs those checks on the pilot components (the plan compiler now scopes
    a pilot proof to the pilot items), and sends failures back to the registration task. Page
    builder itself is checked once, in the Director's UAT. The only hand step left before UAT is
    gone.
- **Card 14: a pause signal to a task that had just finished stalled the whole project.**
  `signalAll` sent pause to every task workflow without handling a rejection; Temporal rejects a
  signal to a workflow that has completed. The rejection was unhandled, and the workflow sandbox
  fails the workflow task on an unhandled rejection, every retry. Pause, resume and cancel
  signals now `.catch()` that case. Catching it issues no new commands, so the stalled history
  replays unchanged. Autonomy: no card reached the Director, but nothing moved until engineering
  shipped a fix; the diagnostics page named the failure exactly.
- **Cards 12 and 15–17: the wait limit counted waits on work under way.** The limit exists to
  stop a task waiting forever on something no task will make. It counted every wait, so a page
  re-checking after each component fix, which is the intended flow, reached three waits and
  raised a card while fixes were still queued. Now a wait counts only when the tasks it names have
  finished and it sends nothing back (`patched('wait-limit-in-flight')`). That kind of wait is the
  real "still missing" loop. Send-backs stay capped at two per asker per task, so a page can't
  loop on fixes either.

