## Reference: Definition of Done (customer portal)

The Director accepts the portal against every row at Gate 2, on production and in Visual
Builder; the handover pack's UAT checklist lists each row with the evidence the project already
has. Each row needs its evidence, recorded as a document or Activity step. A row without
evidence is **pending**, never "passed by code review".

| Area                  | Required                                                                                                                                 | Evidence                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Access                | The API key writes content, not only content types: its content rights on the Root confirmed before Gate 1, or proven by earlier content | The phase 0 confirmation; the application's creation                  |
| Presentation path     | Each persona signs in, walks every step of their path (forms submit, lists update, drawers open) and signs out, with no error            | The Director's walkthrough per persona, on production                 |
| Reset                 | Reset demo returns every persona's data to the documented starting state                                                                 | Before and after the reset                                            |
| Sign-in               | The sign-in screen looks like the prototype's; only the demo accounts sign in; signed-out visitors reach only the sign-in screen         | portal.sign-in on the editing address, portal.production              |
| Role navigation       | Each persona's navigation shows only their pages, in the Blueprint's order; their journeys only                                          | Screenshot per persona                                                |
| Content by role       | A section set to one role shows to that role alone; each persona sees their own sections and none of another role's                      | portal.role-content, the role content plan, each persona's dashboard  |
| Optimizely owns words | Every heading, label, help text, link and image a component shows comes from a property; none hard-coded                                 | Property-to-component matrix and an inline edit per component         |
| Inline editing        | Text, link and image edits persist from live preview; Visual Builder previews every section, each role's tagged, without errors          | head.preview-route; the Director's Visual Builder session             |
| Add a section         | Every portal component is offered as a section, with a default display template of its own and its column and Shown to settings          | types.pushed, editor.element-enabled; the Director's check            |
| Shared instance       | Every content type and display template key carries the project's prefix; nothing of another team's changed; no push with `--force`      | Key list from the CMS; the push records                               |
| Content model         | Lives in the repository's model files and replays from them                                                                              | manifest.replays: the dry run and the CMS's export, compared          |
| Data integrity        | No screen shows another persona's or a placeholder persona's data, even while loading                                                    | Loading-state checks per persona                                      |
| Empty states          | Empty properties, empty lists and finished task lists stay usable                                                                        | Visitor and editor checks                                             |
| Prototype fidelity    | Each screen's layout, tokens, imagery and interactions match the prototype at desktop and mobile widths                                  | Side-by-side screenshots                                              |
| Accessibility         | Keyboard operation of navigation, forms, drawers and menus; visible focus; Escape closes; labels, alt text and contrast meet the brief   | Automated report plus a manual journey record                         |
| Editing host          | The editing address runs the integration build; Vercel Authentication off; Visual Builder renders pages through `/preview`, signed out   | Deployment record, the application's hosts and the Director's session |
| Release               | Production runs the reviewed commit; every page is published and in Optimizely Graph; the demo data store is private and connected       | deploy.commit-matches, graph.published, portal.production             |
| Security              | No credentials or session secrets shipped or logged; the REST API key never on the host; the brief's code-extraction policy followed     | Configuration review                                                  |
| Handover              | Presenter script per persona, reset procedure, Visual Builder moments, component catalog and known gaps                                  | Approved handover pack                                                |
