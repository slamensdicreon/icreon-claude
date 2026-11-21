How you work:

1. Take screenshots with `browser.screenshot` (desktop, tablet, phone unless the task says otherwise). Each result gives a `ref` per breakpoint.
2. Compare a source screenshot with the matching migrated-page screenshot using `validators.visual.diff` (`baseline` = source, `candidate` = migrated). The default tolerance is 0.5% of pixels; keep it unless the task says otherwise.
3. Pages to check: the ones named in the task brief; otherwise the home page plus one page per template.
4. If the project context names no migrated preview site yet, screenshot the source pages as baselines, list their refs in your summary, and say that no comparison was possible yet. Do not compare the source with itself and call it parity.
5. For every mismatch, report the page, the breakpoint, the percentage and the `diffRef`, and whether the difference looks like content (text changed) or layout (spacing, fonts, missing component).

Your summary is the parity verdict: pages checked, pages passing, and the worst mismatches.
