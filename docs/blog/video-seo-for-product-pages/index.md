# Video SEO for product pages: VideoObject schema, done right

July 18, 2026 · Video Marketing for Software · 6 min read · https://aidemo.top/blog/video-seo-for-product-pages/

> Google names three required VideoObject properties, not thirty. The copy-paste JSON-LD that nests a demo into Product schema, and what the markup really buys.

**Key takeaways**

- Google requires only three VideoObject properties (name, thumbnailUrl, uploadDate) and recommends contentUrl, description, duration, and embedUrl; the rest is optional.
- A product page is not a "watch page," so VideoObject markup will not turn the product listing into a video result; it makes the clip eligible for Google’s video surfaces instead.
- Link Product and VideoObject with subjectOf/about in a JSON-LD @graph; Product has no built-in video property, so mis-nesting is the common mistake.
- contentUrl must point at a crawlable video file at a stable URL: Vidio’s VideoObject markup drove ~3x video impressions and ~2x clicks (Q1 2022 to Q1 2023).
- MX Player added video structured data plus frequent video sitemaps and saw 3x organic traffic in 6 months; markup makes a video eligible, it does not guarantee ranking.

## Your product page is not a watch page

Search advice about video treats every embedded clip as if it were a YouTube page, and that is the mistake that wastes the markup. Google draws a hard line the guides skip. Its video documentation defines a watch page as one whose "main purpose is to show users a single video," and says plainly that pages where the video is secondary, a blog post or a product page with an embedded demo, "aren't watch pages, though they can still appear as text or image results" ([Google, 2026](https://developers.google.com/search/docs/appearance/video)). That single distinction rewrites the task. On a product page the product is the main content: the price, the offer, the rating. The demo is a supporting act. So the point of VideoObject markup on a product page is not to turn the product's listing into a video result, which Google will not do, but to make the clip itself findable in Google's dedicated video places while the product listing stays a product listing. Get that straight and the rest of the markup follows; get it wrong and you chase a video rich result the page was never eligible for. Everything below assumes that framing: the markup exists to feed the crawler, not to redecorate the page for a human who is already reading it. This is the structured-data corner of turning [one recording into every channel](/blog/video-marketing-for-software).

## The three properties Google actually requires

Most VideoObject snippets in the wild carry twenty properties because someone pasted a reference dump. Google requires three. Its structured-data guide lists exactly `name`, `thumbnailUrl`, and `uploadDate` as required, and marks everything else, including the ones people assume are mandatory, as recommended ([Google, 2026](https://developers.google.com/search/docs/appearance/structured-data/video)).

| Property | Google status | Format | Why it matters for a demo |
| --- | --- | --- | --- |
| `name` | Required | Text, unique per video | The title Google shows; reuse it across clips and you compete with yourself |
| `thumbnailUrl` | Required | Crawlable image URL, min 60x30 px | The frame a searcher sees; a login screen or a spinner here costs the click |
| `uploadDate` | Required | ISO 8601 with timezone | A freshness signal; a stale date reads as a stale product |
| `contentUrl` | Recommended | URL to the video file bytes | The property that actually makes the video indexable, below |
| `description` | Recommended | Text, unique per video | Indexable copy; write it for the query, not the file name |
| `duration` | Recommended | ISO 8601, e.g. `PT1M30S` | Sets the length badge; a 90-second demo should say 90 seconds |
| `embedUrl` | Recommended | URL of the player, not the page | The iframe `src`, and distinct from `contentUrl` |

The two to never skip despite their "recommended" label are `contentUrl` and `description`, for reasons the next sections make concrete. And read the `thumbnailUrl` row twice: Google wants a crawlable image at least 60x30 pixels, larger preferred, at a stable URL, and the thumbnail is the single most visible thing about your clip in a results page, so [the frame you choose is a decision, not a default](/blog/demo-video-thumbnail).

## A VideoObject that validates, then nests into Product

Here is a complete, valid VideoObject with every required property and the recommended ones worth carrying:

```json
{
  "@context": "https://schema.org",
  "@type": "VideoObject",
  "name": "Acme Analytics: build a live dashboard in 90 seconds",
  "description": "A 90-second walkthrough of creating a shareable dashboard in Acme Analytics, from empty state to a public link.",
  "thumbnailUrl": ["https://acme.example/video/dashboard-poster-1280x720.jpg"],
  "uploadDate": "2026-07-18T08:00:00-07:00",
  "duration": "PT1M30S",
  "contentUrl": "https://acme.example/video/dashboard-demo.mp4",
  "embedUrl": "https://acme.example/player/dashboard-demo"
}
```

Now the part the guides get wrong. Product has no video property, and Google's Product structured-data documentation never mentions nesting a video inside it ([Google, 2026](https://developers.google.com/search/docs/appearance/structured-data/product)). schema.org's actual answer is a pair of linking properties: a VideoObject is `about` the Product, and the Product has the video as its `subjectOf`. VideoObject inherits `about` from CreativeWork, and Product inherits `subjectOf` from Thing ([schema.org, 2026](https://schema.org/VideoObject)). The clean way to express that is one `@graph` with two nodes cross-referenced by `@id`:

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Product",
      "@id": "https://acme.example/analytics#product",
      "name": "Acme Analytics",
      "image": "https://acme.example/img/analytics-1200x1200.jpg",
      "offers": {
        "@type": "Offer",
        "price": "49.00",
        "priceCurrency": "USD",
        "availability": "https://schema.org/InStock"
      },
      "subjectOf": { "@id": "https://acme.example/analytics#demo" }
    },
    {
      "@type": "VideoObject",
      "@id": "https://acme.example/analytics#demo",
      "name": "Acme Analytics: build a live dashboard in 90 seconds",
      "thumbnailUrl": ["https://acme.example/video/dashboard-poster-1280x720.jpg"],
      "uploadDate": "2026-07-18T08:00:00-07:00",
      "duration": "PT1M30S",
      "contentUrl": "https://acme.example/video/dashboard-demo.mp4",
      "embedUrl": "https://acme.example/player/dashboard-demo",
      "about": { "@id": "https://acme.example/analytics#product" }
    }
  ]
}
```

The common failures are inventing a `video` property on Product, or dropping the VideoObject somewhere a parser cannot associate it with anything. Link the two nodes explicitly and both stay valid on their own.

## contentUrl is what makes the video indexable, not the embed

The property that does the heavy lifting is `contentUrl`. Google's best-practices doc is blunt that it can only index a video whose file it can fetch: the video has to be reachable through a standard `<video>`, `<iframe>`, `<embed>`, or `<object>` element, in a supported format, at a stable URL, with the bytes crawlable rather than gated behind a click or a login ([Google, 2026](https://developers.google.com/search/docs/appearance/video)). `embedUrl` points at your player; `contentUrl` points at the actual file, and it is the file Google indexes. This is not theory. In Google's own case study, Vidio added VideoObject markup with `contentUrl` and stable, crawlable file URLs, validated it with Search Console's video report, and between Q1 2022 and Q1 2023 saw video impressions rise about 3x and video clicks close to 2x on Search ([Google, 2023](https://developers.google.com/search/case-studies/vidio-case-study)). The lesson is not the size of the number, it is the cause: they made the file reachable. If your demo is a YouTube embed, `contentUrl` is Google's and you inherit its indexing; if you self-host, `contentUrl` is yours to keep stable, which is one more reason [how you host the file is its own decision](/blog/embed-video-on-website).

## Transcripts and captions carry the words search can read

A video is opaque to a text index; the pixels say nothing a crawler can read. schema.org gives VideoObject a `transcript` property, the plain text of what is said, and a `caption` property, the timed track, both distinct from the visual content ([schema.org, 2026](https://schema.org/VideoObject)). The transcript is the one that feeds search: it is indexable copy that spells out every feature name and step the narration mentions, in the words a searcher would actually type. Captions do the accessibility job and the muted-autoplay job, which is [a discipline of its own](/blog/demo-video-captions), and because the caption text and the transcript are the same script the voice read, you produce both from one narration pass instead of two transcription passes. For a product demo whose whole pitch is spoken, publishing the transcript is the cheapest indexable-content win the page has. Upload your own rather than trusting auto-generation, for the same reason it pays off [on a developer YouTube channel](/blog/youtube-marketing-for-dev-tools): speech recognition cannot spell your product's names.

## What the markup buys, in Google's own numbers

Markup makes a video eligible to appear; it does not rank it. Both of Google's video case studies did two things at once, and neither got its result from JSON-LD alone. Vidio's gains came with a crawlable `contentUrl`. MX Player paired video structured data with frequently submitted video sitemaps and saw organic traffic triple over six months, with video page views per session doubling from Search ([Google, 2026](https://developers.google.com/search/case-studies/mx-case-study)). Correct markup plus a reachable file plus a sitemap; the schema is one leg of the tripod, not the whole thing. A video sitemap is not optional decoration here: it is how a crawler that will not run your player still learns the file exists, which is why MX Player leaned on frequent submissions rather than markup alone. And the product-page caveat from the top returns as the honest ceiling: because a product page is not a watch page, the payoff is eligibility in Video mode, the video thumbnails that appear among the main results, and Google Images or Discover, not a video result bolted onto the product's own listing. The last thing worth budgeting is drift. A VideoObject that names a duration, a thumbnail, and a transcript is a set of promises about a file, and every one of them goes stale when the UI in the clip changes. aidemo, the open-source engine this blog belongs to, re-renders the demo from a committed spec and can emit the `contentUrl`, `thumbnailUrl`, `duration`, and transcript on every build, so the markup keeps describing a UI that still exists; its honest limits are that it captures inside a browser only, an agent writes the storyboard instead of a person on a timeline, and there is no visual editor. The markup is worth exactly what the video behind it is worth, kept current.

## Sources

- [Google Search Central — Video structured data (VideoObject)](https://developers.google.com/search/docs/appearance/structured-data/video)
- [Google Search Central — Video SEO best practices (watch pages, thumbnails, contentUrl, sitemaps)](https://developers.google.com/search/docs/appearance/video)
- [schema.org — VideoObject](https://schema.org/VideoObject)
- [Google Search Central — Product structured data](https://developers.google.com/search/docs/appearance/structured-data/product)
- [Google Search Central — Vidio case study (VideoObject markup)](https://developers.google.com/search/case-studies/vidio-case-study)
- [Google Search Central — MX Player case study (video structured data and sitemaps)](https://developers.google.com/search/case-studies/mx-case-study)

## FAQ

### What are the required properties for VideoObject schema?

Google requires exactly three: `name`, `thumbnailUrl`, and `uploadDate`. Everything else, including `contentUrl`, `description`, `duration`, and `embedUrl`, is recommended rather than required. In practice you should still add `contentUrl` and `description`, because `contentUrl` is what lets Google index the file and `description` is indexable copy. The `uploadDate` must be in ISO 8601 format with a timezone, and `thumbnailUrl` must point at a crawlable image at least 60x30 pixels.

### Can a product page get a video rich result in Google Search?

Not the way a dedicated video page can. Google treats a product page as a page where the video is secondary, not a "watch page," so the markup will not turn the product listing itself into a video result. What VideoObject markup buys instead is eligibility for Google's video surfaces: Video mode, the video thumbnails that show among the main results, and Google Images or Discover. The product's own rich result stays about price, availability, and rating.

### Does video schema markup actually improve click-through rate?

It can, but through eligibility, not magic. Google's own Vidio case study reports about 3x video impressions and close to 2x video clicks after adding VideoObject markup with a crawlable `contentUrl`, measured from Q1 2022 to Q1 2023, and MX Player saw organic traffic triple in six months from structured data plus video sitemaps. Markup makes a video eligible to appear; the file still has to be crawlable and the clip still has to be worth watching for the numbers to follow.
