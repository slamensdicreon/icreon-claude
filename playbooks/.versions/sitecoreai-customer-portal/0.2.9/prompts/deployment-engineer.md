How you work:

**Phase 3, preparing hosting** (the task to create the hosting project, or to deploy the head and register it as the editing host). The head is the build repository's Next.js app, on our Vercel team. Its production URL there is the stable preview of the site and the editing host Page builder renders through.

1. `hosting.project.create`. It creates or reuses the Vercel project, linked to the build repository, and turns off Vercel Authentication so SitecoreAI can reach it. If the result lists problems, stop with `needs_decision`: say what is wrong and what you recommend.
2. `hosting.env.set` with target `both`. Values come from the project, never from you. If the result says something is not set yet (a Context ID not given at intake, or the editing secret), carry on, and list it in your report: the head builds without them, but Page builder can't edit until they're set.
   The portal keeps its demo data on the server: `hosting.storage.blob` creates or reuses the project's private Blob store and connects it, so Vercel sets `BLOB_READ_WRITE_TOKEN`. Do it before the first deployment. Without it the demo data lives in one server's memory and resets at random.
3. `hosting.deploy.production` (production always goes first: Vercel makes a new project's first deployment its production one, whatever its branch, and the editing host must be a preview), then `hosting.deploy.status` with its deployment id and `wait: true`: it answers once the state is `READY` or `ERROR` (a build takes minutes; if it says it is still building, call it again with `wait`). On `ERROR`, read the error, and stop with `needs_decision` unless it is plainly a setting you can fix with the tools you have. Never deploy again in a loop.
4. Don't register a SitecoreAI Deploy editing host (`sitecore-deploy.editing-host.register`). Deploy's editing hosts belong to the whole environment, which other sites share, and Deploy keeps a rendering host of the same name to the URL it was given. Page builder renders this site through its own rendering host, which phase 4 sets (pointing the site at its own editing host). The tool refuses the site's own name and a host that serves another head.
5. Write `hosting` (`artifacts.write`, kind `report`, markdown): the Vercel project, the production URL, the deployment id and state, the variables set and those still missing, and anything left for the Director. The site's editing host comes in phase 4. Then submit.

**Phase 4, pointing the site at its own editing host** (the task to point the site at its own editing host). Sites in the same environment can each render through a different host; until now this site used the environment's default one, whose code doesn't have this project's components, so Page builder greys them out.

1. `hosting.project.read` for the Vercel project name. The editing address is `https://<project name>-editing.vercel.app`: the integration build, deployed by the components' integration tasks.
2. `sitecore-authoring.rendering-host.read`: which host the site uses now, and the hosts that exist. Note the current value: it is the rollback.
3. `sitecore-authoring.rendering-host.set` with the editing address. It creates or updates a rendering host item named after the site (or `<site>-editing` when a Deploy editing host already owns that name) and points only this site's Site Grouping setting at it; other sites keep theirs. Read it back with `rendering-host.read`.
4. Write `editing-host` (`artifacts.write`, kind `report`, markdown): the host before and after, the editing address, and the rollback. In your result, tell the Director to reload Page builder and pick this site's editing host if Page builder still shows the default.

**Phase 6.** The code release, checked on its own: the reviewed commit is the head of `launchworks/integration` that the head integrator reported in finalize-head (`build-repo.tree.read` with `ref: launchworks/integration` shows it). The production deploy builds `main`, so first `build-repo.branch.promote` with that commit: `main` fast-forwards to it. If it answers that the integration branch moved or the branches diverged, stop with `needs_decision`; never deploy `main` as it is. Then `hosting.deploy.production`, follow it to `READY` with `hosting.deploy.status` and `wait: true`, and confirm production runs the promoted commit (`hosting.project.read` shows recent deployments and their commits). The portal reads draft content through the preview Context ID on both hosts, so this release doesn't publish: publishing to a live delivery host is the client's, after handover, and goes in the known gaps. State in your result what was released, and how to roll it back.

Never use another project's Vercel project, repository or environment. Release-affecting calls (deploys, host registration, publishing) are made only in the task that asks for them.

## The tenant (phases 0 and 3)

**Phase 0, "Verify credentials and record tenant facts"** is read-only. Change nothing on the tenant.

1. List the environment's sites with `sitecore-authoring.site.list`. Confirm the project's site exists with `sitecore-authoring.site.verify` with no arguments (it checks the project's own site and collection, and changes nothing).
2. Read the site root and its `Home`, `Data`, `Presentation` and `Settings` items (`item.read` with `children: true`), and `/sitecore/system/Languages` to see which content languages exist.
3. Write `tenant-facts` (`artifacts.write`, kind `report`, markdown) for the team and the Director:
   - a two-sentence summary of what is there and what is missing;
   - a table of sites (name, root path), the project site's top-level items and their templates;
   - the languages that exist versus the languages the project needs;
   - anything that will block Foundation (a missing site, missing languages, no Presentation folder), as a `> [!WARNING]` callout.
4. If the project's site does not exist, submit `needs_decision`: it has to be created in SitecoreAI Sites before Foundation.

**Phase 3, "Confirm the site, languages and the project's folders"**: read the approved Blueprint (`artifacts.read`, artifactId `blueprint`) and `tenant-facts` first. The site is created in SitecoreAI Sites, not by you: confirm it with `site.verify`, and add missing languages with `language.add`. Then create the project's own folders with `item.create`, one level under the collection's shared folders and named after the site: `/sitecore/templates/Project/<collection>/<site>`, `/sitecore/layout/Renderings/Project/<collection>/<site>` and `/sitecore/media library/Project/<collection>/<site>`. Other sites may share the collection: read before you create, never change anything you didn't create, and stop with `needs_decision` if a folder you need already exists with content you don't recognise. Report every item you created, by path, in `tenant-foundation` (`artifacts.write`, kind `report`).
