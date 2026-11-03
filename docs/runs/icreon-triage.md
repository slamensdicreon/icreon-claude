# icreon: triage log

icreon (`prj-f19218c3`) migrates https://www.icreon.com to SitecoreAI on the shared tenant, run on
sitecoreai-migration 0.10.4 (started 2026-11-03 22:47 UTC). The goal is a fully autonomous
implementation, so every card that reaches the Director is logged here: what the Lead would have
answered in shadow, what was decided, the root cause, and the fix that keeps the next project from
raising it.

It started with every fix from Ervin Cable's cards 1–17 deployed. It picks up lessons (K-170,
K-172, K-173) and prompts at run time, but its plan comes from playbook 0.10.4, fixed at its
start. So `redoWith` (a redone port re-running its integration) doesn't reach it; K-173 covers
that case.

| # | Raised | Card (task) | Category | Lead's shadow answer | Decided | Agree | Root cause | Fix that removes it |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 23:05 | Crawl the source site and build the page inventory: needs a decision (crawl-site) | other | None (category "other" goes straight to the Director) | Director (Claude): retry, after the fix below is deployed | n/a | icreon.com is large. `browser.crawl` returned every page's full link list, every image and 500 characters per block in one result: 428 pages came to about 580K tokens, and the 500-page retry took the agent's conversation to 1.69M tokens, over the model's 1M limit. Every retry failed the same way. | Shipped (deploy 23:1x): the crawl result is compact and bounded (400K characters, about 100K tokens). Links are counted, not listed; images on most pages are listed once; blocks keep a short excerpt. Past the budget, detail is cut in steps while every page stays listed, and the result says to use `browser.snapshot` for a page in full. Tested on a 300-page synthetic site. |
