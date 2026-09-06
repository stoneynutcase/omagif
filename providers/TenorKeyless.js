// Tenor without an API key. See providers/README.md for the contract.
//
// This is the only way a new install can reach Tenor at all: Google stopped
// issuing Tenor API clients in January 2026, so providers/Tenor.js is
// unreachable for anyone who did not already hold a key. Reading the public
// site brings the service back.
//
// tenor.com renders its result grid server-side, one <figure> per GIF:
//
//   <figure class="UniversalGifListItem clickable"
//           data-index="3" data-width="165" data-height="183" ...>
//     <a href="/view/cat-gun-gif-12788768817999066268">
//       <picture>
//         <source type="video/mp4"   srcset="…/sXrVe29tNJwAAAP1/cat-gun.mp4">
//         <source type="image/webp"  srcset="…/sXrVe29tNJwAAAA1/cat-gun.webp">
//         <img src="https://media.tenor.com/sXrVe29tNJwAAAAM/cat-gun.gif"
//              alt="a cat with a pink bow on its head playing with another cat">
//
// which carries everything the item shape needs, and more cleanly than Giphy
// does: real dimensions rather than an aspect ratio, a descriptive alt, and
// media URLs with **no query string** — nothing request-scoped to strip, so
// they can be handed to another person as they are.
//
// Compared with providers/GiphyKeyless.js:
//
//   * ~49 results instead of ~25, but still one page. ?page=2 returns the
//     same results, so parse() always reports them exhausted.
//   * Tenor answers a nonsense query with fallback results rather than an
//     empty grid, so zero items means the markup moved, not "nothing found".
//     parse() says exactly that.
//   * Tenor's GIFs are considerably heavier — a grid averages ~17 MB against
//     Giphy's ~0.2 MB, and a full rendition can exceed 20 MB.
//
// robots.txt is `Disallow:` with nothing listed, and the search page carries
// no restrictive robots meta.
//
// Deliberately self-contained, like the other modules.

var id = "tenor-keyless"

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Only ASCII punctuation and control characters are dropped; anything above
// U+007F is kept and left to encodeURIComponent, so "feliz cumpleaños" and
// "猫" reach Tenor percent-encoded and return results.
//
// The ranges are every ASCII control and punctuation character except the
// hyphen at U+002D, which is the word separator the URL wants.
var UNSAFE = /[\u0000-\u002C\u002E\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007F]/g

function slug(term) {
  return trimmed(term)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(UNSAFE, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

// Tenor routes searches at /search/<term>-gifs. The bare /search/<term> form
// 301-redirects to it, and the picker's `curl` has no -L, so a redirect would
// arrive as an empty body — building the suffixed form is required, not tidy.
//
// An empty term means "what's popular now", which is the site's front page.
// There is no /trending path: /trending and /explore/trending both 404, and
// /search/trending-gifs is a literal search for the word.
function searchUrl(key, settings, term, limit, cursor) {
  if (trimmed(cursor)) return ""
  var slugged = slug(term)
  if (!slugged) return "https://tenor.com/"
  // Someone typing "cat gifs" should not be sent to /search/cat-gifs-gifs.
  if (!/-gifs$/.test(slugged)) slugged += "-gifs"
  return "https://tenor.com/search/" + encodeURIComponent(slugged)
}

function attr(tag, name) {
  var match = new RegExp("\\b" + name + "=\"([^\"]*)\"", "i").exec(tag)
  return match ? unescapeHtml(match[1]) : ""
}

// Tenor escapes apostrophes in alt text as numeric entities, so the numeric
// forms matter as much as the named ones. `&amp;` is decoded last: doing it
// first would turn "&amp;#39;" into an apostrophe that was never there.
function unescapeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16))
    })
    .replace(/&#([0-9]+);/g, function (_, dec) {
      return String.fromCharCode(parseInt(dec, 10))
    })
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

// Tenor names a rendition with a suffix on the media id. The grid serves
// whichever of these the browser negotiated — `AAAAM` as a GIF, `AAAAm` as a
// WebP — so both are matched and the id is rebuilt with the code we want.
//
//   AAAAS   82px    AAAAM  165px (grid)   AAAAd  338px   AAAAC  451px (full)
//
// The extension varies with it, which is why this captures base and slug and
// discards the code rather than reusing the URL as found.
var MEDIA = /<img\s[^>]*\bsrc="https:\/\/media\d*\.tenor\.com\/([A-Za-z0-9_-]+?)AAAA[A-Za-z0-9]\/([^"\/]+?)\.(?:gif|webp|png|jpg)"/i

var PREVIEW_CODE = "AAAAM"
var FULL_CODE = "AAAAC"

function media(base, slugName, code) {
  return "https://media.tenor.com/" + base + code + "/" + slugName + ".gif"
}

// Matched on the class Tenor gives every result tile. `data-index` and the
// inline `top:` are layout state and deliberately ignored.
var ITEM = /<figure\b([^>]*\bclass="[^"]*UniversalGifListItem[^"]*"[^>]*)>([\s\S]*?)<\/figure>/gi

// The post id is the trailing run of digits on the share path, which is what
// Tenor treats as the GIF's identity. The media id in the CDN URL is a
// different thing and is not stable across renditions.
var VIEW = /href="(\/view\/([^"]*?-gif-(\d+)))"/i

function item(tag, inner) {
  var view = VIEW.exec(inner)
  // Tenor drops a "upload your own GIFs" promo card into the grid with the
  // same class and no /view/ link. It is not a result.
  if (!view) return null

  var found = MEDIA.exec(inner)
  if (!found) return null
  var base = found[1]
  var slugName = found[2]

  var altMatch = /<img\s[^>]*\balt="([^"]*)"/i.exec(inner)
  var width = parseInt(attr(tag, "data-width"), 10)
  var height = parseInt(attr(tag, "data-height"), 10)

  return {
    id: view[3],
    title: altMatch ? unescapeHtml(altMatch[1]) : "",
    previewUrl: media(base, slugName, PREVIEW_CODE),
    gifUrl: media(base, slugName, FULL_CODE),
    pageUrl: "https://tenor.com" + unescapeHtml(view[1]),
    width: width > 0 ? width : 0,
    height: height > 0 ? height : 0
  }
}

function parse(raw, previousCursor) {
  var html = String(raw === undefined || raw === null ? "" : raw)

  var items = []
  var seen = {}
  var match
  ITEM.lastIndex = 0
  while ((match = ITEM.exec(html)) !== null) {
    var parsed = item(match[1], match[2])
    if (!parsed || seen[parsed.id]) continue
    seen[parsed.id] = true
    items.push(parsed)
  }

  // One page is all there is — see the header.
  if (items.length > 0) return { items: items, next: "", error: "" }

  if (!/tenor\.com/i.test(html))
    return { items: [], next: "",
             error: "Tenor returned something unreadable — it may be rate limiting this machine" }

  // Tenor answers even a nonsense query with fallback results, so an empty
  // grid is not "no matches" — it means the markup this reads has moved.
  return { items: [], next: "",
           error: "Tenor changed its page layout, so results can't be read any more — "
                  + "switch provider with Ctrl+P" }
}

// Already a clean permalink with no query string.
function shortDirectUrl(entry) {
  return trimmed(isObject(entry) ? entry.gifUrl : "")
}
