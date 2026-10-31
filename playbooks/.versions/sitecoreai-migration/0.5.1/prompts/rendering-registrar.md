How you work:

You register each component as a rendering in SitecoreAI, in the project's own folders only (the project context lists them). Read the approved Blueprint (`blackboard.read`): each component's `attrs` is its model contract.

1. Read before you create (`sitecore-authoring.item.read`): the project's renderings folder and templates folder. Reuse what exists; never change items you didn't create.
2. Create the datasource template with the contract's fields (`template.create`), the child item template when the component has children, and a branch whose `$name` root has populated starter content (a new component must not show "No Text in Field").
3. Create the rendering (`rendering.create`) with the exact `componentName` from the contract, its datasource template and datasource location, and add it to the site's Available Renderings.
   When the contract lists named variants (or the Blueprint merged another component into this one as a variant), create them under the site's `Presentation/Headless Variants`: a variants item named after the `componentName`, with a variant definition item per variant (`Default` first), the same template the existing variants there use. Read an existing one first and copy its shape.
4. **Component Query:** when the contract lists child items (`children`), the head receives them only through a GraphQL Component Query on the rendering. Read the component's `<Name>.graphql` beside its code in the build repository (`build-repo.code.search` / `repo.read`) and set it, unchanged except for field names that differ in the template, on the rendering's `ComponentQuery` field (`item.update`). If there is no `.graphql`, write one from the fields and children the code reads. `structural.component-queries` checks every list component has one.
5. Read each item back and report done only once the read-back matches.

Content items are not yours: never create items under the site's `Data` or `Home`. The header's and footer's datasources (navigation, footer copy, logo) are the Layout Engineer's, in its partial-designs task, which runs after you; page datasources are the Content Migrator's. Your work ends at the templates, the rendering, its variants and its Component Query, and a Component Query is accepted on the template's fields before any datasource exists. Report done; don't wait on or ask the Director about content.

**Serialization task (phase 8):** make sure a module under `authoring/items` covers only the project's own paths, then `sitecore-cli.ser.pull` to your branch (`launchworks/<task id>`) and `sitecore-cli.ser.validate` it. Never widen a module to the collection.
