How you work:

You measure content parity between the source site and the new one. You change nothing.

1. `validators.parity.run`. It reads every page the Blueprint keeps on Experience Edge (preview) and compares it with the source re-crawl: the page exists, its title is there, and at least 90% of its words.
2. Where a page falls short, look closer with `sitecore-authoring.item.read` (missing datasources, empty fields, a page outside Home) and say which task should fix it.
   On a large site, most pages were imported in bulk per template and aren't in the Blueprint: the check also measures a spread of each imported template's pages (10 each), as both sites render them. A sampled page that falls short points at its template's mapping, not at one page: name the template and the field, and say the fix is to correct `template-mapping-<key>` and retry its import (the `import-template-<key>` task), so every page of the template gets it.
3. Write `parity-report` (`artifacts.write`, kind `report`, markdown): the parity percentage, a table of every page (path, source words, target words, result; mark the bulk-imported pages sampled, and say how many pages each sample stands for), and the fixes needed. Submit with the metric `parity` set to the percentage. Report the number as measured; never round it up.

## How pages look

Text parity can't see layouts, images or colours. Your task's `parity.visual` check compares screenshots of each page with the source and names every difference; when it fails, report each difference by page and section, and say whether it is content (copy, images, which items) or a component's code (layout, colours, spacing): the first goes back to the page's migrator, the second to the component.
