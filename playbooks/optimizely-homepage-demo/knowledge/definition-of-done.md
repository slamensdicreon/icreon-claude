## Reference: Definition of Done (homepage demo)

The demo builds the homepage, the header, the footer and the navigation, after a
whole-site audit. The Director accepts it at Gate 2 by running the check in Visual Builder; the
demo summary's checklist lists each row with the evidence the project already has. Each
row needs its evidence, recorded as a document or Activity step. A row without evidence is
**pending**, never "passed by code review".

| Area                | Required                                                                                                                                               | Evidence                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Audit               | Every sitemap URL crawled or excluded and counted in the site audit; the homepage, its components and its media in the Blueprint with their decisions  | Page inventory, component inventory, approved Blueprint                     |
| Access              | The API key writes content, not only content types: its content rights on the Root confirmed by the Director before Gate 1, proven by the first write  | The phase 0 confirmation; the application's creation                        |
| Add a section       | Every homepage component is offered as a section in Visual Builder, with a default display template of its own and its settings (band, image side)     | Content type and display template read-back; the Director's check           |
| Inline editing      | Text, link and image edits on the homepage persist from live preview in Visual Builder; lists and references edited in the properties panel            | The Director's check                                                        |
| Independence        | A section added to the page holds its own content; shared header, footer and navigation reuse is intentional                                           | The page's composition; distinct keys for the shared blocks                 |
| Header and footer   | Shared blocks the homepage's experience type references; the navigation is its own block, edited once for every page                                   | head.header-footer; the Director's navigation edit                          |
| Genuine CMS content | Every editable value on the homepage comes from a content type property; no mock data hiding missing properties                                        | Property-to-component matrix and read-back                                  |
| Shared instance     | Every content type and display template key carries the project's prefix; nothing of another team's changed; no push with `--force`                    | Key list from the CMS; the push records                                     |
| Content model       | Lives in the repository's model files and replays from them: a clean `optimizely-cms-cli config push --dryRun` builds exactly what the CMS holds       | The dry-run record and the CMS's export, compared                           |
| Parity              | The homepage matches the source: render, visual at three breakpoints, content                                                                          | Parity report                                                               |
| Media               | The homepage's and the chrome's assets load, in a format the CMS takes (no avif), with alt text on the image                                           | Media read-back and the parity report                                       |
| Code quality        | Typecheck, lint and the connected build pass on pinned dependencies                                                                                    | Command logs tied to the commit                                             |
| Editing host        | Correct repository, commit and hostname; Vercel Authentication off; Visual Builder renders the homepage through `/preview` and refreshes on save       | Deployment record, the application's hostname and the Director's check      |
| Publishing          | The homepage, its shared blocks and its media are published; the homepage is indexed in Optimizely Graph on the application's host and resolves at `/` | Publish record, Graph route (`/en/` on the application's host), route check |
| Security            | No credentials shipped or logged; the REST API key never on the host; the brief's code-extraction policy followed                                      | Configuration review                                                        |

Not in the demo: the rest of the site's pages and components, blueprints for new pages, redirects,
sitemap and robots, error pages, webhooks, performance and accessibility audits, experimentation
and handover.
