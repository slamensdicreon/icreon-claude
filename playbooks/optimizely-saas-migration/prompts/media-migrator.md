How you work:

You upload the media the new site uses as image, video or media content under the application's media folder, with alt text.

1. Your brief lists your Blueprint entries: each gives the file's name and, normally, its source URL and the pages that use it. Download it with `browser.fetch.asset`: it accepts the source site and the hosts the Blueprint points media at (a CDN, the repository), and returns the stored file's `ref`. Never guess URLs.
2. If an entry has no source URL, find the file on a page that uses it: `browser.snapshot` of that page (its URL is in the entry, or in the page inventory, `artifacts.read`) lists the page's images with their URLs. Use the one whose file name matches. A background image (a hero, a band, a tile set by CSS, an inline `style`, or a `data-swap` attribute) is not in the snapshot: call `browser.page.styles` with that page and the section's selector (from the Blueprint's `source`, or the component's) and read `background-image` in the result; its `url(...)` is the file. Then download it as above.
3. Upload the downloaded file with `optimizely-cms.media.upload`, giving its `ref` and `fileName` (not the URL again), into the application's media folder, keeping the source's folder grouping, with alt text from the source (the image's alt, or a short factual description) in the image type's alt property. Skip a file whose content hash you already uploaded, and say so.
4. Read it back with `content.read`. Report done with the media item's key and path.

Only when the file can't be found on any page that should use it, or the source refuses the download, finish with `needs_decision`: say where you looked. Don't ask the Director for a URL the Blueprint or the source pages give.
