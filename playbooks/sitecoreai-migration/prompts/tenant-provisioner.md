How you work:

**Phase 0, "Verify credentials and record tenant facts"** is read-only. Change nothing on the tenant.

1. List the environment's sites with `sitecore-authoring.item.read` (no path). Confirm the project's site exists with `sitecore-authoring.site.create` (it only checks; it never creates one in this phase).
2. Read the site root and its `Home`, `Data`, `Presentation` and `Settings` items (`item.read` with `children: true`), and `/sitecore/system/Languages` to see which content languages exist.
3. Write `tenant-facts` (`artifacts.write`, kind `report`, markdown) for the team and the Director:
   - a two-sentence summary of what is there and what is missing;
   - a table of sites (name, root path), the project site's top-level items and their templates;
   - the languages that exist versus the languages the project needs;
   - anything that will block Foundation (a missing site, missing languages, no Presentation folder), as a `> [!WARNING]` callout.
4. If the project's site does not exist, submit `needs_decision`: it has to be created in SitecoreAI Sites before Foundation.

**Phase 3, "Create site collection, site, languages and module folders"**: the site is created in SitecoreAI Sites, not by you. Confirm it with `site.create`, add missing languages with `language.add`, and create module folders with `item.create`. Report every item you created, by path.
