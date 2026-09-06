// Giphy without an API key. See providers/README.md for the contract.
//
// Giphy's REST API wants a key on every request — the old public beta key
// (dc6zaTOxFJmzC) now answers 403 BANNED — so this module reads the public
// search page instead. giphy.com renders its result grid server-side, one
// anchor per GIF:
//
//   <a href="https://giphy.com/gifs/cat-sigma-15UbO1LY4O2Fxw8gnI"
//      data-giphy-id="15UbO1LY4O2Fxw8gnI"
//      data-giphy-is-sticker="0"
//      style="width:251px;…;aspect-ratio:0.92" …>
//     <picture>…<img … alt="Sigma Cat Gif GIF"/></picture>
//   </a>
//
// which carries everything the item shape needs: the id, the canonical share
// link, the shape of the tile, and a human title. The media URLs in that markup
// are deliberately *not* reused — they embed a `cid` scoped to the request that
// produced them and 403 for anyone you send them to. The id alone rebuilds
// clean permalinks, so what Enter pastes stays shareable.
//
// What this costs, relative to providers/Giphy.js:
//
//   * One page, ~25 results. The page ignores ?page=, so parse() always
//     reports the results exhausted and the picker never scrolls for more.
//   * No rating or language controls — the page decides, and Giphy's own
//     default is roughly PG-13.
//   * It is scraped markup. A Giphy redesign breaks it, and the honest
//     symptom is "no results for everything" rather than a clean error.
//
// Deliberately self-contained, like the other modules: its few helpers are
// duplicated rather than shared.

var id = "giphy-keyless"

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// giphy.com routes searches at /search/<term>, with words joined by hyphens.
// Percent-encoded spaces 308-redirect to the hyphen form, and the search runs
// with `curl` without -L, so building the hyphen form directly is not a
// nicety — a redirect would arrive as an empty body.
// Only ASCII punctuation and control characters are dropped. Anything above
// U+007F is kept and left to encodeURIComponent, so "feliz cumpleaños" and
// "猫" reach Giphy percent-encoded and return results — a whitelist of
// [a-z0-9-] would quietly turn them into "feliz-cumpleaos" and "".
var UNSAFE = /[\u0000-\u002C\u002E\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007F]/g

function slug(term) {
  return trimmed(term)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")  // spaces and underscores are word breaks
    .replace(UNSAFE, "")      // keeps "-" (U+002D) and everything non-ASCII
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

// An empty term means "what's popular right now". /explore/trending renders
// the same 25-tile grid as a search; /trending-gifs renders only 10.
function searchUrl(key, settings, term, limit, cursor) {
  // There is no second page to ask for. startSearch() only passes a cursor
  // when parse() handed one back, and it never does, but a stray cursor
  // should end the scroll rather than re-fetch page one for ever.
  if (trimmed(cursor)) return ""
  var slugged = slug(term)
  if (!slugged) return "https://giphy.com/explore/trending"
  return "https://giphy.com/search/" + encodeURIComponent(slugged)
}

// Pull one attribute out of an opening tag. Values are HTML-escaped but the
// ones read here (ids, URLs, numbers, alt text) only ever carry &amp;.
function attr(tag, name) {
  var match = new RegExp("\\b" + name + "=\"([^\"]*)\"", "i").exec(tag)
  return match ? unescapeHtml(match[1]) : ""
}

// Alt text is where the titles come from, and Giphy escapes apostrophes there
// as numeric entities ("a baby&#x27;s face"), so the numeric forms matter as
// much as the named ones. `&amp;` is decoded last: doing it first would turn
// "&amp;#39;" into an apostrophe that was never there.
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

// The grid sets an inline `aspect-ratio: <width/height>` per tile. Previews are
// requested at a fixed 200px width, so that ratio is the only way to know how
// tall the tile should be before the image loads — without it the grid reflows
// as GIFs arrive.
var PREVIEW_WIDTH = 200

function dimensions(tag) {
  var match = /aspect-ratio:\s*([0-9]*\.?[0-9]+)/i.exec(attr(tag, "style"))
  var ratio = match ? parseFloat(match[1]) : NaN
  if (!(ratio > 0)) return { width: 0, height: 0 }
  return { width: PREVIEW_WIDTH, height: Math.round(PREVIEW_WIDTH / ratio) }
}

// Anchors are matched by the attribute that identifies them rather than by
// class name — the classes are build-hashed (`sc-qZruQ ducTeV`) and change on
// every deploy, while data-giphy-id is what the markup is *for*.
var ANCHOR = /<a\b([^>]*\bdata-giphy-id="[A-Za-z0-9]+"[^>]*)>([\s\S]*?)<\/a>/gi

function item(tag, inner) {
  var gifId = attr(tag, "data-giphy-id")
  if (!gifId) return null
  var dims = dimensions(tag)
  var altMatch = /\balt="([^"]*)"/i.exec(inner)
  return {
    id: gifId,
    title: altMatch ? unescapeHtml(altMatch[1]) : "",
    // A fixed-width rendition: ~9 KB against ~25 KB for the full GIF, which
    // matters when the grid loads two dozen of them at once.
    previewUrl: "https://i.giphy.com/media/" + gifId + "/200w.gif",
    gifUrl: "https://i.giphy.com/" + gifId + ".gif",
    // The href already is the canonical share link, slug and all. Falling back
    // to the bare /gifs/<id> form still resolves.
    pageUrl: attr(tag, "href") || "https://giphy.com/gifs/" + gifId,
    width: dims.width,
    height: dims.height
  }
}

function parse(raw, previousCursor) {
  var html = String(raw === undefined || raw === null ? "" : raw)

  var items = []
  var seen = {}
  var match
  ANCHOR.lastIndex = 0
  while ((match = ANCHOR.exec(html)) !== null) {
    var parsed = item(match[1], match[2])
    // The same GIF can be rendered twice on a page; the picker should show it
    // once.
    if (!parsed || seen[parsed.id]) continue
    seen[parsed.id] = true
    items.push(parsed)
  }

  // `next` is always "" — see the header. One page is all there is.
  if (items.length > 0) return { items: items, next: "", error: "" }

  // Nothing matched. A search that genuinely found nothing and a Giphy
  // redesign that moved the markup both land here and look alike, so say the
  // likely thing and name the other. Anything that isn't recognisably a Giphy
  // page is a third case — a captcha or an error page — and worth separating.
  if (!/giphy\.com/i.test(html))
    return { items: [], next: "",
             error: "Giphy returned something unreadable — it may be rate limiting this machine" }

  return { items: [], next: "",
           error: "No GIFs found. If every search says this, Giphy changed its page layout — "
                  + "switch to the Giphy provider with an API key" }
}

// The id is already the whole permalink; no query string to strip.
function shortDirectUrl(entry) {
  var gifId = trimmed(isObject(entry) ? entry.id : "")
  if (gifId) return "https://i.giphy.com/" + gifId + ".gif"
  return trimmed(isObject(entry) ? entry.gifUrl : "").split("?")[0]
}
