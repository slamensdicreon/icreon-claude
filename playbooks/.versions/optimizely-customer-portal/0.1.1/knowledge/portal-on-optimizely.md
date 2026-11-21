## Reference: a customer portal on Optimizely CMS (SaaS)

How each thing a portal does is delivered on this platform, and the contract the shell, the
components, the pages and the acceptance checks share. **None of it has run against a live
instance yet** (playbook 0.1.0): the platform's order and tools are proven by the website
playbooks, the portal's own parts below are a design. When your evidence says otherwise, trust
the evidence and say so in your result.

| What the portal does                 | Where it lives                                                                                                        | Who owns it afterwards                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Sign-in into demo personas, sessions | The head: `/api/session`, a signed cookie, the gate in `src/proxy.ts`. The sign-in screen itself is a page in the CMS | Developers (the gate); marketers (the screen's words) |
| Navigation by role                   | The head: the shell shows each persona the pages their role may open                                                  | Developers                                            |
| Pages, words, links and images       | The CMS: every page an experience, every section a content type with the project's prefix, edited in Visual Builder   | Marketers                                             |
| Content by role                      | The CMS and the head together: each section's `Shown to` display setting, read by the head for the signed-in persona  | Marketers                                             |
| Records and journeys                 | The head: a demo data service (`/api/demo`) over a private store, seeded from the prototype, with Reset demo          | Developers; real services replace it after handover   |

### The shell's contract

The acceptance checks read the portal exactly this way, so the shell must answer exactly so.

- `POST /api/session` with JSON `{ "email", "password" }`: a persona's demo email (any password)
  answers 200 and sets the session cookie (httpOnly, SameSite=Lax); any other email answers 401
  and sets none. `DELETE /api/session` signs out.
- A signed-out request for any page is redirected (307) to `/sign-in?next=<path>`. The sign-in
  screen, `/preview`, `/api/session` and static files are never gated. A path with the locale in
  front is the same page (`/en/sign-in/` is the sign-in screen, `/en/claims/` is gated).
- Every section a page renders is inside `ui/PortalSection`, whose root element carries
  `data-audience` (who the section is set for) and `data-column`.
- The session is signed with `DEMO_SESSION_SECRET` when it is set, otherwise with a key derived
  from `BLOB_READ_WRITE_TOKEN`, which Vercel sets once the Deployment Engineer has connected
  the demo data store. The team's tools set only the variables the platform gives the head, so
  nobody on the team can add a secret of the portal's own; the Director can, in Vercel.

### Content by role

The CMS alone has no audiences. A section's **display template** carries two settings a marketer
chooses in Visual Builder, the same way a website's section carries its band colour:

- `audience` (shown as **Shown to**): `everyone`, or one persona's audience
  (`business-manager`). Signed in, a persona sees the sections set to everyone and the sections
  set to their own role, in the page's order. In Visual Builder's preview every section shows,
  each role's own tagged "Shown to: …", so a marketer sees and edits all of them.
- `column`: `full`, or `main` and `side` for the two columns of a dashboard.

Rules that follow from one choice per section:

- A role's own version of a section is a second section of the same component with that role's
  copy. The one the others saw is then set to the role it is for, never left on `everyone`: the
  role with its own version would see both.
- Content two roles share and a third doesn't is placed once per role. A portal has a handful
  of roles; if a client needs many, list it as an open decision.
- A marketer gives a role its own section by duplicating one, changing its words and its
  `Shown to`, and publishing. Adding a role is a code change: the choices are the personas.
- The sections are filtered on the server. A page is rendered per request for the signed-in
  persona and never cached across personas.

**If the client has Optimizely's experimentation or personalization products** (Web
Experimentation, Feature Experimentation, Personalization), audiences and variations can live
there instead: the head would pass the signed-in role to that product as an attribute, and a
variation made in Visual Builder would replace a duplicated section. Nothing in this playbook
builds or assumes that: a licence is not proven by a brief, and no tool the team has creates an
experiment. List it as an open decision at Gate 1 and build the `Shown to` setting regardless.

### Not proven, and open

- The sign-in gate in front of `/preview`: Visual Builder opens `/preview` signed out, with a
  preview token. The gate lets that path through; that Visual Builder's frame then renders and
  refreshes as on a website is unverified until the pilot (`head.preview-route` reads it).
- `ui/PortalSection` as an async server component that reads the session, rendered inside the
  SDK's composition, and the request header the gate sets on `/preview`: ordinary Next.js, not
  yet built on this starter. If a section's `displaySettings` don't arrive as the settings'
  keys with string values, the Component Engineer says so rather than work around it.
- A section component that is a server component with a client part beside it
  (`<Name>Client.tsx`) in the starter's generated registry: the registry reads the model file
  and the component file named after the folder; helper files beside them are assumed ignored.
- How Visual Builder labels a display template's settings, and whether a duplicated section
  keeps them: checked by the Director in the UAT, by changing one section's `Shown to`.
- Visual Builder's own rows and columns could hold a dashboard's two columns, but
  `composition.write` composes whole sections, so agents could not fill them: hence `column`.
- Navigation labels and the shell's own words (Sign out, Reset demo) are code, as the role
  rules are. Moving them to a shared block is possible later.
- Real identity providers, real services and payments are never built: they are open decisions
  with a demo stand-in.
