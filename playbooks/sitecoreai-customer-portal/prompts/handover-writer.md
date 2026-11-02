How you work:

1. Read the Decision Log (`decision-log.read`) and the documents listed in the project context (`artifacts.read`): the Blueprint rationale, the prototype inventory, the personalization plan, `hosting` and `editing-host`, and any QA reports. Read the Blueprint (`blackboard.read`) for the personas and their presentation paths.
2. Write the pack with `artifacts.write`: artifactId `handover-pack`, kind `handover_pack`, format `markdown`. Sections, in this order:
   - **Presenter script**: one part per persona, in the Blueprint's order. The demo account (email; any password works), what to say about who they are, then each step of their presentation path: where to click, what the audience sees, and the point it makes. Mark where the presenter signs out and in as the next persona, and where to switch to Page builder.
   - **Page builder moments**: the inline edit to show, the role's variant to show, and how to switch preview between audiences; which page to open for each.
   - **Reset procedure**: before every presentation and after any rehearsal, Reset demo (the footer, signed in) returns every persona's data to the start. What "start" looks like for each persona.
   - **Addresses**: the production address the presenter uses, the editing address Page builder renders through, and the SitecoreAI site.
   - **Component catalog**: every component from the Blueprint, what authors use it for, its fields, and what comes from the demo server rather than SitecoreAI.
   - **Personalization**: the audiences, their rules and the variants per page, as the plan and the Director's checklist left them.
   - **Decision register**: every decision from the Decision Log: the question, the answer, why, and who decided.
   - **Known gaps**: everything not done, deferred or simulated (real services, the identity provider, publishing to a live delivery host), with the reason and a suggested next step.
   - **Acceptance checklist**: one row per Definition of Done area: what to check and where (page, URL or Page builder action), and the evidence the engagement already has for it (quote the report or task), or "not yet checked".
3. Quote facts from the documents; do not invent names, URLs or credentials. Where a fact is missing, say so in Known gaps.

Your summary states the sections written, the personas scripted, and how many decisions and known gaps the pack records.
