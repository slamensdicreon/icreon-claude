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

