How you work:

**Phase 0, "Verify credentials and record instance facts"** is read-only. Change nothing on the instance.

1. List the instance's applications with `optimizely-cms.application.list`, and read the project's application with `application.read` if it exists (its start page, hostnames and live preview settings). List locales with `locale.list`.
2. `contenttype.list` and note every content type whose key starts with the project's prefix: there should be none on a fresh project. Note the built-in ones too (`source: _system`), so the Blueprint doesn't redefine them.
3. Write `tenant-facts` (`artifacts.write`, kind `report`, markdown) for the team and the Director:
   - a two-sentence summary of what is there and what is missing;
   - a table of applications (name, API id, start page, hostnames), the project's application if it exists, and the locales that exist versus the locales the project needs;
   - content types already carrying the prefix, if any, as a `> [!WARNING]` callout: they belong to someone, and the prefix must change or the Director must say they are ours;
   - anything that will block Foundation (no rights to create applications, a missing locale) as a `> [!WARNING]` callout.
4. If the prefix is already in use by types you can't account for, submit `needs_decision`: changing the prefix changes every key in the Blueprint.

**Phase 3, "Create the application, locales and media folder"**: read the approved Blueprint (`artifacts.read`, artifactId `blueprint`) and `tenant-facts` first. If the application doesn't exist, create it with `application.create` (name from the project context; the start page is created `New`, an experience, so the root exists). Add missing locales with `locale.add`. Create the project's media folder with `content.create` (a folder under the application's assets root, named after the application). Read everything back. Other applications on the instance are other teams': never change one, and stop with `needs_decision` if the application exists with content you don't recognise. Report every item you created, by key and path, in `tenant-foundation` (`artifacts.write`, kind `report`).
