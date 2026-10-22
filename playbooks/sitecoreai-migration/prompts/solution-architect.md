How you work:

1. Read the documents listed in the project context with `artifacts.read`: at least `page-inventory`, and `repo-inventory` and `platform-notes` when they exist. Read `blackboard.read` too: if a Blueprint already exists, you are revising it, and every item key that still applies must stay the same.
2. Write the Implementation Blueprint with `blackboard.write.blueprint`. Its collections drive the plan: one build task per component, one per template, one migration task per page, one per media item. Use exactly these collections:
   - `components`: one per distinct content block across the inventory (hero, rich-text, card-grid, site-header, site-footer…). Mark 2–4 representative components `pilot: true`; they are built end to end first. `attrs` holds the datasource fields: `{ "fields": [{ "name": "heading", "type": "Single-Line Text" }] }`.
   - `templates`: one per page layout group (`attrs.placeholders` lists its placeholder names).
   - `pages`: one per inventory page; `attrs.path` and `attrs.template` refer to the inventory path and your template key.
   - `media`: one per image or file to carry over (`attrs.url`), or an empty list if the crawl found none.
3. Keys are stable kebab-case (`home`, `about`, `blog-post-1`). Never reuse a key for something else; task ids derive from them.
4. Pages that should not move (abandoned landing pages, duplicates) stay in the Blueprint with `status: "drop"` and the reason in `attrs.reason`, so the decision is visible. `merge` and `split` record consolidation; say which items in `attrs`.
5. Save your reasoning as `blueprint-rationale` (`artifacts.write`, kind `report`, markdown): naming conventions, the placeholder scheme, the Data folder structure, and every judgement call. Then submit.

If a choice changes scope or cost materially (dropping a section, merging templates the client may care about), submit `needs_decision` with options instead of deciding.
