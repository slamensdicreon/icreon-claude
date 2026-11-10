# The site's thumbnail in the Sites dashboard

SitecoreAI shows each site as a card in the Sites dashboard. Left alone, the card is a screenshot of
the top of the site's home page, which looks unfinished. Both SitecoreAI playbooks (the website
migration and the homepage demo) give it a thumbnail made from the client's brand instead, in phase
3, right after the site is created, so the dashboard looks finished from the start.

## The task

`site-thumbnail` (Deployment Engineer, depends on `create-site`, acceptance `site.thumbnail`):

1. `browser.brand.thumbnail` reads the source home page's logo (an image or inline SVG in the
   header), colours, typeface, headline and hero photo, and renders a 1200×640 PNG in one design: a
   field with the logo, an eyebrow and the headline, and the hero photo behind a diagonal edge in
   the brand's accent. The agent adds what the page can't say: `eyebrow` (what the business does)
   and a `motif` from its line of work (`route`, `grid`, `lines`), and `chip: "Demo"` for a demo
   build. It can override anything the page gets wrong: headline and emphasis, colours, tone,
   font, logo or photo.
2. `sitecore-authoring.site.thumbnail` uploads the PNG to the site's media folder,
   `/sitecore/media library/Project/<collection>/<site>/System/site-thumbnail-<hash>`, and points
   the site item's `__Thumbnail` at it, as the dashboard does when someone uploads a thumbnail by
   hand. The image is named after its content: the same image is never uploaded twice (Sitecore
   won't upload over an existing media item), and earlier generated thumbnails move to the Recycle
   Bin.
3. `site.thumbnail` (the check) passes when the site points at its generated thumbnail at full size,
   or at one the Director set by hand in the dashboard. It fails when the dashboard would show a
   screenshot.

## How the design is chosen

- **Tone.** A brand with a deep colour of its own (a navy, a forest green) gets it as a dark field
  with its logo in white. A brand whose header is dark keeps that. Others stay light, as their logos
  were made for.
- **Accent.** The page's most used saturated colour that stands out on the field. It is used for
  the edge, the rule and any emphasised words.
- **Headline.** The page's h1, or its title. Capitals become sentence case, and the type shrinks
  to fit the column, so words never break.
- **Photo.** The largest picture near the top of the page, then the page's share image. The
  first one that loads is used; without one, soft glows in the brand's colours fill the side.
- **Safety.** A logo copied from the client's page loses scripts, event handlers and embedded
  HTML before it is rendered. Photo URLs are escaped where the render script reads them.

The design follows the hand-made set for the nine sites in the `brands` collection (November 2026),
which were set the same way.
