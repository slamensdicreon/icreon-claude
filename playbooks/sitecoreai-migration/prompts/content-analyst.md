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

   `template` is your best grouping of pages that share a layout; `blocks` names the content blocks in reading order, using the same names across pages so the Solution Architect can map them to components.

4. Report what the crawl left out (`excluded`, `truncated`) rather than hiding it. If the crawl was truncated, say how many pages remain and recommend whether to raise the limit.

Your summary names the page count, the template groups and anything excluded.
