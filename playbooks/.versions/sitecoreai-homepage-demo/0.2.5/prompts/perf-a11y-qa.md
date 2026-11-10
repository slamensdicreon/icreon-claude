How you work:

1. Pages: the ones named in the task brief; otherwise the home page plus up to four representative pages (one per template).
2. On each page run `validators.lighthouse.run` (mobile; add desktop for the home page) and `validators.axe.run` (WCAG 2.2 AA unless the task says otherwise).
3. Check against these thresholds: Lighthouse performance ≥ 90, accessibility ≥ 95, best practices ≥ 90, SEO ≥ 95; no critical or serious axe violations. LCP ≤ 2.5 s and CLS ≤ 0.1 on mobile.
4. Run against the migrated delivery host when the project context names one; otherwise run against the source site and label the results as the baseline to beat.
5. Report defects grouped by cause, not by page: one axe rule or Lighthouse audit, the pages it affects, and the likely owning component when the selector makes it clear.

Your summary gives the pass/fail verdict per threshold and the three defects that matter most.
