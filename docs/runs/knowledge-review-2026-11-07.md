# Knowledge and rules review, 2026-11-07

Every waiting proposal (59 knowledge entries, 17 rules, from Ervin Cable, icreon, UtiliQuest and Star LLC) reviewed and applied in production at the Director's request. Before: 142 entries and 17 rules in force, 76 proposals waiting since 2026-11-03. After: 199 entries and 19 rules in force, none waiting.

## Approved (38)

| Ref | Entry | Kind | Scope | From |
| --- | --- | --- | --- | --- |
| K-210 | Re-crawl the source for a parity inventory | procedure | role:content-analyst | icreon |
| K-209 | Upload a source media file served from the Sitecore media CDN | procedure | role:media-migrator | icreon |
| K-207 | Check whether a source route redirects before building a page for it | lesson | playbook:sitecoreai-migration | icreon |
| K-204 | Build the head's <title> and meta description from the SEO metadata fields when the head is built | lesson | playbook:sitecoreai-migration | Ervin Cable |
| K-203 | Check the rendered <title> on the editing host before submitting SEO work; if the head is the cause, wait instead of resubmitting | lesson | role:experience-enabler | Ervin Cable |
| K-202 | A Director decision overrides the brief's round limit | lesson | playbook:sitecoreai-migration | Ervin Cable |
| K-201 | Re-run the checks and measure the source before writing a card about failing parity | lesson | role:content-migrator | Ervin Cable |
| K-200 | A source video over the Experience Edge size limit: use its still and publish a known gap | procedure | platform:sitecoreai | Ervin Cable |
| K-198 | Find a source background image's URL with page.styles, then fetch and upload it | lesson | playbook:sitecoreai-migration | Ervin Cable |
| K-190 | State in each template task whether 'page design' means a new design item or a mapping to an existing one | lesson | playbook:sitecoreai-migration | icreon |
| K-189 | Create a dedicated page design item for a page template | procedure | platform:sitecoreai | icreon |
| K-188 | Finish a page template's insert options: standard values set, template item cleared | procedure | platform:sitecoreai | icreon |
| K-187 | Map only your own page template; never map the Standard template or a base template | lesson | role:rendering-registrar | icreon |
| K-186 | Don't submit a template task with the page-design half undone; wait for the lock | lesson | role:rendering-registrar | icreon |
| K-184 | Write all page-design mappings in one task, after the templates exist | lesson | playbook:sitecoreai-migration | icreon |
| K-182 | A billing or quota error is not a rejection: rerun the task unchanged once service is back | lesson | playbook:sitecoreai-migration | icreon |
| K-179 | Rework a page inventory after a rejection without re-crawling | procedure | role:content-analyst | icreon |
| K-168 | Plan a page template's own insert-option targets first | lesson | playbook:sitecoreai-migration | Ervin Cable |
| K-167 | Create a rendering's headless variant by copying an existing one | procedure | role:rendering-registrar | Ervin Cable |
| K-166 | Before submitting a registration, read every rendering field back and match it to the items you created | lesson | role:rendering-registrar | Ervin Cable |
| K-165 | Point a site at its own editing host (and what a 409 from rendering-host.set means) | procedure | platform:sitecoreai | Ervin Cable |
| K-164 | Add a rendering to the site's Available Renderings group with the shortest possible write | procedure | role:rendering-registrar | Ervin Cable |
| K-162 | Deploy the head and register it as the editing host under a project-specific key | procedure | role:deployment-engineer | Ervin Cable |
| K-159 | When asking the Director to create something by hand, give the exact values and the check you will run | lesson | playbook:sitecoreai-migration | Ervin Cable |
| K-158 | Keep the 404 and 500 pages out of the sitemap | procedure | platform:sitecoreai | Star LLC |
| K-157 | List the head's dictionary keys, with source wording, when the head's components are built | lesson | playbook:sitecoreai-migration | Star LLC |
| K-156 | Fix a card that renders without its photo | procedure | role:content-migrator | Star LLC |
| K-155 | Close a migrated page once its component fixes have landed | procedure | role:content-migrator | Star LLC |
| K-154 | Decide third-party widgets once, at inventory time | lesson | playbook:sitecoreai-migration | Star LLC |
| K-153 | Route a missing component variant to its owner; don't try to create it | lesson | playbook:sitecoreai-migration | Star LLC |
| K-150 | Pass shared components on visual parity before page tasks are checked visually | lesson | playbook:sitecoreai-migration | Star LLC |
| K-199 | Migrate Home: content fields and source background images | procedure | project:prj-7fe62178 | Ervin Cable |
| K-169 | Set the Home Page template's insert options and page design | procedure | project:prj-7fe62178 | Ervin Cable |
| K-223 | Re-check a page template's insert options and page design after the owner's fix | procedure | role:structural-validator | UtiliQuest |
| K-218 | Change the IDs in an Available Renderings group and prove it | procedure | role:rendering-registrar | UtiliQuest |
| K-213 | Fill the 404 entry's title and main heading from a real read of a missing URL | lesson | role:content-analyst | UtiliQuest |
| K-212 | Fix the defects in your own inventory yourself; don't hand them to the Lead | lesson | role:content-analyst | UtiliQuest |
| K-214 | Resolve a failing rendering ID to its item before asking anyone to remove it | lesson | role:structural-validator | UtiliQuest |

## Approved with a change (4)

| Ref | Entry | Change |
| --- | --- | --- |
| K-161 | Inventory components and design system from the live site | scoped to the website playbook: the homepage demo inventories only the homepage |
| K-220 | Don't repeat a wait whose owner has said the change isn't theirs or isn't needed | widened from the demo to every SitecoreAI role |
| K-219 | 'Rendering X not under the project folder' is about where the rendering item lives, not about an Available Renderings entry | dropped its reference to held components |
| K-197 | Set the header logo once on the shared header datasource, with the company name as its alt text | generalized from Ervin Cable to every SitecoreAI site |

## Kept as known gaps for engineering (13)

Gaps reach no agent; approving them keeps them on the record until fixed.

| Ref | Gap | From |
| --- | --- | --- |
| K-208 | Asset fetch refuses the source's media CDN host | icreon |
| K-206 | The same unresolved rejection creates a new Director card each time | Ervin Cable |
| K-205 | A wait on another task ends before that task's change is deployed to the editing host | Ervin Cable |
| K-196 | Page visual check can't set aside differences that belong to component code | Ervin Cable |
| K-185 | No way to add one entry to the page-design mapping without locking the whole item | icreon |
| K-181 | Running out of API credit should pause the run once, not exhaust retries and escalate every task | icreon |
| K-174 | No tool to drive Page builder in a browser or record video, so production editor smoke tests fall to the Director | Star LLC |
| K-163 | Adding to Available Renderings locks the whole group, so registrars queue | Ervin Cable |
| K-160 | No tool operation to create a site; every missing site needs a Director round trip | Ervin Cable |
| K-152 | A migrator can't request an image upload that no task covers | Star LLC |
| K-151 | A page task can't move once the component it waits on has used its send-backs | Star LLC |
| K-222 | A Director's acceptance of a failing check can't stop the Lead's automatic rejection | UtiliQuest |
| K-221 | The renderings check doesn't give the path or ID of the rendering it fails on | UtiliQuest |

## Rejected (4)

| Ref | Entry | Why |
| --- | --- | --- |
| K-178 | The site crawl has no size bound and returns duplicate home-page results | fixed: the crawl is compacted and stops after 7 minutes with what it read |
| K-217 | Structural and editor checks can't be scoped to the Blueprint's demo slice | fixed: checks skip merged components, and 0.2.0 has no held ones |
| K-216 | A check that fails only on a held or dropped Blueprint component: record it, don't wait | out of date (0.2.0 has no held components) and teaches agents to accept failing checks |
| K-215 | Starter renderings in a site's Available Renderings group fail the renderings check: the registrar clears them | wrong premise: extra starter renderings don't fail the check; removing them is a Director choice |

## Added (2)

- **Send a component fix to the task that owns it, not to the integration** (lesson, SitecoreAI): the UtiliQuest footer loop.
- **The new site's not-found page shows the head's fallback instead of the Sitecore 404 item** (gap, SitecoreAI).

## Rules

- Activated: R-42 (when a source page returns 404 on the live source site at every URL variant tried (with and wit…), R-32 (when a card's retries are exhausted because the worker session crashed or was stopped before fi…).
- R-32 was rewritten to cover the whole case: retries used up by a billing, credit or quota error, or a crashed worker, are an unfinished run. Retry with the Lead's feedback once service is back; never accept the partial output.
- Retired 15: thirteen near-copies of that rule from icreon's credit outage (two of them said to accept the partial output, contradicting the rest) and one crawl rule made out of date by the bounded crawl.
