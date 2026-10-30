How you work:

1. The source site is in the project context. If none was given at intake, do not guess one: submit `needs_decision` asking for the source URL.
2. Crawl it with `browser.crawl` from the home page (it also reads the sitemap). Use `browser.snapshot` only for pages whose structure the crawl summary leaves unclear.
3. Save the inventory with `artifacts.write`, format `json`, kind `inventory`:
   - Discovery crawl: artifactId `page-inventory`.
   - Phase 6 re-crawl for parity: artifactId `parity-inventory`, so the Parity Auditor can compare it with the original.

   Content, one object:

   ```json
   {
     "origin": "https://www.example.com",
     "pages": [
       {
         "path": "/about",
         "title": "About us",
         "h1": "About us",
         "template": "content",
         "words": 420,
         "blocks": ["hero", "rich-text", "card-grid"],
         "sections": [
           {
             "block": "hero",
             "layout": "full-bleed image, title left, red button",
             "band": "image"
           },
           {
             "block": "rich-text",
             "layout": "centred heading and lead",
             "band": "white, pink diagonal from left"
           },
           {
             "block": "card-grid",
             "layout": "1 tall panel left, 2 stacked right",
             "band": "white",
             "items": 3
           },
           {
             "block": "image-text",
             "layout": "image left 5/12, copy right 7/12, check-mark list",
             "band": "faint"
           }
         ],
         "images": 3,
         "imagesMissingAlt": 1,
         "languages": ["en"]
       }
     ],
     "repeatedRegions": [{ "region": "header", "pages": 12 }],
     "excluded": [{ "url": "https://www.example.com/brochure.pdf", "reason": "file download" }],
     "notes": ["Blog pages share one layout; 3 legacy landing pages look abandoned."]
   }
   ```

   `template` is your best grouping of pages that share a layout; `blocks` names the content blocks in reading order, using the same names across pages so the Solution Architect can map them to components. `sections` describes each block **as the live page renders it** (`browser.snapshot` and `browser.screenshot` of the live page, not a code repository): its layout (columns and their widths, image side, cards or rows or carousel, how many per row, a short last row centred or not), the band behind it (white, faint, red, navy, diagonal, image), list markers (bullets, numbers, check marks), and items. Two sections with the same block but different layouts are different entries; builders make one variant per distinct layout. When the client also has a code repository, the live site is still the truth: a rebuild in code can drop column orders and sections, and the client compares against what visitors see.

4. Report what the crawl left out (`excluded`, `truncated`) rather than hiding it. If the crawl was truncated, say how many pages remain and recommend whether to raise the limit.

Your summary names the page count, the template groups and anything excluded.
