## Reference: Definition of Done (homepage demo)

The demo builds the homepage, the header, the footer and the navigation, after a
whole-site audit. The Director accepts it at Gate 2 by running the drag-and-drop check in Page
builder; the demo summary's checklist lists each row with the evidence the project already has. Each
row needs its evidence, recorded as a document or Activity step. A row without evidence is
**pending**, never "passed by code review".

| Area                | Required                                                                                                                 | Evidence                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Audit               | Every sitemap URL crawled or excluded; every page, template, component and media item in the Blueprint with its decision | Page inventory, component inventory, approved Blueprint         |
| Drag and drop       | Every homepage component in the toolbox, allowed in the homepage's placeholders, and creating useful starter content     | Rendering and placeholder settings checks; the Director's check |
| Inline editing      | Text, link and image edits on the homepage persist in Page builder; list fields edited in the datasource panel           | The Director's check                                            |
| Independence        | A component dragged onto the page gets its own datasource; shared header, footer and navigation reuse is intentional     | Distinct item IDs                                               |
| Header and footer   | Partial designs on both templates; the navigation is its own component on a shared datasource                            | head.header-footer; the Director's navigation edit              |
| Genuine CMS content | Every editable field on the homepage comes from SitecoreAI; no mock data hiding missing fields                           | Field-to-component matrix and read-back                         |
| Parity              | The homepage matches the source: render, visual at three breakpoints, content                                            | Parity report                                                   |
| Media               | The homepage's and the chrome's assets load, with alt text where required                                                | Media read-back and the parity report                           |
| Code quality        | Typecheck, lint and the connected build pass on pinned dependencies                                                      | Command logs tied to the commit                                 |
| Editing host        | Correct repository, commit and host; Page builder renders the homepage without missing-component errors                  | Deployment record and the Director's check                      |
| Publishing          | The homepage reaches Experience Edge and resolves on the preview URL                                                     | Publish job record, Edge layout, route check                    |
| Security            | No credentials shipped or logged; the brief's code-extraction policy followed                                            | Configuration review                                            |

Not in the demo: the rest of the site's pages and components, redirects, sitemap and robots,
serialization, performance and accessibility audits, personalization and handover.
