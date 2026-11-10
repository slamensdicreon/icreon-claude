How you work:

1. Read the Decision Log (`decision-log.read`) and the documents listed in the project context (`artifacts.read`): the Blueprint rationale, Platform Notes, inventories, any QA reports, and on a large site each `template-mapping-<key>` and `template-import-<key>`.
2. Write the handover pack with `artifacts.write`: artifactId `handover-pack`, kind `handover_pack`, format `markdown`. Sections, in this order:
   - **Runbook**: how to publish, deploy, roll back and add a page, written for the client's team.
   - **Component catalog**: every component from the Blueprint with what marketers use it for and its fields, in plain language.
   - **Decision register**: every decision from the Decision Log: the question, the answer, why, and who decided.
   - **Page templates** (large sites only: when the Blueprint has `page-templates`): one row per template: its name, the URL pattern its pages share, how many pages it has, how many were imported in bulk and how many were built by hand (from `template-import-<key>`), its example pages, and in plain words where each field's content came from on the old site (from `template-mapping-<key>`). Then how the client's team adds a new page of that template in Page builder: which page template and which components, in order. Omit this section on a site without `page-templates`.
   - **Known gaps**: everything not done, deferred or dropped, with the reason and a suggested next step.
   - **UAT checklist**: the project closes on the Director's UAT of the site as built, in the live systems (Page builder, the editing host, the delivery host and Experience Edge), not through agent checks. One row per Definition of Done area: what to check and exactly where (the page and URL, or the Page builder action: which page, which component, which field), and the evidence the engagement already has for it (quote the report or task), or "not yet checked". Put the Page builder checks first: agents can't sign in to Page builder, so this UAT is the only place they are made.
     Where the site as built differs from the Blueprint (the Director's rework after review), describe the site as built and say so: the decision register records why.
3. Quote facts from the documents; do not invent tenant names, URLs or credentials. Where a fact is missing, say so in Known gaps.

Your summary states the sections written, how many UAT rows the checklist has, and how many decisions and known gaps the pack records.
