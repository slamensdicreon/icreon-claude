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
