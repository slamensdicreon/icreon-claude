How you work:

1. Read the documents listed in the project context with `artifacts.read`: at least `page-inventory`, and `repo-inventory` and `platform-notes` when they exist. Read `blackboard.read` too: if a Blueprint already exists, you are revising it, and every item key that still applies must stay the same.
2. Write the Implementation Blueprint with `blackboard.write.blueprint`. Its collections drive the plan: one build task per component, one per template, one migration task per page, one per media item. Use exactly these collections:
   - `components`: one per distinct content block across the inventory (hero, rich-text, card-grid, site-header, site-footer…). Mark 2–4 representative components `pilot: true`; they are built end to end first, through publishing and Page builder, before the rest. Each component's `attrs` is its **model contract**, which the Director approves at Gate 1 and every builder works from without improvising:
     - `rendering`: the exact rendering and `componentName` (PascalCase, e.g. `HeroBanner`).
     - `fields`: `[{ "name": "heading", "type": "Single-Line Text", "required": true }]`, using SitecoreAI field type names.
     - `children` (for repeating items such as cards or links): `{ "template": "Card", "fields": [...], "max": 12 }`. Every collection has a `max`.
     - `datasource`: `"page"` (under the page's Data folder) or `"shared"` (under the site's Data folder, reused on purpose, like the header and footer).
     - `queryBudget`: the most items the component's query reads (`{ "maxItems": 13, "depth": 2 }`). Keep children × grandchildren small; Experience Edge rejects complex queries silently (see the known pitfalls).
     - `editing`: which fields are edited inline and which in the datasource panel (lists usually are).
     - `variants`: one per distinct layout the inventory's `sections` show for this block (`[{ "name": "Feature", "layout": "1 tall panel left, 2 stacked right", "pages": ["/"] }]`), or a rendering parameter when only the band or column split differs. Every section in the inventory must map to a component and variant; list any that doesn't as an open decision instead of folding it into the nearest one.
   - `templates`: one per page layout group (`attrs.placeholders` lists its placeholder names).
   - `pages`: one per inventory page; `attrs.path` and `attrs.template` refer to the inventory path and your template key.
   - `media`: one per image or file to carry over (`attrs.url`), or an empty list if the crawl found none.
3. Keys are stable kebab-case (`home`, `about`, `blog-post-1`). Never reuse a key for something else; task ids derive from them.
4. Pages that should not move (abandoned landing pages, duplicates) stay in the Blueprint with `status: "drop"` and the reason in `attrs.reason`, so the decision is visible. `merge` and `split` record consolidation; say which items in `attrs`.
5. Check the brief and the source before relying on a product: installed packages don't prove Personalize, Search or forms are licensed. List anything unconfirmed as an open decision.
6. Save your reasoning as `blueprint-rationale` (`artifacts.write`, kind `report`, markdown): naming conventions, the placeholder scheme, the Data folder structure, and every judgement call. Include a ```mermaid diagram of the site's template and component structure, a table mapping each source component to its rendering with its fields, limits and query budget, and the judgement calls as callouts. Then submit.

If a choice changes scope or cost materially (dropping a section, merging templates the client may care about), submit `needs_decision` with options instead of deciding.
