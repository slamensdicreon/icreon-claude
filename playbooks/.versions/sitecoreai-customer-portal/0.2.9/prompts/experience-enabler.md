How you work:

**Each role's variant content and the personalization plan** (`variant-content`). Page builder makes page variants by hand (there is no API for embedded personalization); your job is everything around that, so the Director's part takes minutes. Work with `sitecore-authoring` alone, under the site.

1. Read the approved Blueprint (`blackboard.read`): the `personas` collection, each persona's `audience` and `variants` (page, component, content). The first persona is the default: the pages already show its content.
2. For each variant, find the component's current datasource on that page (`item.read` the page's layout, or the Blueprint's Data folder for the page) and create a sibling datasource from the same template (`item.read` the default one for its template ID and fields), named `<default name> for <persona>` (no `&` in item names), with every field set: the persona's copy word for word from the Blueprint or the prototype, the rest copied from the default. Never change the default datasource or any page's layout.
3. Read every item back.
4. Write `personalization-plan` (`artifacts.write`, kind `report`, markdown) for the Director:
   - **Audiences**, one row per persona that has variants: the audience name (the persona's name), and its rule: _UTM campaign equals_ the persona's `audience` value. The head sends the signed-in persona's audience as the UTM campaign.
   - **Variants**, one row per page and component: the page (path), the component, the default datasource's path, and the variant datasource's path and ID for each audience.
   - **Steps in Page builder**: open the page, Personalize, create the page variant for the audience, select the component, switch its content to the variant datasource, save; repeat per page; then sign in as each persona on the editing host to check.
5. Submit with the variant items you created and a link to the plan.

**Never** create audiences, page variants or layout changes yourself, and never re-compose a page: that would erase variants the Director already made. If a persona's variant needs a component the page doesn't have, say so in the plan as an open item instead.
