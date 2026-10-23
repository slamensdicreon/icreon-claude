## Reference: Definition of Done

Gate 2 accepts the site against every row. Each row needs its evidence, recorded as a document or
Activity step. A row without evidence is **pending**, never "passed by code review". Budgets come
from the brief; don't set a budget after testing to declare a pass.

| Area                | Required                                                                                                                         | Evidence                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Brand fidelity      | Approved section order, tokens, imagery, typography, distinctive behaviour                                                       | Reference comparison at the agreed desktop and mobile sizes |
| Responsive          | No horizontal overflow, clipped controls, unreadable text or broken menus at supported widths                                    | Screenshots and interaction checks                          |
| Accessibility       | Keyboard operation of menus, search and hero; visible focus; Escape and focus return; labels, alt text, contrast; reduced motion | Automated report plus a manual journey record               |
| Genuine CMS content | Every agreed editable field comes from SitecoreAI; no mock data hiding missing fields                                            | Field-to-component matrix and sample read-back              |
| Inline editing      | Text, link and image edits persist in Page builder; list fields edited in the datasource panel                                   | Page builder session evidence                               |
| New component       | Every reusable rendering is in the toolbox and creates useful starter content                                                    | A fresh datasource created from the branch                  |
| Collections         | Adding, removing and reordering children changes the display within documented limits                                            | Before and after item and page evidence                     |
| Independence        | Editing a new page's datasource leaves other pages unchanged; shared header and footer reuse is intentional                      | Distinct item IDs and a before/after comparison             |
| Empty states        | Missing datasource, cleared optional fields, missing media and empty lists stay usable                                           | Visitor and editor checks                                   |
| Routes              | Home, a child page, a language route and an unknown route behave correctly                                                       | HTTP status and rendered page                               |
| Navigation          | Every CTA, anchor, social, support and legal link goes to a real, approved destination                                           | Destination audit; no placeholders                          |
| Search              | Suggestions and select actions work; the real search scope is disclosed                                                          | Keyboard and destination checks                             |
| Media               | Assets load; rights and provenance known; alt text where required; responsive loading and motion policy work                     | Media inventory and network checks                          |
| Serialization       | The project's definitions, content and media references replay into a clean target                                               | Replay record                                               |
| Code quality        | Typecheck, lint and the connected build pass on pinned dependencies                                                              | Command logs tied to the commit                             |
| Editing host        | Correct repository, commit and host; Page builder renders without missing-component errors                                       | Deployment record and Page builder session                  |
| Publishing          | Definitions and content reach Experience Edge; visitors see the published version                                                | Publish job record, Edge layout, public route check         |
| Security            | No credentials shipped or logged; least privilege; the brief's code-extraction policy followed                                   | Configuration review                                        |
| Performance         | The brief's route, image and JavaScript budgets met on representative devices                                                    | Measured report against the budget                          |
| Handover            | Editor guide, component limits, release and rollback runbook, ownership, known exclusions                                        | Approved handover pack                                      |
