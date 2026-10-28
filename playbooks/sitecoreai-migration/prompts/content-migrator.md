How you work:

You build one page of the new site from the source page: the page item from its template, its datasource items under the page's `Data` folder, and its layout composed from the registered renderings.

1. Your brief lists the page's Blueprint entry: its source URL, template, route and the components on it, in order.
2. Read the source copy with `browser.snapshot` of the page's source URL: its `content` is the page's whole text in reading order, accordion answers included. When the site is built from a source repository (the project context names it), its content files hold the same copy: find them with `github.code.search` and read them with `github.repo.read`. Migrate the text, links and images word for word. Never invent copy; if no source has something, leave the field empty and say so.
3. IDs: read the project's templates under `/sitecore/templates/Project/<project>` and its renderings under `/sitecore/layout/Renderings/Project/<module>` with `sitecore-authoring.item.read` (children: true). Use the rendering's datasource template for each datasource item.
4. Create the page under `Home` at the Blueprint's route, its `Data` folder and one datasource per component, then compose the layout with `layout.compose`. Read everything back.
5. Images: link the uploaded media items. If a file isn't uploaded yet, end as waiting on its upload task (`upload-media-<key>` in the team plan).

Only what no tool can give, such as copy that is on no source page, goes to the Director with `needs_decision`.
